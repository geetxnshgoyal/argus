import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { appendAudit } from '../audit/audit.ts';
import { currentUser, needAuth } from '../auth/guard.ts';
import type { AppContext } from '../context.ts';
import type { Tx } from '../db/index.ts';
import { mapDbError } from '../db/errors.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../platform/ids.ts';
import { fromB64url } from '../platform/crypto.ts';
import { idParams, isoDate, parse, uuid } from '../validation.ts';
import { addDays, normTime, WEEKDAY_NAMES } from './dates.ts';
import { importTimetable } from './import.ts';
import type { TimetableRow } from './import-parse.ts';
import {
  assertTermSection,
  describeEntry,
  expectedCount,
  findEntryConflicts,
  loadEntrySpecs,
  materializeAll,
  nameLookups,
  presentSession,
  rematerialize,
  sessionsView,
  syncSectionEnrollments,
  todayIn,
} from './service.ts';

const time = z.string().regex(/^\d{1,2}:\d{2}(:\d{2})?$/, 'Use HH:MM').transform((t, ctx) => {
  try {
    return normTime(t).slice(0, 5);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid time' });
    return z.NEVER;
  }
});

const entryInput = z
  .object({
    offering_id: uuid,
    group_id: uuid.nullable().optional(),
    weekday: z.number().int().min(1).max(7),
    start_time: time,
    end_time: time,
    room_id: uuid.nullable().optional(),
    teacher_id: uuid.nullable().optional(),
    valid_from: isoDate.nullable().optional(),
    valid_to: isoDate.nullable().optional(),
    note: z.string().max(300).nullable().optional(),
  })
  .refine((e) => e.end_time > e.start_time, { message: 'End must be after start', path: ['end_time'] });

const overrideInput = z
  .object({
    date: isoDate,
    action: z.enum(['cancel', 'modify', 'add']),
    entry_id: uuid.optional(),
    new_offering_id: uuid.optional(),
    new_group_id: uuid.nullable().optional(),
    new_room_id: uuid.nullable().optional(),
    new_teacher_id: uuid.nullable().optional(),
    new_start: time.optional(),
    new_end: time.optional(),
    reason: z.string().trim().min(3, 'Please give a reason').max(300),
    confirm: z.boolean().optional(),
  })
  .superRefine((o, c) => {
    if (o.action === 'add') {
      if (!o.new_offering_id) c.addIssue({ code: 'custom', message: 'Choose the subject', path: ['new_offering_id'] });
      if (!o.new_start || !o.new_end) c.addIssue({ code: 'custom', message: 'Start and end are required', path: ['new_start'] });
    } else if (!o.entry_id) c.addIssue({ code: 'custom', message: 'Choose the class', path: ['entry_id'] });
    if (o.new_start && o.new_end && o.new_end <= o.new_start) c.addIssue({ code: 'custom', message: 'End must be after start', path: ['new_end'] });
  });

const rangeQuery = z
  .object({ from: isoDate.optional(), to: isoDate.optional() })
  .refine((q) => !q.from || !q.to || q.to >= q.from, { message: 'to must be on or after from', path: ['to'] });

export function registerTimetableRoutes(app: FastifyInstance, ctx: AppContext): void {
  const admin = { preHandler: needAuth('acadops', 'admin') };
  const at = () => new Date(ctx.now());

  /** Checks a weekly entry against everything else in the term, in plain language. */
  async function checkEntry(tx: Tx, termId: string, entryId: string) {
    const specs = await loadEntrySpecs(tx, termId, todayIn(ctx));
    const issues = findEntryConflicts(specs, await nameLookups(tx), entryId);
    if (issues.length) throw new ApiError(409, 'double_booking', issues[0]!.message, { problems: issues.map((i) => i.message) });
  }

  // ── Weekly entries ─────────────────────────────────────────────────────────
  app.get('/v1/admin/timetable/entries', admin, async (req) => {
    const q = parse(z.object({ term_id: uuid, section_id: uuid.optional(), include_ended: z.enum(['true', 'false']).optional() }), req.query);
    let s = ctx.db
      .selectFrom('timetable_entries as e')
      .innerJoin('course_offerings as o', 'o.id', 'e.offering_id')
      .innerJoin('subjects as s', 's.id', 'o.subject_id')
      .leftJoin('section_groups as g', 'g.id', 'e.group_id')
      .leftJoin('rooms as r', 'r.id', 'e.room_id')
      .leftJoin('users as t', 't.id', 'e.teacher_id')
      .select([
        'e.id', 'e.term_id', 'e.offering_id', 'o.section_id', 'e.group_id', 'e.weekday', 'e.room_id', 'e.teacher_id', 'e.valid_from', 'e.valid_to', 'e.note',
        sql<string>`to_char(e.start_time, 'HH24:MI')`.as('start_time'),
        sql<string>`to_char(e.end_time, 'HH24:MI')`.as('end_time'),
        's.code as subject_code', 's.name as subject_name', 's.kind as subject_kind', 'g.name as group_name', 'r.code as room', 't.name as teacher_name',
      ])
      .where('e.term_id', '=', q.term_id)
      .orderBy('e.weekday')
      .orderBy('e.start_time');
    if (q.section_id) s = s.where('o.section_id', '=', q.section_id);
    if (q.include_ended !== 'true') s = s.where((eb) => eb.or([eb('e.valid_to', 'is', null), eb('e.valid_to', '>=', todayIn(ctx))]));
    return { items: await s.execute() };
  });

  app.post('/v1/admin/timetable/entries', admin, async (req, reply) => {
    const u = currentUser(req);
    const b = parse(entryInput, req.body);
    try {
      const created = await ctx.db.transaction().execute(async (tx) => {
        const off = await tx.selectFrom('course_offerings').selectAll().where('id', '=', b.offering_id).executeTakeFirst();
        if (!off) throw new ApiError(400, 'invalid_reference', 'Subject offering not found.');
        await assertGroup(tx, b.group_id ?? null, off.section_id);
        const row = {
          id: uuidv7(ctx.now()),
          term_id: off.term_id,
          offering_id: b.offering_id,
          group_id: b.group_id ?? null,
          weekday: b.weekday,
          start_time: b.start_time,
          end_time: b.end_time,
          room_id: b.room_id ?? null,
          teacher_id: b.teacher_id ?? null,
          valid_from: b.valid_from ?? null,
          valid_to: b.valid_to ?? null,
          note: b.note ?? null,
        };
        await tx.insertInto('timetable_entries').values(row).execute();
        await checkEntry(tx, off.term_id, row.id);
        await rematerialize(tx, ctx, { termId: off.term_id, sectionId: off.section_id });
        await appendAudit(tx, { actorId: u.id, action: 'timetable_entry.create', entityType: 'timetable_entry', entityId: row.id, after: row, ip: req.ip }, at());
        return row;
      });
      return reply.status(201).send(created);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      mapDbError(err, 'create');
    }
  });

  app.patch('/v1/admin/timetable/entries/:id', admin, async (req) => {
    const u = currentUser(req);
    const { id } = parse(idParams, req.params);
    const patch = parse(
      z.object({
        group_id: uuid.nullable(),
        weekday: z.number().int().min(1).max(7),
        start_time: time,
        end_time: time,
        room_id: uuid.nullable(),
        teacher_id: uuid.nullable(),
        valid_from: isoDate.nullable(),
        valid_to: isoDate.nullable(),
        note: z.string().max(300).nullable(),
      }).partial(),
      req.body,
    );
    try {
      return await ctx.db.transaction().execute(async (tx) => {
        const before = await tx.selectFrom('timetable_entries as e').innerJoin('course_offerings as o', 'o.id', 'e.offering_id').selectAll('e').select('o.section_id').where('e.id', '=', id).forUpdate().executeTakeFirst();
        if (!before) throw new ApiError(404, 'not_found', 'Not found');
        if (patch.group_id !== undefined) await assertGroup(tx, patch.group_id, before.section_id);
        const start = patch.start_time ?? before.start_time.slice(0, 5);
        const end = patch.end_time ?? before.end_time.slice(0, 5);
        if (end <= start) throw new ApiError(400, 'validation_failed', 'End must be after start.', { fields: { end_time: 'End must be after start' } });
        const after = await tx.updateTable('timetable_entries').set({ ...patch, version: sql`version + 1` }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
        await checkEntry(tx, before.term_id, id);
        const m = await rematerialize(tx, ctx, { termId: before.term_id, sectionId: before.section_id });
        const { section_id: _s, ...beforeRow } = before;
        await appendAudit(tx, { actorId: u.id, action: 'timetable_entry.update', entityType: 'timetable_entry', entityId: id, before: beforeRow, after, ip: req.ip }, at());
        return { ...after, skipped_locked: m.skippedLocked };
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      mapDbError(err, 'update');
    }
  });

  app.delete('/v1/admin/timetable/entries/:id', admin, async (req, reply) => {
    const u = currentUser(req);
    const { id } = parse(idParams, req.params);
    await ctx.db.transaction().execute(async (tx) => {
      const before = await tx.selectFrom('timetable_entries as e').innerJoin('course_offerings as o', 'o.id', 'e.offering_id').selectAll('e').select('o.section_id').where('e.id', '=', id).executeTakeFirst();
      if (!before) throw new ApiError(404, 'not_found', 'Not found');
      // End the class from today; history (and any attendance) stays.
      const yesterday = addDays(todayIn(ctx), -1);
      const hasHistory = await tx.selectFrom('class_sessions').select('id').where('source_entry_id', '=', id).where('date', '<=', yesterday).limit(1).executeTakeFirst();
      await tx.updateTable('timetable_overrides').set({ revoked_at: at(), revoked_by: u.id }).where('entry_id', '=', id).where('date', '>', yesterday).where('revoked_at', 'is', null).execute();
      if (hasHistory) {
        await tx.updateTable('timetable_entries').set({ valid_to: yesterday }).where('id', '=', id).execute();
      } else {
        await tx.updateTable('timetable_entries').set({ valid_to: yesterday, valid_from: yesterday }).where('id', '=', id).execute();
      }
      await rematerialize(tx, ctx, { termId: before.term_id, sectionId: before.section_id });
      const { section_id: _s, ...beforeRow } = before;
      await appendAudit(tx, { actorId: u.id, action: 'timetable_entry.end', entityType: 'timetable_entry', entityId: id, before: beforeRow, after: { valid_to: yesterday }, ip: req.ip }, at());
    });
    return reply.status(204).send();
  });

  // ── One-day overrides ─────────────────────────────────────────────────────
  app.get('/v1/admin/timetable/overrides', admin, async (req) => {
    const q = parse(z.object({ term_id: uuid, from: isoDate.optional(), to: isoDate.optional(), include_revoked: z.enum(['true', 'false']).optional() }), req.query);
    let s = ctx.db
      .selectFrom('timetable_overrides as ov')
      .leftJoin('timetable_entries as e', 'e.id', 'ov.entry_id')
      .leftJoin('course_offerings as o', (j) => j.on((eb) => eb.or([eb('o.id', '=', eb.ref('e.offering_id')), eb('o.id', '=', eb.ref('ov.new_offering_id'))])))
      .leftJoin('subjects as s', 's.id', 'o.subject_id')
      .leftJoin('sections as sec', 'sec.id', 'o.section_id')
      .leftJoin('users as cb', 'cb.id', 'ov.created_by')
      .select([
        'ov.id', 'ov.date', 'ov.action', 'ov.entry_id', 'ov.new_room_id', 'ov.new_teacher_id', 'ov.new_group_id', 'ov.new_offering_id', 'ov.reason',
        'ov.applies_to_locked', 'ov.created_at', 'ov.revoked_at', 's.code as subject_code', 'sec.name as section_name', 'sec.id as section_id', 'cb.name as created_by_name',
        sql<string | null>`to_char(ov.new_start, 'HH24:MI')`.as('new_start'),
        sql<string | null>`to_char(ov.new_end, 'HH24:MI')`.as('new_end'),
      ])
      .where('ov.term_id', '=', q.term_id)
      .orderBy('ov.date', 'desc');
    if (q.from) s = s.where('ov.date', '>=', q.from);
    if (q.to) s = s.where('ov.date', '<=', q.to);
    if (q.include_revoked !== 'true') s = s.where('ov.revoked_at', 'is', null);
    return { items: await s.execute() };
  });

  app.post('/v1/admin/timetable/overrides', admin, async (req, reply) => {
    const u = currentUser(req);
    const b = parse(overrideInput, req.body);
    if (b.date < todayIn(ctx)) throw new ApiError(400, 'past_date', 'Changes can only be made for today or later. Use attendance corrections for past classes.');
    try {
      const created = await ctx.db.transaction().execute(async (tx) => {
        let termId: string;
        let sectionId: string;
        if (b.action === 'add') {
          const off = await tx.selectFrom('course_offerings').selectAll().where('id', '=', b.new_offering_id!).executeTakeFirst();
          if (!off) throw new ApiError(400, 'invalid_reference', 'Subject offering not found.');
          termId = off.term_id;
          sectionId = off.section_id;
          await assertGroup(tx, b.new_group_id ?? null, off.section_id);
        } else {
          const e = await tx.selectFrom('timetable_entries as e').innerJoin('course_offerings as o', 'o.id', 'e.offering_id').select(['e.term_id', 'o.section_id']).where('e.id', '=', b.entry_id!).executeTakeFirst();
          if (!e) throw new ApiError(400, 'invalid_reference', 'Class not found.');
          termId = e.term_id;
          sectionId = e.section_id;
          // Spec §8: changing a class that already has attendance needs confirmation.
          const locked = await tx.selectFrom('class_sessions').select('id').where('source_entry_id', '=', b.entry_id!).where('date', '=', b.date).where('attendance_locked', '=', true).executeTakeFirst();
          if (locked && !b.confirm) {
            throw new ApiError(409, 'session_has_attendance', 'This class already has attendance. Confirm to change it anyway (the change will be audited).', { class_session_id: locked.id });
          }
        }
        const term = await tx.selectFrom('terms').select(['start_date', 'end_date']).where('id', '=', termId).executeTakeFirstOrThrow();
        if (b.date < term.start_date || b.date > term.end_date) throw new ApiError(400, 'invalid_date', 'The date is outside the term.');
        // Replace an earlier active change for the same class and date.
        if (b.entry_id) {
          await tx.updateTable('timetable_overrides').set({ revoked_at: at(), revoked_by: u.id }).where('entry_id', '=', b.entry_id).where('date', '=', b.date).where('revoked_at', 'is', null).execute();
        }
        const row = {
          id: uuidv7(ctx.now()),
          term_id: termId,
          date: b.date,
          entry_id: b.action === 'add' ? null : (b.entry_id ?? null),
          action: b.action,
          new_offering_id: b.action === 'add' ? (b.new_offering_id ?? null) : null,
          new_group_id: b.new_group_id ?? null,
          new_room_id: b.new_room_id ?? null,
          new_teacher_id: b.new_teacher_id ?? null,
          new_start: b.new_start ?? null,
          new_end: b.new_end ?? null,
          reason: b.reason,
          applies_to_locked: Boolean(b.confirm),
          created_by: u.id,
        };
        await tx.insertInto('timetable_overrides').values(row).execute();
        await rematerialize(tx, ctx, { termId, sectionId });
        await appendAudit(tx, { actorId: u.id, action: `timetable_override.${b.action}`, entityType: 'timetable_override', entityId: row.id, after: row, ip: req.ip }, at());
        return row;
      });
      return reply.status(201).send(created);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      mapDbError(err, 'create');
    }
  });

  app.delete('/v1/admin/timetable/overrides/:id', admin, async (req, reply) => {
    const u = currentUser(req);
    const { id } = parse(idParams, req.params);
    await ctx.db.transaction().execute(async (tx) => {
      const ov = await tx.updateTable('timetable_overrides').set({ revoked_at: at(), revoked_by: u.id }).where('id', '=', id).where('revoked_at', 'is', null).returningAll().executeTakeFirst();
      if (!ov) throw new ApiError(404, 'not_found', 'Not found');
      if (ov.date < todayIn(ctx)) throw new ApiError(400, 'past_date', 'Past changes cannot be undone.');
      await rematerialize(tx, ctx, { termId: ov.term_id });
      await appendAudit(tx, { actorId: u.id, action: 'timetable_override.revoke', entityType: 'timetable_override', entityId: id, before: ov, ip: req.ip }, at());
    });
    return reply.status(204).send();
  });

  // ── Term calendar ─────────────────────────────────────────────────────────
  app.get('/v1/admin/timetable/calendar', admin, async (req) => {
    const q = parse(z.object({ term_id: uuid }), req.query);
    return { items: await ctx.db.selectFrom('term_calendar_days').selectAll().where('term_id', '=', q.term_id).orderBy('date').execute() };
  });

  app.put('/v1/admin/timetable/calendar/:term_id/:date', admin, async (req) => {
    const u = currentUser(req);
    const p = parse(z.object({ term_id: uuid, date: isoDate }), req.params);
    const b = parse(
      z.object({ kind: z.enum(['holiday', 'exam', 'no_classes', 'working']), follows_weekday: z.number().int().min(1).max(7).nullable().optional(), note: z.string().max(200).optional() })
        .refine((d) => d.kind === 'working' || !d.follows_weekday, { message: 'Only working days can follow another weekday', path: ['follows_weekday'] }),
      req.body,
    );
    return ctx.db.transaction().execute(async (tx) => {
      const term = await tx.selectFrom('terms').selectAll().where('id', '=', p.term_id).executeTakeFirst();
      if (!term) throw new ApiError(404, 'not_found', 'Term not found');
      if (p.date < term.start_date || p.date > term.end_date) throw new ApiError(400, 'invalid_date', 'The date is outside the term.');
      const row = { term_id: p.term_id, date: p.date, kind: b.kind, follows_weekday: b.follows_weekday ?? null, note: b.note ?? '' };
      const saved = await tx
        .insertInto('term_calendar_days')
        .values(row)
        .onConflict((oc) => oc.columns(['term_id', 'date']).doUpdateSet({ kind: row.kind, follows_weekday: row.follows_weekday, note: row.note }))
        .returningAll()
        .executeTakeFirstOrThrow();
      await rematerialize(tx, ctx, { termId: p.term_id });
      await appendAudit(tx, { actorId: u.id, action: 'calendar_day.set', entityType: 'term', entityId: p.term_id, after: saved, ip: req.ip }, at());
      return saved;
    });
  });

  app.delete('/v1/admin/timetable/calendar/:term_id/:date', admin, async (req, reply) => {
    const u = currentUser(req);
    const p = parse(z.object({ term_id: uuid, date: isoDate }), req.params);
    await ctx.db.transaction().execute(async (tx) => {
      const gone = await tx.deleteFrom('term_calendar_days').where('term_id', '=', p.term_id).where('date', '=', p.date).returningAll().executeTakeFirst();
      if (!gone) throw new ApiError(404, 'not_found', 'Not found');
      await rematerialize(tx, ctx, { termId: p.term_id });
      await appendAudit(tx, { actorId: u.id, action: 'calendar_day.remove', entityType: 'term', entityId: p.term_id, before: gone, ip: req.ip }, at());
    });
    return reply.status(204).send();
  });

  // ── Import ────────────────────────────────────────────────────────────────
  const importRow = z.object({
    ref: z.string().max(60).optional(),
    day: z.number().int().min(1).max(7),
    start: time,
    end: time,
    subject_code: z.string().trim().min(1).max(40),
    subject_kind: z.enum(['lecture', 'lab', 'tutorial']).default('lecture'),
    batch: z.string().trim().max(60).nullable().optional(),
    room: z.string().trim().max(60).nullable().optional(),
    teacher_email: z.string().trim().email().nullable().optional(),
  });
  app.post('/v1/admin/timetable/import', { ...admin, bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const u = currentUser(req);
    const dryRun = (req.query as { dry_run?: string }).dry_run !== 'false';
    const b = parse(
      z.object({ term_id: uuid, section_id: uuid, effective_from: isoDate.optional(), xlsx_base64: z.string().max(8_000_000).optional(), rows: z.array(importRow).max(2000).optional() })
        .refine((x) => Boolean(x.xlsx_base64) !== Boolean(x.rows), { message: 'Send either a spreadsheet or rows', path: ['xlsx_base64'] }),
      req.body,
    );
    let xlsx: Buffer | undefined;
    if (b.xlsx_base64) {
      try {
        xlsx = b.xlsx_base64.includes('+') || b.xlsx_base64.includes('/') ? Buffer.from(b.xlsx_base64, 'base64') : fromB64url(b.xlsx_base64);
      } catch {
        throw new ApiError(400, 'validation_failed', 'The file could not be read.');
      }
    }
    const rows: TimetableRow[] | undefined = b.rows?.map((r, i) => ({
      ref: r.ref ?? `Row ${i + 1}`,
      weekday: r.day,
      start: r.start,
      end: r.end,
      subjectCode: r.subject_code.toUpperCase(),
      subjectKind: r.subject_kind,
      batch: r.batch || null,
      rooms: r.room ? [r.room] : [],
      teacherEmail: r.teacher_email ?? null,
      text: `${r.subject_code} ${r.room ?? ''}`.trim(),
    }));
    return importTimetable(ctx, u.id, { termId: b.term_id, sectionId: b.section_id, ...(b.effective_from ? { effectiveFrom: b.effective_from } : {}), ...(xlsx ? { xlsx } : {}), ...(rows ? { rows } : {}) }, dryRun, req.ip);
  });

  // ── Conflicts and warnings ────────────────────────────────────────────────
  app.get('/v1/admin/conflicts', admin, async (req) => {
    const q = parse(z.object({ term_id: uuid }), req.query);
    const today = todayIn(ctx);
    const specs = await loadEntrySpecs(ctx.db, q.term_id, today);
    const names = await nameLookups(ctx.db);
    const conflicts = findEntryConflicts(specs, names).map((i) => ({ kind: 'conflict' as const, message: i.message }));
    const warnings: { kind: 'warning'; message: string }[] = [];
    const noTeacher = new Set(specs.filter((s) => !s.teacherId).map((s) => s.label));
    for (const l of [...noTeacher].sort()) warnings.push({ kind: 'warning', message: `No teacher assigned for ${l}. Nobody can start attendance for it.` });
    for (const s of specs.filter((x) => !x.roomId)) warnings.push({ kind: 'warning', message: `No room set for ${describeEntry(s)}.` });
    // Near-conflicts: the same teacher in back-to-back classes in different rooms with no gap.
    for (const a of specs) {
      for (const b of specs) {
        if (a === b || !a.teacherId || a.teacherId !== b.teacherId || a.weekday !== b.weekday) continue;
        if (a.end === b.start && a.roomId && b.roomId && a.roomId !== b.roomId) {
          warnings.push({ kind: 'warning', message: `${names.teacher(a.teacherId)} goes straight from ${names.room(a.roomId)} to ${names.room(b.roomId)} on ${WEEKDAY_NAMES[a.weekday - 1]} at ${a.end.slice(0, 5)}.` });
        }
      }
    }
    const capacity = await sql<{ room: string; capacity: number; students: number; section: string }>`
      select r.code as room, r.capacity, sec.name as section, count(distinct st.user_id)::int as students
      from timetable_entries e
      join course_offerings o on o.id = e.offering_id
      join sections sec on sec.id = o.section_id
      join rooms r on r.id = e.room_id
      join students st on st.section_id = o.section_id and (e.group_id is null or st.group_id = e.group_id)
      join users u on u.id = st.user_id and u.status = 'active'
      where e.term_id = ${q.term_id} and r.capacity is not null and (e.valid_to is null or e.valid_to >= ${today})
      group by r.code, r.capacity, sec.name, e.id
      having count(distinct st.user_id) > r.capacity`.execute(ctx.db);
    for (const c of capacity.rows) warnings.push({ kind: 'warning', message: `${c.room} holds ${c.capacity}, but ${c.students} students of ${c.section} are scheduled there.` });
    return { conflicts, warnings: [...new Map(warnings.map((w) => [w.message, w])).values()] };
  });

  // ── Sessions (materialized) ───────────────────────────────────────────────
  app.get('/v1/admin/class-sessions', admin, async (req) => {
    const q = parse(z.object({ section_id: uuid.optional(), room_id: uuid.optional(), teacher_id: uuid.optional(), from: isoDate, to: isoDate }), req.query);
    if (q.to < q.from || q.to > addDays(q.from, 31)) throw new ApiError(400, 'validation_failed', 'Choose a range of at most 31 days.');
    let s = sessionsView(ctx.db, ctx.config.timeZone).where('cs.date', '>=', q.from).where('cs.date', '<=', q.to);
    if (q.section_id) s = s.where('o.section_id', '=', q.section_id);
    if (q.room_id) s = s.where('cs.room_id', '=', q.room_id);
    if (q.teacher_id) s = s.where('cs.teacher_id', '=', q.teacher_id);
    return { items: (await s.execute()).map(presentSession) };
  });

  app.post('/v1/admin/timetable/materialize', admin, async (req) => {
    const u = currentUser(req);
    const r = await materializeAll(ctx);
    await ctx.db.transaction().execute((tx) => appendAudit(tx, { actorId: u.id, action: 'timetable.materialize', entityType: 'timetable', after: r, ip: req.ip }, at()));
    return r;
  });

  app.post('/v1/admin/sections/:id/sync-enrollments', admin, async (req) => {
    const u = currentUser(req);
    const { id } = parse(idParams, req.params);
    return ctx.db.transaction().execute(async (tx) => {
      const r = await syncSectionEnrollments(tx, id);
      await appendAudit(tx, { actorId: u.id, action: 'enrollments.sync', entityType: 'section', entityId: id, after: r, ip: req.ip }, at());
      return r;
    });
  });

  // ── Teacher views ─────────────────────────────────────────────────────────
  app.get('/v1/teacher/sessions/today', { preHandler: needAuth('teacher') }, async (req) => {
    const u = currentUser(req);
    const today = todayIn(ctx);
    const rows = await sessionsView(ctx.db, ctx.config.timeZone).where('cs.teacher_id', '=', u.id).where('cs.date', '=', today).execute();
    const items = [];
    for (const r of rows) items.push({ ...presentSession(r), expected: await expectedCount(ctx.db, r.id) });
    return { date: today, items };
  });

  app.get('/v1/teacher/timetable', { preHandler: needAuth('teacher') }, async (req) => {
    const u = currentUser(req);
    const { from, to } = rangeOf(req, ctx);
    const rows = await sessionsView(ctx.db, ctx.config.timeZone).where('cs.teacher_id', '=', u.id).where('cs.date', '>=', from).where('cs.date', '<=', to).execute();
    return { from, to, items: rows.map(presentSession) };
  });

  app.get('/v1/teacher/class-sessions/:id', { preHandler: needAuth('teacher') }, async (req) => {
    const u = currentUser(req);
    const { id } = parse(idParams, req.params);
    const r = await sessionsView(ctx.db, ctx.config.timeZone).where('cs.id', '=', id).executeTakeFirst();
    if (!r || r.teacher_id !== u.id) throw new ApiError(404, 'not_found', 'Class not found');
    return { ...presentSession(r), expected: await expectedCount(ctx.db, r.id) };
  });

  // ── Student view ──────────────────────────────────────────────────────────
  app.get('/v1/me/timetable', { preHandler: needAuth('student') }, async (req) => {
    const u = currentUser(req);
    const { from, to } = rangeOf(req, ctx);
    const rows = await sessionsView(ctx.db, ctx.config.timeZone)
      .innerJoin('enrollments as en', (j) => j.onRef('en.offering_id', '=', 'cs.offering_id').on('en.student_id', '=', u.id))
      .where((eb) => eb.or([eb('cs.group_id', 'is', null), eb('cs.group_id', '=', eb.ref('en.group_id'))]))
      .where('cs.date', '>=', from)
      .where('cs.date', '<=', to)
      .execute();
    return { from, to, items: rows.map(presentSession) };
  });
}

function rangeOf(req: FastifyRequest, ctx: AppContext): { from: string; to: string } {
  const q = parse(rangeQuery, req.query);
  const from = q.from ?? todayIn(ctx);
  const to = q.to ?? addDays(from, 6);
  if (to > addDays(from, 31)) throw new ApiError(400, 'validation_failed', 'Choose a range of at most 31 days.');
  return { from, to };
}

async function assertGroup(tx: Tx, groupId: string | null, sectionId: string) {
  if (!groupId) return;
  const g = await tx.selectFrom('section_groups').select('section_id').where('id', '=', groupId).executeTakeFirst();
  if (!g || g.section_id !== sectionId) throw new ApiError(400, 'invalid_group', 'The batch must belong to the same section.');
}

export { assertTermSection };
