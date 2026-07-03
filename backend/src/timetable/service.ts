import { sql } from 'kysely';
import type { AppContext } from '../context.ts';
import type { Db, DbOrTx, Tx } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../platform/ids.ts';
import { addDays, localDate, maxDate, WEEKDAY_NAMES } from './dates.ts';
import type { ParseIssue } from './import-parse.ts';
import { materialize, type MaterializeResult } from './materialize.ts';
import { resolveTeacher } from './teachers.ts';

export { resolveTeacher };

/** Days of class sessions kept materialized ahead (spec §8). */
export const MATERIALIZE_DAYS = 14;

// ── Enrollment sync ─────────────────────────────────────────────────────────

/**
 * Every active student of a section is enrolled in the section's offerings
 * for that term, with their lab batch. Only enrollments this sync created
 * (source = 'section') are ever removed; manual ones are left alone.
 */
export async function syncSectionEnrollments(tx: Tx, sectionId: string): Promise<{ added: number; removed: number; updated: number }> {
  const added = await sql<{ n: number }>`
    with ins as (
      insert into enrollments (id, student_id, offering_id, group_id, source)
      select gen_random_uuid(), s.user_id, o.id, s.group_id, 'section'
      from course_offerings o
      join students s on s.section_id = o.section_id
      join users u on u.id = s.user_id and u.status = 'active'
      where o.section_id = ${sectionId}
      on conflict (student_id, offering_id) do nothing
      returning 1
    ) select count(*)::int as n from ins`.execute(tx);
  const updated = await sql<{ n: number }>`
    with upd as (
      update enrollments e set group_id = s.group_id
      from students s, course_offerings o
      where e.student_id = s.user_id and e.offering_id = o.id and o.section_id = ${sectionId}
        and e.source = 'section' and e.group_id is distinct from s.group_id
      returning 1
    ) select count(*)::int as n from upd`.execute(tx);
  const removed = await sql<{ n: number }>`
    with del as (
      delete from enrollments e
      using course_offerings o
      where e.offering_id = o.id and o.section_id = ${sectionId} and e.source = 'section'
        and not exists (
          select 1 from students s join users u on u.id = s.user_id
          where s.user_id = e.student_id and s.section_id = o.section_id and u.status = 'active')
      returning 1
    ) select count(*)::int as n from del`.execute(tx);
  return { added: added.rows[0]?.n ?? 0, updated: updated.rows[0]?.n ?? 0, removed: removed.rows[0]?.n ?? 0 };
}

// ── Template-level conflict checks (friendly, before the DB constraints) ───

export interface EntrySpec {
  id: string;
  ref?: string;
  offeringId: string;
  sectionId: string;
  groupId: string | null;
  weekday: number;
  start: string; // HH:MM[:SS]
  end: string;
  roomId: string | null;
  teacherId: string | null; // resolved (explicit or from assignments)
  validFrom: string | null;
  validTo: string | null;
  label: string;
}

const hm = (t: string) => t.slice(0, 5);

export function describeEntry(e: Pick<EntrySpec, 'label' | 'weekday' | 'start' | 'end'>): string {
  return `${e.label}, ${WEEKDAY_NAMES[e.weekday - 1]} ${hm(e.start)}–${hm(e.end)}`;
}

function validityOverlaps(a: EntrySpec, b: EntrySpec): boolean {
  const aFrom = a.validFrom ?? '0000-01-01';
  const bFrom = b.validFrom ?? '0000-01-01';
  const aTo = a.validTo ?? '9999-12-31';
  const bTo = b.validTo ?? '9999-12-31';
  return aFrom <= bTo && bFrom <= aTo;
}

/** Pairwise double-booking check of weekly entries: room, teacher, and batch/section audience. */
export function findEntryConflicts(
  entries: EntrySpec[],
  names: { room: (id: string) => string; teacher: (id: string) => string },
  /** Only report pairs involving this entry (e.g. the one being saved). */
  focusId?: string,
): ParseIssue[] {
  const issues: ParseIssue[] = [];
  const byDay = new Map<number, EntrySpec[]>();
  for (const e of entries) byDay.set(e.weekday, [...(byDay.get(e.weekday) ?? []), e]);
  for (const list of byDay.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i] as EntrySpec;
        const b = list[j] as EntrySpec;
        if (focusId && a.id !== focusId && b.id !== focusId) continue;
        if (!(a.start < b.end && b.start < a.end) || !validityOverlaps(a, b)) continue;
        const ref = a.ref ?? b.ref ?? describeEntry(a);
        if (a.roomId && a.roomId === b.roomId) {
          issues.push({ ref, level: 'error', message: `Room ${names.room(a.roomId)} is double-booked: ${describeEntry(a)} and ${describeEntry(b)}.` });
        }
        if (a.teacherId && a.teacherId === b.teacherId) {
          issues.push({ ref, level: 'error', message: `${names.teacher(a.teacherId)} would teach two classes at once: ${describeEntry(a)} and ${describeEntry(b)}.` });
        }
        if (a.sectionId === b.sectionId && (a.groupId === null || b.groupId === null || a.groupId === b.groupId)) {
          issues.push({ ref, level: 'error', message: `The same students would be in two classes at once: ${describeEntry(a)} and ${describeEntry(b)}.` });
        }
      }
    }
  }
  return issues;
}

/** Loads weekly entries (active on or after `onOrAfter`) as specs with resolved teachers and labels. */
export async function loadEntrySpecs(db: DbOrTx, termId: string, onOrAfter: string): Promise<EntrySpec[]> {
  const rows = await db
    .selectFrom('timetable_entries as e')
    .innerJoin('course_offerings as o', 'o.id', 'e.offering_id')
    .innerJoin('subjects as s', 's.id', 'o.subject_id')
    .innerJoin('sections as sec', 'sec.id', 'o.section_id')
    .leftJoin('section_groups as g', 'g.id', 'e.group_id')
    .select(['e.id', 'e.offering_id', 'o.section_id', 'e.group_id', 'e.weekday', 'e.start_time', 'e.end_time', 'e.room_id', 'e.teacher_id', 'e.valid_from', 'e.valid_to', 's.code', 'sec.name as section_name', 'g.name as group_name'])
    .where('e.term_id', '=', termId)
    .where((eb) => eb.or([eb('e.valid_to', 'is', null), eb('e.valid_to', '>=', onOrAfter)]))
    .execute();
  const assignments = rows.length
    ? await db.selectFrom('teaching_assignments').selectAll().where('offering_id', 'in', [...new Set(rows.map((r) => r.offering_id))]).execute()
    : [];
  return rows.map((r) => ({
    id: r.id,
    offeringId: r.offering_id,
    sectionId: r.section_id,
    groupId: r.group_id,
    weekday: r.weekday,
    start: r.start_time,
    end: r.end_time,
    roomId: r.room_id,
    teacherId: r.teacher_id ?? resolveTeacher(assignments, r.offering_id, r.group_id),
    validFrom: r.valid_from,
    validTo: r.valid_to,
    label: `${r.code} (${r.section_name}${r.group_name ? `, ${r.group_name}` : ''})`,
  }));
}

export async function nameLookups(db: DbOrTx) {
  const rooms = new Map((await db.selectFrom('rooms').select(['id', 'code']).execute()).map((r) => [r.id, r.code]));
  const teachers = new Map((await db.selectFrom('users').select(['id', 'name']).where('role', '=', 'teacher').execute()).map((t) => [t.id, t.name]));
  return { room: (id: string) => rooms.get(id) ?? 'unknown room', teacher: (id: string) => teachers.get(id) ?? 'A teacher' };
}

// ── Materialization with friendly errors ────────────────────────────────────

const CONSTRAINT_MESSAGES: Record<string, string> = {
  class_sessions_room_overlap: 'A room would be double-booked.',
  class_sessions_teacher_overlap: 'A teacher would have two classes at the same time.',
  class_session_audience_overlap: 'The same students would have two classes at the same time.',
};

/** Materializes the next 14 days for a term/section inside `tx`; double-booking becomes a 409. */
export async function rematerialize(tx: Tx, ctx: AppContext, scope: { termId?: string; sectionId?: string }): Promise<MaterializeResult> {
  const today = localDate(ctx.now(), ctx.config.timeZone);
  await sql`savepoint argus_mat`.execute(tx);
  try {
    const r = await materialize(tx, { from: today, to: addDays(today, MATERIALIZE_DAYS - 1), ...scope }, ctx.config.timeZone);
    // Deferred constraints: force the check now so the error is attributable.
    await sql`set constraints all immediate`.execute(tx);
    await sql`release savepoint argus_mat`.execute(tx);
    return r;
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23P01') {
      await sql`rollback to savepoint argus_mat`.execute(tx);
      throw new ApiError(409, 'double_booking', CONSTRAINT_MESSAGES[e.constraint ?? ''] ?? 'This would double-book a room, teacher or batch.', {
        constraint: e.constraint,
      });
    }
    throw err;
  }
}

/** Nightly job: materialize every active term, one section at a time so one problem doesn't block the rest. */
export async function materializeAll(ctx: AppContext): Promise<{ sections: number; failed: { sectionId: string; error: string }[] }> {
  const today = localDate(ctx.now(), ctx.config.timeZone);
  const sections = await ctx.db
    .selectFrom('sections as s')
    .innerJoin('terms as t', 't.id', 's.term_id')
    .select(['s.id', 's.term_id'])
    .where('t.end_date', '>=', today)
    .execute();
  const failed: { sectionId: string; error: string }[] = [];
  for (const s of sections) {
    try {
      await ctx.db.transaction().execute((tx) => rematerialize(tx, ctx, { termId: s.term_id, sectionId: s.id }));
    } catch (err) {
      failed.push({ sectionId: s.id, error: err instanceof Error ? err.message : String(err) });
      ctx.logger.error({ sectionId: s.id, err }, 'materialization failed for section');
    }
  }
  return { sections: sections.length, failed };
}

// ── Session views ───────────────────────────────────────────────────────────

export function sessionsView(db: DbOrTx, timeZone: string) {
  return db
    .selectFrom('class_sessions as cs')
    .innerJoin('course_offerings as o', 'o.id', 'cs.offering_id')
    .innerJoin('subjects as s', 's.id', 'o.subject_id')
    .innerJoin('sections as sec', 'sec.id', 'o.section_id')
    .leftJoin('section_groups as g', 'g.id', 'cs.group_id')
    .leftJoin('rooms as r', 'r.id', 'cs.room_id')
    .leftJoin('users as t', 't.id', 'cs.teacher_id')
    .select([
      'cs.id', 'cs.date', 'cs.status', 'cs.offering_id', 'cs.group_id', 'cs.room_id', 'cs.teacher_id', 'cs.term_id', 'cs.source_entry_id',
      'o.section_id', 's.code as subject_code', 's.name as subject_name', 's.kind as subject_kind', 'sec.name as section_name',
      'g.name as group_name', 'r.code as room', 't.name as teacher_name',
      sql<string>`to_char(lower(cs.time_range) at time zone ${timeZone}, 'HH24:MI')`.as('start'),
      sql<string>`to_char(upper(cs.time_range) at time zone ${timeZone}, 'HH24:MI')`.as('end'),
      sql<string>`lower(cs.time_range)`.as('starts_at'),
      sql<string>`upper(cs.time_range)`.as('ends_at'),
      sql<boolean>`cs.source_override_id is not null`.as('changed'),
    ])
    .orderBy('cs.date')
    .orderBy(sql`lower(cs.time_range)`);
}

export type SessionRow = Awaited<ReturnType<ReturnType<typeof sessionsView>['execute']>>[number];

export function presentSession(s: SessionRow) {
  return {
    id: s.id,
    date: s.date,
    start: s.start,
    end: s.end,
    starts_at: new Date(s.starts_at).toISOString(),
    ends_at: new Date(s.ends_at).toISOString(),
    status: s.status,
    changed: s.changed,
    entry_id: s.source_entry_id,
    subject: { code: s.subject_code, name: s.subject_name, kind: s.subject_kind },
    section: { id: s.section_id, name: s.section_name },
    batch: s.group_name,
    room: s.room,
    teacher: s.teacher_name,
  };
}

/** Number of students expected at a session (enrolled, in the right batch). */
export async function expectedCount(db: DbOrTx, sessionId: string): Promise<number> {
  const r = await sql<{ n: number }>`
    select count(*)::int as n
    from class_sessions cs
    join enrollments e on e.offering_id = cs.offering_id
    join users u on u.id = e.student_id and u.status = 'active'
    where cs.id = ${sessionId} and (cs.group_id is null or e.group_id = cs.group_id)`.execute(db);
  return r.rows[0]?.n ?? 0;
}

export function todayIn(ctx: AppContext): string {
  return localDate(ctx.now(), ctx.config.timeZone);
}

export function defaultEffectiveFrom(ctx: AppContext, termStart: string): string {
  return maxDate(todayIn(ctx), termStart);
}

export async function assertTermSection(db: Db | Tx, termId: string, sectionId: string) {
  const sec = await db.selectFrom('sections').selectAll().where('id', '=', sectionId).executeTakeFirst();
  if (!sec) throw new ApiError(400, 'invalid_reference', 'Section not found.');
  if (sec.term_id !== termId) throw new ApiError(400, 'invalid_section', 'The section belongs to a different term.');
  const term = await db.selectFrom('terms').selectAll().where('id', '=', termId).executeTakeFirstOrThrow();
  return { section: sec, term };
}

export { uuidv7 };
