import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import type { DbOrTx, Tx } from '../db/index.ts';
import type { NoticeAudience, NoticeKind } from '../db/schema.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../platform/ids.ts';
import { resolveTeacher } from '../timetable/teachers.ts';
import { todayIn } from '../timetable/service.ts';
import { uuid } from '../validation.ts';

/**
 * Notices from Academic Operations (ADR-0023).
 *
 *  Announcements: written by Acad Ops for everyone, all students, all teachers, a
 *    section (optionally one lab batch) or one subject's class.
 *  Class changes: posted automatically when a class is cancelled, moved or added for
 *    a day, to the students of that class and the teachers involved; undoing the change
 *    withdraws the notice and tells the same people it is back to normal.
 *
 * Recipients are fixed when a notice is posted, so "read by 41 of 60" stays meaningful
 * and a student who joins later doesn't get last month's news. Delivery is in the app
 * (students) and on the teacher's home page; push notifications can be added on top of
 * notice_recipients without changing this.
 */

export const audienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('everyone') }),
  z.object({ kind: z.literal('students') }),
  z.object({ kind: z.literal('teachers') }),
  z.object({ kind: z.literal('section'), section_id: uuid, group_id: uuid.nullable().default(null) }),
  z.object({ kind: z.literal('offering'), offering_id: uuid, group_id: uuid.nullable().default(null) }),
]);

/** Announcements stay in the app for this long; class changes until their day is over. */
const ANNOUNCEMENT_DAYS = 30;

export interface Reach {
  label: string;
  students: string[];
  teachers: string[];
}

/** Who an audience reaches right now (active accounts only), with a readable label. */
export async function resolveAudience(db: DbOrTx, a: NoticeAudience): Promise<Reach> {
  const ids = async (q: RawBuilder<{ id: string }>) => (await q.execute(db)).rows.map((r) => r.id);
  const byRole = (role: 'student' | 'teacher') => ids(sql<{ id: string }>`select id from users where role = ${role} and status = 'active'`);
  switch (a.kind) {
    case 'everyone':
      return { label: 'Everyone', students: await byRole('student'), teachers: await byRole('teacher') };
    case 'students':
      return { label: 'All students', students: await byRole('student'), teachers: [] };
    case 'teachers':
      return { label: 'All teachers', students: [], teachers: await byRole('teacher') };
    case 'section': {
      const sec = await db.selectFrom('sections').select('name').where('id', '=', a.section_id).executeTakeFirst();
      if (!sec) throw new ApiError(400, 'invalid_reference', 'Section not found.');
      const group = await groupName(db, a.group_id, a.section_id);
      const g = a.group_id;
      return {
        label: group ? `${sec.name} · ${group}` : sec.name,
        students: await ids(sql<{ id: string }>`
          select s.user_id as id from students s join users u on u.id = s.user_id and u.status = 'active'
          where s.section_id = ${a.section_id} and (${g}::uuid is null or s.group_id = ${g}::uuid)`),
        teachers: await ids(sql<{ id: string }>`
          select distinct ta.teacher_id as id from teaching_assignments ta
          join course_offerings o on o.id = ta.offering_id
          join users u on u.id = ta.teacher_id and u.status = 'active'
          where o.section_id = ${a.section_id} and (${g}::uuid is null or ta.group_id is null or ta.group_id = ${g}::uuid)`),
      };
    }
    case 'offering': {
      const off = await db.selectFrom('course_offerings_labeled').select(['subject_code', 'section_name', 'section_id']).where('id', '=', a.offering_id).executeTakeFirst();
      if (!off) throw new ApiError(400, 'invalid_reference', 'Subject class not found.');
      const group = await groupName(db, a.group_id, off.section_id);
      const g = a.group_id;
      return {
        label: `${off.subject_code} · ${off.section_name}${group ? ` · ${group}` : ''}`,
        students: await ids(sql<{ id: string }>`
          select e.student_id as id from enrollments e join users u on u.id = e.student_id and u.status = 'active'
          where e.offering_id = ${a.offering_id} and (${g}::uuid is null or e.group_id = ${g}::uuid)`),
        teachers: await ids(sql<{ id: string }>`
          select distinct ta.teacher_id as id from teaching_assignments ta
          join users u on u.id = ta.teacher_id and u.status = 'active'
          where ta.offering_id = ${a.offering_id} and (${g}::uuid is null or ta.group_id is null or ta.group_id = ${g}::uuid)`),
      };
    }
  }
}

async function groupName(db: DbOrTx, groupId: string | null, sectionId: string): Promise<string | null> {
  if (!groupId) return null;
  const g = await db.selectFrom('section_groups').select(['name', 'section_id']).where('id', '=', groupId).executeTakeFirst();
  if (!g || g.section_id !== sectionId) throw new ApiError(400, 'invalid_reference', 'That lab batch is not in this section.');
  return g.name;
}

export interface NewNotice {
  kind: NoticeKind;
  title: string;
  body: string;
  audience: NoticeAudience;
  label: string;
  recipients: string[];
  createdBy: string | null;
  overrideId?: string | null;
  classDate?: string | null;
}

export async function postNotice(tx: Tx, ctx: AppContext, n: NewNotice): Promise<{ id: string; recipients: number }> {
  const id = uuidv7(ctx.now());
  await tx
    .insertInto('notices')
    .values({
      id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      audience: JSON.stringify(n.audience),
      audience_label: n.label,
      override_id: n.overrideId ?? null,
      class_date: n.classDate ?? null,
      created_by: n.createdBy,
      created_at: new Date(ctx.now()),
    })
    .execute();
  const users = [...new Set(n.recipients)];
  for (let i = 0; i < users.length; i += 1000) {
    await tx.insertInto('notice_recipients').values(users.slice(i, i + 1000).map((user_id) => ({ notice_id: id, user_id }))).execute();
  }
  return { id, recipients: users.length };
}

// ── Reading ────────────────────────────────────────────────────────────────

export async function myNotices(ctx: AppContext, userId: string) {
  const since = new Date(ctx.now() - ANNOUNCEMENT_DAYS * 86_400_000);
  const rows = await ctx.db
    .selectFrom('notice_recipients as r')
    .innerJoin('notices as n', 'n.id', 'r.notice_id')
    .select(['n.id', 'n.kind', 'n.title', 'n.body', 'n.class_date', 'n.created_at', 'r.read_at'])
    .where('r.user_id', '=', userId)
    .where('n.withdrawn_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb.and([eb('n.kind', '=', 'announcement'), eb('n.created_at', '>', since)]),
        eb.and([eb('n.kind', '=', 'class_change'), eb('n.class_date', '>=', todayIn(ctx))]),
      ]),
    )
    .orderBy('n.created_at', 'desc')
    .limit(50)
    .execute();
  const items = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    class_date: r.class_date,
    created_at: r.created_at.toISOString(),
    read: r.read_at !== null,
  }));
  return { items, unread: items.filter((i) => !i.read).length };
}

/** Marks the given notices (or all of them) read for this user. */
export async function markRead(ctx: AppContext, userId: string, ids?: string[]): Promise<void> {
  if (ids && ids.length === 0) return;
  let q = ctx.db.updateTable('notice_recipients').set({ read_at: new Date(ctx.now()) }).where('user_id', '=', userId).where('read_at', 'is', null);
  if (ids) q = q.where('notice_id', 'in', ids);
  await q.execute();
}

export async function listForOps(ctx: AppContext) {
  const rows = await ctx.db
    .selectFrom('notices as n')
    .leftJoin('users as u', 'u.id', 'n.created_by')
    .select((eb) => [
      'n.id', 'n.kind', 'n.title', 'n.body', 'n.audience_label', 'n.class_date', 'n.created_at', 'n.withdrawn_at', 'u.name as created_by_name',
      eb.selectFrom('notice_recipients as r').select(sql<number>`count(*)::int`.as('n')).whereRef('r.notice_id', '=', 'n.id').as('recipients'),
      eb.selectFrom('notice_recipients as r').select(sql<number>`count(r.read_at)::int`.as('n')).whereRef('r.notice_id', '=', 'n.id').as('read'),
    ])
    .orderBy('n.created_at', 'desc')
    .limit(100)
    .execute();
  return {
    items: rows.map((r) => ({
      ...r,
      recipients: r.recipients ?? 0,
      read: r.read ?? 0,
      created_at: r.created_at.toISOString(),
      withdrawn_at: r.withdrawn_at?.toISOString() ?? null,
    })),
  };
}

export async function withdrawNotice(tx: Tx, ctx: AppContext, id: string, by: string | null) {
  return tx
    .updateTable('notices')
    .set({ withdrawn_at: new Date(ctx.now()), withdrawn_by: by })
    .where('id', '=', id)
    .where('withdrawn_at', 'is', null)
    .returning(['id', 'kind', 'title', 'override_id'])
    .executeTakeFirst();
}

// ── Class changes (timetable overrides) ────────────────────────────────────

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Fri 26 Sep" for a YYYY-MM-DD date. */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

interface ClassChange {
  action: 'cancel' | 'modify' | 'add';
  date: string;
  offeringId: string;
  code: string;
  name: string;
  sectionName: string;
  sectionId: string;
  /** Batch before / after the change (the same unless the batch was changed). */
  groupBefore: string | null;
  groupAfter: string | null;
  before: { start: string; end: string; room: string | null; teacherId: string | null } | null;
  after: { start: string; end: string; room: string | null; teacherId: string | null } | null;
}

/** Everything needed to describe an override in plain words. */
async function describeOverride(tx: Tx, overrideId: string): Promise<ClassChange | null> {
  const ov = await tx
    .selectFrom('timetable_overrides as ov')
    .leftJoin('timetable_entries as e', 'e.id', 'ov.entry_id')
    .select([
      'ov.action', 'ov.date', 'ov.new_offering_id', 'ov.new_group_id', 'ov.new_room_id', 'ov.new_teacher_id',
      'e.offering_id as e_offering_id', 'e.group_id as e_group_id', 'e.room_id as e_room_id', 'e.teacher_id as e_teacher_id',
      sql<string | null>`to_char(ov.new_start, 'HH24:MI')`.as('new_start'),
      sql<string | null>`to_char(ov.new_end, 'HH24:MI')`.as('new_end'),
      sql<string | null>`to_char(e.start_time, 'HH24:MI')`.as('e_start'),
      sql<string | null>`to_char(e.end_time, 'HH24:MI')`.as('e_end'),
    ])
    .where('ov.id', '=', overrideId)
    .executeTakeFirst();
  if (!ov) return null;
  const offeringId = ov.e_offering_id ?? ov.new_offering_id;
  if (!offeringId) return null;
  const off = await tx.selectFrom('course_offerings_labeled').select(['subject_code', 'subject_name', 'section_name', 'section_id']).where('id', '=', offeringId).executeTakeFirstOrThrow();
  const assignments = await tx.selectFrom('teaching_assignments').select(['offering_id', 'group_id', 'teacher_id', 'role']).where('offering_id', '=', offeringId).execute();
  const roomIds = [ov.e_room_id, ov.new_room_id].filter((x): x is string => Boolean(x));
  const rooms = new Map(roomIds.length ? (await tx.selectFrom('rooms').select(['id', 'code']).where('id', 'in', roomIds).execute()).map((r) => [r.id, r.code]) : []);
  const room = (id: string | null) => (id ? (rooms.get(id) ?? null) : null);

  const groupBefore = ov.action === 'add' ? null : ov.e_group_id;
  const groupAfter = ov.action === 'add' ? ov.new_group_id : (ov.new_group_id ?? ov.e_group_id);
  const before =
    ov.action === 'add' || !ov.e_start || !ov.e_end
      ? null
      : { start: ov.e_start, end: ov.e_end, room: room(ov.e_room_id), teacherId: ov.e_teacher_id ?? resolveTeacher(assignments, offeringId, ov.e_group_id) };
  const after =
    ov.action === 'cancel'
      ? null
      : {
          start: ov.new_start ?? before?.start ?? '',
          end: ov.new_end ?? before?.end ?? '',
          room: ov.new_room_id ? room(ov.new_room_id) : (before?.room ?? null),
          teacherId: ov.new_teacher_id ?? before?.teacherId ?? resolveTeacher(assignments, offeringId, groupAfter),
        };
  return {
    action: ov.action,
    date: ov.date,
    offeringId,
    code: off.subject_code,
    name: off.subject_name,
    sectionName: off.section_name,
    sectionId: off.section_id,
    groupBefore,
    groupAfter,
    before,
    after,
  };
}

async function teacherNames(tx: Tx, ids: (string | null)[]): Promise<Map<string, string>> {
  const list = ids.filter((x): x is string => Boolean(x));
  if (!list.length) return new Map();
  return new Map((await tx.selectFrom('users').select(['id', 'name']).where('id', 'in', list).execute()).map((u) => [u.id, u.name]));
}

async function batchLabel(tx: Tx, groupId: string | null): Promise<string> {
  if (!groupId) return '';
  const g = await tx.selectFrom('section_groups').select('name').where('id', '=', groupId).executeTakeFirst();
  return g ? ` (${g.name})` : '';
}

async function changeRecipients(tx: Tx, c: ClassChange): Promise<Reach & { audience: NoticeAudience }> {
  const audience: NoticeAudience = { kind: 'offering', offering_id: c.offeringId, group_id: c.groupAfter ?? c.groupBefore };
  const main = await resolveAudience(tx, audience);
  const students = new Set(main.students);
  const teachers = new Set(main.teachers);
  if (c.groupBefore !== c.groupAfter) {
    for (const g of [c.groupBefore, c.groupAfter]) {
      const r = await resolveAudience(tx, { kind: 'offering', offering_id: c.offeringId, group_id: g });
      r.students.forEach((s) => students.add(s));
    }
  }
  // The teachers involved, even when they aren't assigned to the subject (a substitute).
  for (const t of [c.before?.teacherId, c.after?.teacherId]) if (t) teachers.add(t);
  return { audience, label: main.label, students: [...students], teachers: [...teachers] };
}

/** Posts the notice for a newly saved timetable override. */
export async function noticeForOverride(tx: Tx, ctx: AppContext, overrideId: string, opts: { createdBy: string; note?: string | null }) {
  const c = await describeOverride(tx, overrideId);
  if (!c) return null;
  const names = await teacherNames(tx, [c.before?.teacherId ?? null, c.after?.teacherId ?? null]);
  const who = await batchLabel(tx, c.groupAfter ?? c.groupBefore);
  const day = dayLabel(c.date);
  let title: string;
  let body: string;
  if (c.action === 'cancel') {
    title = `${c.code} cancelled · ${day}`;
    body = `${c.name}${who} at ${c.before?.start}–${c.before?.end} on ${day} will not take place.`;
  } else if (c.action === 'add') {
    const a = c.after!;
    const t = a.teacherId ? names.get(a.teacherId) : undefined;
    title = `Extra ${c.code} class · ${day}`;
    body = `${c.name}${who}, ${a.start}–${a.end}${a.room ? ` in ${a.room}` : ''}${t ? ` with ${t}` : ''}.`;
  } else {
    const b = c.before!;
    const a = c.after!;
    const lines: string[] = [];
    if (a.room !== b.room) lines.push(`Room: ${b.room ?? 'none'} → ${a.room ?? 'none'}`);
    if (a.start !== b.start || a.end !== b.end) lines.push(`Time: ${b.start}–${b.end} → ${a.start}–${a.end}`);
    if (a.teacherId !== b.teacherId) lines.push(`Teacher: ${(b.teacherId && names.get(b.teacherId)) ?? 'none'} → ${(a.teacherId && names.get(a.teacherId)) ?? 'none'}`);
    title = `${c.code} changed · ${day}`;
    body = `${c.name}${who} on ${day}:\n${lines.length ? lines.join('\n') : 'Details updated.'}`;
  }
  const note = opts.note?.trim();
  if (note) body += `\n\n${note}`;
  const r = await changeRecipients(tx, c);
  return postNotice(tx, ctx, {
    kind: 'class_change',
    title,
    body,
    audience: r.audience,
    label: r.label,
    recipients: [...r.students, ...r.teachers],
    createdBy: opts.createdBy,
    overrideId,
    classDate: c.date,
  });
}

/**
 * An override was undone or replaced. Its live notices are withdrawn; when undone
 * (not replaced), the same people are told the class is back to how it was.
 */
export async function overrideUndone(tx: Tx, ctx: AppContext, overrideId: string, opts: { by: string; replaced: boolean }) {
  const live = await tx.selectFrom('notices').select('id').where('override_id', '=', overrideId).where('withdrawn_at', 'is', null).execute();
  if (!live.length) return null;
  for (const n of live) await withdrawNotice(tx, ctx, n.id, opts.by);
  if (opts.replaced) return null;
  const c = await describeOverride(tx, overrideId);
  if (!c) return null;
  const recipients = (await tx.selectFrom('notice_recipients').select('user_id').where('notice_id', 'in', live.map((n) => n.id)).execute()).map((r) => r.user_id);
  const who = await batchLabel(tx, c.groupAfter ?? c.groupBefore);
  const day = dayLabel(c.date);
  let title: string;
  let body: string;
  if (c.action === 'add') {
    title = `Extra ${c.code} class called off · ${day}`;
    body = `The extra ${c.name} class${who} on ${day} (${c.after?.start}–${c.after?.end}) will not take place.`;
  } else {
    const b = c.before!;
    const t = b.teacherId ? (await teacherNames(tx, [b.teacherId])).get(b.teacherId) : undefined;
    title = `${c.code} back to normal · ${day}`;
    body = `${c.name}${who} on ${day} is on as usual: ${b.start}–${b.end}${b.room ? ` in ${b.room}` : ''}${t ? ` with ${t}` : ''}.`;
  }
  const r = await changeRecipients(tx, c);
  return postNotice(tx, ctx, {
    kind: 'class_change',
    title,
    body,
    audience: r.audience,
    label: r.label,
    recipients,
    createdBy: opts.by,
    overrideId,
    classDate: c.date,
  });
}
