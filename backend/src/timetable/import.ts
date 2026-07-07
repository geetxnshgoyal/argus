import { appendAudit } from '../audit/audit.ts';
import type { AppContext } from '../context.ts';
import type { Tx } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../platform/ids.ts';
import { addDays, normTime, WEEKDAY_NAMES } from './dates.ts';
import { parseTimetableXlsx, type ParseIssue, type SubjectKind, type TimetableRow } from './import-parse.ts';
import {
  assertTermSection,
  defaultEffectiveFrom,
  findEntryConflicts,
  loadEntrySpecs,
  nameLookups,
  rematerialize,
  resolveTeacher,
  syncSectionEnrollments,
  type EntrySpec,
} from './service.ts';

/**
 * Timetable import (spec §8): the section's weekly timetable is replaced from
 * a spreadsheet, effective from a date. Everything runs in one transaction;
 * a dry run executes the same steps (including the database's double-booking
 * checks) and then rolls back, so the preview is exactly what would happen.
 */

export interface ImportInput {
  termId: string;
  sectionId: string;
  effectiveFrom?: string;
  xlsx?: Buffer;
  rows?: TimetableRow[];
}

export interface ImportReport {
  dry_run: boolean;
  effective_from: string;
  summary: { classes: number; new: number; unchanged: number; ended: number; sessions_scheduled: number; errors: number; warnings: number };
  create: { subjects: { code: string; kind: SubjectKind }[]; rooms: string[]; batches: string[]; offerings: string[] };
  issues: ParseIssue[];
  classes: { ref: string; day: string; start: string; end: string; subject: string; batch: string | null; room: string | null; status: 'new' | 'unchanged' }[];
  teacherless: string[];
}

class DryRunRollback extends Error {
  readonly report: ImportReport;
  constructor(report: ImportReport) {
    super('dry run');
    this.report = report;
  }
}

export async function importTimetable(ctx: AppContext, actorId: string, input: ImportInput, dryRun: boolean, ip: string): Promise<ImportReport> {
  try {
    return await ctx.db.transaction().execute(async (tx) => {
      const report = await runImport(tx, ctx, actorId, input, dryRun, ip);
      if (dryRun) throw new DryRunRollback(report);
      if (report.summary.errors > 0) {
        throw new ApiError(400, 'import_has_errors', 'Fix the problems listed, then import again.', { summary: report.summary });
      }
      return report;
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return err.report;
    throw err;
  }
}

async function runImport(tx: Tx, ctx: AppContext, actorId: string, input: ImportInput, dryRun: boolean, ip: string): Promise<ImportReport> {
  const { term, section } = await assertTermSection(tx, input.termId, input.sectionId);
  const effectiveFrom = input.effectiveFrom ?? defaultEffectiveFrom(ctx, term.start_date);
  if (effectiveFrom < term.start_date || effectiveFrom > term.end_date) {
    throw new ApiError(400, 'invalid_date', 'The start date must be within the term.');
  }

  const report: ImportReport = {
    dry_run: dryRun,
    effective_from: effectiveFrom,
    summary: { classes: 0, new: 0, unchanged: 0, ended: 0, sessions_scheduled: 0, errors: 0, warnings: 0 },
    create: { subjects: [], rooms: [], batches: [], offerings: [] },
    issues: [],
    classes: [],
    teacherless: [],
  };

  let rows = input.rows ?? [];
  if (input.xlsx) {
    const parsed = await parseTimetableXlsx(input.xlsx);
    rows = parsed.rows;
    report.issues.push(...parsed.issues);
  }
  report.summary.classes = rows.length;

  // ── Resolve or create subjects, rooms, batches, offerings ─────────────────
  const subjects = new Map((await tx.selectFrom('subjects').selectAll().execute()).map((s) => [s.code.toUpperCase(), s]));
  const rooms = new Map((await tx.selectFrom('rooms').selectAll().execute()).map((r) => [r.code.toLowerCase(), r]));
  const groups = new Map((await tx.selectFrom('section_groups').selectAll().where('section_id', '=', section.id).execute()).map((g) => [g.name.toLowerCase(), g]));
  const offerings = new Map(
    (await tx.selectFrom('course_offerings').selectAll().where('term_id', '=', term.id).where('section_id', '=', section.id).execute()).map((o) => [o.subject_id, o]),
  );
  const teacherByEmail = new Map(
    (await tx.selectFrom('users as u').innerJoin('teachers as t', 't.user_id', 'u.id').select(['u.id', 'u.email']).execute()).map((t) => [t.email.toLowerCase(), t.id]),
  );

  interface Planned {
    row: TimetableRow;
    offeringId: string;
    groupId: string | null;
    roomId: string | null;
    teacherId: string | null;
  }
  const planned: Planned[] = [];
  for (const row of rows) {
    const code = row.subjectCode.toUpperCase();
    let subject = subjects.get(code);
    if (!subject) {
      subject = { id: uuidv7(), code, name: code, kind: row.subjectKind, created_at: new Date(), updated_at: new Date() };
      await tx.insertInto('subjects').values({ id: subject.id, code, name: code, kind: row.subjectKind }).execute();
      subjects.set(code, subject);
      report.create.subjects.push({ code, kind: row.subjectKind });
    } else if (subject.kind !== row.subjectKind) {
      report.issues.push({ ref: row.ref, level: 'warning', message: `${code} is set up as a ${subject.kind}, but the sheet says ${row.subjectKind}.` });
    }

    let offering = offerings.get(subject.id);
    if (!offering) {
      offering = { id: uuidv7(), term_id: term.id, subject_id: subject.id, section_id: section.id, created_at: new Date(), updated_at: new Date() };
      await tx.insertInto('course_offerings').values({ id: offering.id, term_id: term.id, subject_id: subject.id, section_id: section.id }).execute();
      offerings.set(subject.id, offering);
      report.create.offerings.push(code);
    }

    let groupId: string | null = null;
    if (row.batch) {
      let g = groups.get(row.batch.toLowerCase());
      if (!g) {
        g = { id: uuidv7(), section_id: section.id, name: row.batch, created_at: new Date(), updated_at: new Date() };
        await tx.insertInto('section_groups').values({ id: g.id, section_id: section.id, name: row.batch }).execute();
        groups.set(row.batch.toLowerCase(), g);
        report.create.batches.push(row.batch);
      }
      groupId = g.id;
    }

    let roomId: string | null = null;
    const roomName = row.rooms[0];
    if (roomName) {
      let r = rooms.get(roomName.toLowerCase());
      if (!r) {
        r = { id: uuidv7(), code: roomName, building: '', floor: null, capacity: null, geofence_id: null, ble_rssi_threshold: null, created_at: new Date(), updated_at: new Date() };
        await tx.insertInto('rooms').values({ id: r.id, code: roomName }).execute();
        rooms.set(roomName.toLowerCase(), r);
        report.create.rooms.push(roomName);
      }
      roomId = r.id;
    }

    let teacherId: string | null = null;
    if (row.teacherEmail) {
      teacherId = teacherByEmail.get(row.teacherEmail.toLowerCase()) ?? null;
      if (!teacherId) report.issues.push({ ref: row.ref, level: 'error', message: `No teacher with email ${row.teacherEmail}. Add the teacher first.` });
    }
    planned.push({ row, offeringId: offering.id, groupId, roomId, teacherId });
  }

  // Same class listed twice in the file.
  const seen = new Map<string, string>();
  for (const p of planned) {
    const key = `${p.offeringId}|${p.groupId}|${p.row.weekday}|${p.row.start}`;
    const prev = seen.get(key);
    if (prev) report.issues.push({ ref: p.row.ref, level: 'error', message: `This class is listed twice (also at ${prev}).` });
    else seen.set(key, p.row.ref);
  }

  // ── Replace the section's weekly entries from effectiveFrom ───────────────
  const current = await tx
    .selectFrom('timetable_entries as e')
    .innerJoin('course_offerings as o', 'o.id', 'e.offering_id')
    .selectAll('e')
    .where('o.section_id', '=', section.id)
    .where('e.term_id', '=', term.id)
    .where((eb) => eb.or([eb('e.valid_to', 'is', null), eb('e.valid_to', '>=', effectiveFrom)]))
    .execute();
  const sig = (x: { offering_id: string; group_id: string | null; weekday: number; start_time: string; end_time: string; room_id: string | null; teacher_id: string | null }) =>
    [x.offering_id, x.group_id, x.weekday, normTime(x.start_time), normTime(x.end_time), x.room_id, x.teacher_id].join('|');
  const currentBySig = new Map(current.map((e) => [sig(e), e]));
  const keep = new Set<string>();

  for (const p of planned) {
    const s = sig({ offering_id: p.offeringId, group_id: p.groupId, weekday: p.row.weekday, start_time: p.row.start, end_time: p.row.end, room_id: p.roomId, teacher_id: p.teacherId });
    const existing = currentBySig.get(s);
    const roomName = p.row.rooms[0] ?? null;
    const cls = { ref: p.row.ref, day: WEEKDAY_NAMES[p.row.weekday - 1] as string, start: p.row.start, end: p.row.end, subject: p.row.subjectCode, batch: p.row.batch, room: roomName };
    if (existing && !keep.has(existing.id)) {
      keep.add(existing.id);
      report.summary.unchanged++;
      report.classes.push({ ...cls, status: 'unchanged' });
      continue;
    }
    await tx
      .insertInto('timetable_entries')
      .values({
        id: uuidv7(),
        term_id: term.id,
        offering_id: p.offeringId,
        group_id: p.groupId,
        weekday: p.row.weekday,
        start_time: p.row.start,
        end_time: p.row.end,
        room_id: p.roomId,
        teacher_id: p.teacherId,
        valid_from: effectiveFrom,
      })
      .execute();
    report.summary.new++;
    report.classes.push({ ...cls, status: 'new' });
  }

  // Entries not in the new file end the day before (history is kept); entries that
  // never took effect and have no sessions are removed.
  const dayBefore = addDays(effectiveFrom, -1);
  for (const e of current) {
    if (keep.has(e.id)) continue;
    const used = await tx.selectFrom('class_sessions').select('id').where('source_entry_id', '=', e.id).where('attendance_locked', '=', true).limit(1).executeTakeFirst();
    if ((e.valid_from ?? '0000-01-01') >= effectiveFrom && !used) {
      await tx.deleteFrom('class_sessions').where('source_entry_id', '=', e.id).execute();
      await tx.deleteFrom('timetable_entries').where('id', '=', e.id).execute();
    } else {
      await tx.updateTable('timetable_entries').set({ valid_to: dayBefore }).where('id', '=', e.id).execute();
    }
    report.summary.ended++;
  }

  // ── Double-booking checks: friendly first, then the database's own ─────────
  const specs = await loadEntrySpecs(tx, term.id, effectiveFrom);
  const refByKey = new Map(planned.map((p) => [`${p.offeringId}|${p.groupId}|${p.row.weekday}|${p.row.start}`, p.row.ref]));
  const withRefs: EntrySpec[] = specs.map((s) => ({ ...s, ref: refByKey.get(`${s.offeringId}|${s.groupId}|${s.weekday}|${s.start.slice(0, 5)}`) ?? s.label }));
  // Whole term: rooms and teachers are shared across sections.
  report.issues.push(...findEntryConflicts(withRefs, await nameLookups(tx)));

  const assignments = await tx.selectFrom('teaching_assignments').selectAll().where('offering_id', 'in', [...offerings.values()].map((o) => o.id).concat(['00000000-0000-0000-0000-000000000000'])).execute();
  const teacherless = new Set<string>();
  for (const p of planned) {
    if (!p.teacherId && !resolveTeacher(assignments, p.offeringId, p.groupId)) {
      teacherless.add(`${p.row.subjectCode}${p.row.batch ? ` (${p.row.batch})` : ''}`);
    }
  }
  report.teacherless = [...teacherless].sort();
  if (report.teacherless.length) {
    report.issues.push({
      ref: 'teachers',
      level: 'warning',
      message: `No teacher assigned yet for: ${report.teacherless.join(', ')}. Add them under Teaching assignments; until then nobody can start attendance for these classes.`,
    });
  }

  if (!report.issues.some((i) => i.level === 'error')) {
    try {
      const m = await rematerialize(tx, ctx, { termId: term.id, sectionId: section.id });
      report.summary.sessions_scheduled = m.created + m.updated;
      await syncSectionEnrollments(tx, section.id);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'double_booking') {
        report.issues.push({ ref: 'schedule', level: 'error', message: err.message });
      } else throw err;
    }
  }

  report.summary.errors = report.issues.filter((i) => i.level === 'error').length;
  report.summary.warnings = report.issues.filter((i) => i.level === 'warning').length;

  if (!dryRun && report.summary.errors === 0) {
    await appendAudit(
      tx,
      {
        actorId,
        action: 'timetable.import',
        entityType: 'section',
        entityId: section.id,
        after: { term_id: term.id, effective_from: effectiveFrom, summary: report.summary, created: report.create },
        ip,
      },
      new Date(ctx.now()),
    );
  }
  return report;
}
