import { sql } from 'kysely';
import type { Tx } from '../db/index.ts';
import { uuidv7 } from '../platform/ids.ts';
import { eachDate, isoWeekday, maxDate, minDate } from './dates.ts';
import { resolveTeacher } from './teachers.ts';

/**
 * Turns the weekly timetable into dated class sessions (spec §8, ADR-0012).
 *
 * Resolution for each date: term calendar (holiday / "follows weekday")
 * → weekly entries valid on that date → date overrides (override wins).
 *
 * Sessions that already have attendance (`attendance_locked`) are never
 * rewritten or removed unless the override causing the change was confirmed
 * for that (`applies_to_locked`). Must run inside a transaction: the
 * double-booking constraints are deferred to commit so swaps work, and a
 * conflict aborts the whole change.
 */

export interface MaterializeScope {
  from: string;
  to: string;
  termId?: string;
  sectionId?: string;
}

export interface LockedSkip {
  sessionId: string;
  date: string;
  reason: string;
}

export interface MaterializeResult {
  created: number;
  updated: number;
  removed: number;
  skippedLocked: LockedSkip[];
}

interface Desired {
  key: string;
  entryId: string | null;
  overrideId: string | null;
  termId: string;
  offeringId: string;
  sectionId: string;
  groupId: string | null;
  date: string;
  start: string;
  end: string;
  roomId: string | null;
  teacherId: string | null;
  status: 'scheduled' | 'cancelled';
  forced: boolean;
}

export async function materialize(tx: Tx, scope: MaterializeScope, timeZone: string): Promise<MaterializeResult> {
  await sql`set constraints class_sessions_room_overlap, class_sessions_teacher_overlap, class_session_audience_overlap deferred`.execute(tx);
  const result: MaterializeResult = { created: 0, updated: 0, removed: 0, skippedLocked: [] };

  let termQ = tx.selectFrom('terms').selectAll().where('start_date', '<=', scope.to).where('end_date', '>=', scope.from);
  if (scope.termId) termQ = termQ.where('id', '=', scope.termId);
  const terms = await termQ.execute();

  for (const term of terms) {
    const from = maxDate(scope.from, term.start_date);
    const to = minDate(scope.to, term.end_date);
    if (from > to) continue;

    let entryQ = tx
      .selectFrom('timetable_entries as e')
      .innerJoin('course_offerings as o', 'o.id', 'e.offering_id')
      .selectAll('e')
      .select('o.section_id')
      .where('e.term_id', '=', term.id);
    if (scope.sectionId) entryQ = entryQ.where('o.section_id', '=', scope.sectionId);
    const entries = await entryQ.execute();

    const overrides = await tx
      .selectFrom('timetable_overrides as ov')
      .leftJoin('course_offerings as o', 'o.id', 'ov.new_offering_id')
      .selectAll('ov')
      .select('o.section_id as add_section_id')
      .where('ov.term_id', '=', term.id)
      .where('ov.revoked_at', 'is', null)
      .where('ov.date', '>=', from)
      .where('ov.date', '<=', to)
      .execute();

    const calendar = new Map(
      (await tx.selectFrom('term_calendar_days').selectAll().where('term_id', '=', term.id).where('date', '>=', from).where('date', '<=', to).execute()).map(
        (c) => [c.date, c],
      ),
    );

    const offeringIds = [...new Set([...entries.map((e) => e.offering_id), ...overrides.map((o) => o.new_offering_id).filter((x): x is string => Boolean(x))])];
    const assignments = offeringIds.length
      ? await tx.selectFrom('teaching_assignments').selectAll().where('offering_id', 'in', offeringIds).execute()
      : [];
    const offerings = offeringIds.length ? await tx.selectFrom('course_offerings').select(['id', 'section_id']).where('id', 'in', offeringIds).execute() : [];
    const sectionOfOffering = new Map(offerings.map((o) => [o.id, o.section_id]));

    /**
     * Teacher: explicit on the entry/override, else the batch's assigned teacher, else the
     * section-wide assignment. Never another batch's teacher.
     */
    const teacherFor = (offeringId: string, groupId: string | null): string | null => resolveTeacher(assignments, offeringId, groupId);

    // ── Desired sessions ──────────────────────────────────────────────────
    const desired = new Map<string, Desired>();
    for (const date of eachDate(from, to)) {
      const cal = calendar.get(date);
      const noClasses = cal !== undefined && cal.kind !== 'working';
      const weekday = cal?.follows_weekday ?? isoWeekday(date);
      if (!noClasses) {
        for (const e of entries) {
          if (e.weekday !== weekday) continue;
          if (e.valid_from && e.valid_from > date) continue;
          if (e.valid_to && e.valid_to < date) continue;
          const ov = overrides.find((o) => o.entry_id === e.id && o.date === date);
          const base: Desired = {
            key: `e:${e.id}:${date}`,
            entryId: e.id,
            overrideId: ov?.id ?? null,
            termId: term.id,
            offeringId: e.offering_id,
            sectionId: e.section_id,
            groupId: e.group_id,
            date,
            start: e.start_time,
            end: e.end_time,
            roomId: e.room_id,
            teacherId: e.teacher_id ?? teacherFor(e.offering_id, e.group_id),
            status: 'scheduled',
            forced: ov?.applies_to_locked ?? false,
          };
          if (ov?.action === 'cancel') base.status = 'cancelled';
          if (ov?.action === 'modify') {
            base.roomId = ov.new_room_id ?? base.roomId;
            base.teacherId = ov.new_teacher_id ?? base.teacherId;
            base.start = ov.new_start ?? base.start;
            base.end = ov.new_end ?? base.end;
          }
          desired.set(base.key, base);
        }
      }
      for (const ov of overrides) {
        if (ov.action !== 'add' || ov.date !== date || !ov.new_offering_id) continue;
        const sectionId = ov.add_section_id ?? sectionOfOffering.get(ov.new_offering_id) ?? '';
        if (scope.sectionId && sectionId !== scope.sectionId) continue;
        desired.set(`a:${ov.id}`, {
          key: `a:${ov.id}`,
          entryId: null,
          overrideId: ov.id,
          termId: term.id,
          offeringId: ov.new_offering_id,
          sectionId,
          groupId: ov.new_group_id,
          date,
          start: ov.new_start as string,
          end: ov.new_end as string,
          roomId: ov.new_room_id,
          teacherId: ov.new_teacher_id ?? teacherFor(ov.new_offering_id, ov.new_group_id),
          status: 'scheduled',
          forced: ov.applies_to_locked,
        });
      }
    }

    // ── Existing sessions in scope ────────────────────────────────────────
    let existingQ = tx
      .selectFrom('class_sessions as cs')
      .innerJoin('course_offerings as o', 'o.id', 'cs.offering_id')
      .selectAll('cs')
      .select([
        sql<string>`to_char(lower(cs.time_range) at time zone ${timeZone}, 'HH24:MI:SS')`.as('start_local'),
        sql<string>`to_char(upper(cs.time_range) at time zone ${timeZone}, 'HH24:MI:SS')`.as('end_local'),
      ])
      .where('cs.term_id', '=', term.id)
      .where('cs.date', '>=', from)
      .where('cs.date', '<=', to);
    if (scope.sectionId) existingQ = existingQ.where('o.section_id', '=', scope.sectionId);
    const existing = await existingQ.execute();
    const existingByKey = new Map(existing.map((s) => [s.source_entry_id ? `e:${s.source_entry_id}:${s.date}` : `a:${s.source_override_id}`, s]));

    const groupsBySection = new Map<string, string[]>();
    const audienceFor = async (d: Desired): Promise<string[]> => {
      if (d.groupId) return [d.groupId];
      if (!groupsBySection.has(d.sectionId)) {
        const gs = await tx.selectFrom('section_groups').select('id').where('section_id', '=', d.sectionId).execute();
        groupsBySection.set(d.sectionId, gs.map((g) => g.id));
      }
      // Whole-section class: occupies every batch plus the section itself.
      return [d.sectionId, ...(groupsBySection.get(d.sectionId) ?? [])];
    };

    const range = (d: Desired) =>
      sql<string>`tstzrange((${d.date}::date + ${d.start}::time) at time zone ${timeZone}, (${d.date}::date + ${d.end}::time) at time zone ${timeZone}, '[)')`;

    const writeAudiences = async (sessionId: string, d: Desired) => {
      await tx.deleteFrom('class_session_audiences').where('class_session_id', '=', sessionId).execute();
      if (d.status === 'cancelled') return;
      const ids = await audienceFor(d);
      await sql`
        insert into class_session_audiences (class_session_id, audience_id, time_range)
        select cs.id, a, cs.time_range from class_sessions cs, unnest(${ids}::uuid[]) as a where cs.id = ${sessionId}`.execute(tx);
    };

    for (const d of desired.values()) {
      const s = existingByKey.get(d.key);
      if (!s) {
        const id = uuidv7();
        await tx
          .insertInto('class_sessions')
          .values({
            id,
            term_id: d.termId,
            offering_id: d.offeringId,
            group_id: d.groupId,
            date: d.date,
            time_range: range(d),
            room_id: d.roomId,
            teacher_id: d.teacherId,
            source_entry_id: d.entryId,
            source_override_id: d.overrideId,
            status: d.status,
          })
          .execute();
        await writeAudiences(id, d);
        result.created++;
        continue;
      }
      existingByKey.delete(d.key);
      const nextStatus = s.status === 'scheduled' || s.status === 'cancelled' ? d.status : s.status;
      const changed =
        s.offering_id !== d.offeringId ||
        s.group_id !== d.groupId ||
        s.room_id !== d.roomId ||
        s.teacher_id !== d.teacherId ||
        s.status !== nextStatus ||
        s.start_local !== d.start ||
        s.end_local !== d.end ||
        s.source_override_id !== d.overrideId;
      if (!changed) continue;
      if (s.attendance_locked && !d.forced) {
        result.skippedLocked.push({ sessionId: s.id, date: s.date, reason: 'Timetable changed but this class already has attendance' });
        continue;
      }
      await tx
        .updateTable('class_sessions')
        .set({
          offering_id: d.offeringId,
          group_id: d.groupId,
          time_range: range(d),
          room_id: d.roomId,
          teacher_id: d.teacherId,
          status: nextStatus,
          source_override_id: d.overrideId,
        })
        .where('id', '=', s.id)
        .execute();
      await writeAudiences(s.id, { ...d, status: nextStatus === 'cancelled' ? 'cancelled' : 'scheduled' });
      result.updated++;
    }

    // Sessions no longer produced by the timetable.
    for (const s of existingByKey.values()) {
      if (s.attendance_locked) {
        result.skippedLocked.push({ sessionId: s.id, date: s.date, reason: 'Removed from the timetable but this class already has attendance' });
        continue;
      }
      await tx.deleteFrom('class_sessions').where('id', '=', s.id).execute();
      result.removed++;
    }
  }
  return result;
}
