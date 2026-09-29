import { sql } from 'kysely';
import { appendAudit } from '../audit/audit.ts';
import type { AppContext } from '../context.ts';
import type { DbOrTx, Tx } from '../db/index.ts';
import type { OdStatus } from '../db/schema.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../platform/ids.ts';
import { todayIn } from '../timetable/service.ts';

/**
 * On-duty (OD) requests (ADR-0027). A student asks for whole days or specific
 * classes → a community manager confirms the duty → Acad Ops approves → the
 * student's classes in scope get the `od` record status (counts as attended).
 *
 * Approval applies to classes that already ended (absent/pending records become
 * `od`) and, through `approvedOdStudents`, to classes whose attendance ends
 * later. A real scan (present/late) is never overwritten.
 */

export const OD_MAX_DAYS = 14;
export const OD_MAX_CLASSES = 30;
/** How far back a student may ask for OD. */
export const OD_LOOKBACK_DAYS = 30;

export interface OdInput {
  kind: 'days' | 'classes';
  dates?: string[] | undefined;
  class_session_ids?: string[] | undefined;
  event: string;
  reason: string;
}

/** Class sessions of this student that an OD request covers (enrolled, right batch, not cancelled). */
function coveredClasses(db: DbOrTx, studentId: string, od: { kind: 'days' | 'classes'; dates: string[]; class_session_ids: string[] }) {
  const where =
    od.kind === 'days' ? sql`cs.date = any(${od.dates}::date[])` : sql`cs.id = any(${od.class_session_ids}::uuid[])`;
  return sql<{ id: string; date: string; status: string }>`
    select cs.id, cs.date::text as date, cs.status
    from class_sessions cs
    join enrollments e on e.offering_id = cs.offering_id and e.student_id = ${studentId}
    where (cs.group_id is null or e.group_id = cs.group_id) and cs.status <> 'cancelled' and ${where}`.execute(db);
}

export async function createOdRequest(ctx: AppContext, studentId: string, input: OdInput, ip: string) {
  const today = todayIn(ctx);
  const earliest = new Date(Date.parse(today) - OD_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const dates = [...new Set(input.dates ?? [])].sort();
  const classIds = [...new Set(input.class_session_ids ?? [])];
  if (input.kind === 'days') {
    if (dates.length === 0 || dates.length > OD_MAX_DAYS) throw new ApiError(400, 'validation_failed', `Choose 1 to ${OD_MAX_DAYS} days.`, { fields: { dates: 'Required' } });
    if (dates[0]! < earliest) throw new ApiError(400, 'validation_failed', `OD can be requested for up to ${OD_LOOKBACK_DAYS} days back.`, { fields: { dates: 'Too far back' } });
  } else {
    if (classIds.length === 0 || classIds.length > OD_MAX_CLASSES) throw new ApiError(400, 'validation_failed', `Choose 1 to ${OD_MAX_CLASSES} classes.`, { fields: { class_session_ids: 'Required' } });
  }
  const od = { kind: input.kind, dates: input.kind === 'days' ? dates : [], class_session_ids: input.kind === 'classes' ? classIds : [] };
  const covered = (await coveredClasses(ctx.db, studentId, od)).rows;
  if (input.kind === 'classes') {
    if (covered.length !== classIds.length) throw new ApiError(400, 'validation_failed', 'Some of these classes are not yours or were cancelled.', { fields: { class_session_ids: 'Not your class' } });
    if (covered.some((c) => c.date < earliest)) throw new ApiError(400, 'validation_failed', `OD can be requested for up to ${OD_LOOKBACK_DAYS} days back.`);
  }
  const id = uuidv7(ctx.now());
  await ctx.db.transaction().execute(async (tx) => {
    await tx.insertInto('od_requests').values({ id, student_id: studentId, ...od, event: input.event.trim(), reason: input.reason.trim() }).execute();
    await appendAudit(tx, { actorId: studentId, action: 'od.request', entityType: 'od_request', entityId: id, after: { ...od, event: input.event.trim(), classes: covered.length }, ip }, new Date(ctx.now()));
  });
  return { id, status: 'pending_cm' as const, classes: covered.length };
}

export async function cancelOdRequest(ctx: AppContext, studentId: string, id: string, ip: string) {
  await ctx.db.transaction().execute(async (tx) => {
    const r = await tx.selectFrom('od_requests').select(['status', 'student_id']).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!r || r.student_id !== studentId) throw new ApiError(404, 'not_found', 'Request not found.');
    if (r.status !== 'pending_cm' && r.status !== 'pending_ops') throw new ApiError(409, 'already_decided', 'This request has already been decided.');
    await tx.updateTable('od_requests').set({ status: 'cancelled' }).where('id', '=', id).execute();
    await appendAudit(tx, { actorId: studentId, action: 'od.cancel', entityType: 'od_request', entityId: id, ip }, new Date(ctx.now()));
  });
  return { ok: true as const };
}

/** Community manager (step 1) or Acad Ops (step 2) decides. Rejection needs a note. */
export async function decideOdRequest(
  ctx: AppContext,
  actor: { id: string; role: 'community_manager' | 'acadops' | 'admin' },
  id: string,
  decision: 'approve' | 'reject',
  note: string | null,
  ip: string,
) {
  const now = new Date(ctx.now());
  const step = actor.role === 'community_manager' ? 'cm' : 'ops';
  if (decision === 'reject' && (!note || note.trim().length < 3)) throw new ApiError(400, 'validation_failed', 'Please give a reason.', { fields: { note: 'Required' } });
  return ctx.db.transaction().execute(async (tx) => {
    const r = await tx.selectFrom('od_requests').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!r) throw new ApiError(404, 'not_found', 'Request not found.');
    const expected: OdStatus = step === 'cm' ? 'pending_cm' : 'pending_ops';
    if (r.status !== expected) {
      throw new ApiError(409, 'wrong_step', step === 'cm' ? 'This request is no longer waiting for a community manager.' : 'This request is not waiting for Academic Operations (the community manager must confirm it first).');
    }
    if (r.student_id === actor.id) throw new ApiError(403, 'forbidden', 'You cannot decide your own request.');
    // Two different people approve an OD (like corrections): the final approver can't be the first.
    if (step === 'ops' && decision === 'approve' && r.cm_id === actor.id) throw new ApiError(403, 'two_person_rule', 'Someone else must give the final approval for a request you confirmed.');
    let applied = 0;
    if (step === 'cm') {
      await tx
        .updateTable('od_requests')
        .set(decision === 'approve' ? { status: 'pending_ops', cm_id: actor.id, cm_decided_at: now, cm_note: note } : { status: 'rejected', cm_id: actor.id, cm_decided_at: now, cm_note: note, rejected_by_role: 'community_manager' })
        .where('id', '=', id)
        .execute();
    } else {
      await tx
        .updateTable('od_requests')
        .set(decision === 'approve' ? { status: 'approved', ops_id: actor.id, ops_decided_at: now, ops_note: note } : { status: 'rejected', ops_id: actor.id, ops_decided_at: now, ops_note: note, rejected_by_role: 'acadops' })
        .where('id', '=', id)
        .execute();
      if (decision === 'approve') applied = await applyOd(tx, r.student_id, { kind: r.kind, dates: r.dates, class_session_ids: r.class_session_ids }, actor.id, id);
    }
    await appendAudit(tx, { actorId: actor.id, action: `od.${step}_${decision}`, entityType: 'od_request', entityId: id, after: { note, records_changed: applied }, ip }, now);
    return { ok: true as const, status: decision === 'reject' ? 'rejected' : step === 'cm' ? 'pending_ops' : 'approved', records_changed: applied };
  });
}

/** Past classes in scope: absent/pending records (or none, if attendance ended) become `od`. */
async function applyOd(tx: Tx, studentId: string, od: { kind: 'days' | 'classes'; dates: string[]; class_session_ids: string[] }, actorId: string, requestId: string): Promise<number> {
  const classes = (await coveredClasses(tx, studentId, od)).rows.filter((c) => c.status === 'completed');
  let n = 0;
  for (const c of classes) {
    const att = await tx.selectFrom('attendance_sessions').select('id').where('class_session_id', '=', c.id).orderBy('started_at', 'desc').limit(1).executeTakeFirst();
    const r = await tx
      .insertInto('attendance_records')
      .values({ student_id: studentId, class_session_id: c.id, attendance_session_id: att?.id ?? null, status: 'od', basis: 'od', updated_by: actorId, note: `OD request ${requestId}` })
      .onConflict((oc) =>
        oc
          .columns(['student_id', 'class_session_id'])
          .doUpdateSet({ status: 'od', basis: 'od', updated_by: actorId, note: `OD request ${requestId}` })
          .where('attendance_records.status', 'in', ['absent', 'pending']),
      )
      .executeTakeFirst();
    n += Number(r.numInsertedOrUpdatedRows ?? 0n);
  }
  return n;
}

/** Students with an approved OD covering this class (used when attendance ends, and on the live panel). */
export async function approvedOdStudents(db: DbOrTx, classSessionId: string): Promise<Set<string>> {
  const r = await sql<{ student_id: string }>`
    select distinct o.student_id
    from od_requests o, class_sessions cs
    where cs.id = ${classSessionId} and o.status = 'approved'
      and ((o.kind = 'days' and cs.date = any(o.dates)) or (o.kind = 'classes' and cs.id = any(o.class_session_ids)))`.execute(db);
  return new Set(r.rows.map((x) => x.student_id));
}

// ── Lists ────────────────────────────────────────────────────────────────────

function listQuery(ctx: AppContext) {
  return ctx.db
    .selectFrom('od_requests as o')
    .innerJoin('users as u', 'u.id', 'o.student_id')
    .leftJoin('students as st', 'st.user_id', 'o.student_id')
    .leftJoin('sections as sec', 'sec.id', 'st.section_id')
    .leftJoin('users as cm', 'cm.id', 'o.cm_id')
    .leftJoin('users as ops', 'ops.id', 'o.ops_id')
    .select([
      'o.id', 'o.kind', 'o.dates', 'o.class_session_ids', 'o.event', 'o.reason', 'o.status', 'o.created_at', 'o.rejected_by_role',
      'o.cm_note', 'o.cm_decided_at', 'o.ops_note', 'o.ops_decided_at',
      'u.name as student_name', 'st.usn', 'sec.name as section_name', 'cm.name as cm_name', 'ops.name as ops_name',
    ])
    .orderBy('o.created_at', 'desc')
    .limit(300);
}

type ListRow = Awaited<ReturnType<ReturnType<typeof listQuery>['execute']>>[number];

async function present(ctx: AppContext, rows: ListRow[]) {
  const ids = [...new Set(rows.flatMap((r) => r.class_session_ids))];
  const classes = ids.length
    ? await sql<{ id: string; date: string; start: string; code: string }>`
        select cs.id, cs.date::text as date, to_char(lower(cs.time_range) at time zone ${ctx.config.timeZone}, 'HH24:MI') as start, s.code
        from class_sessions cs join course_offerings o on o.id = cs.offering_id join subjects s on s.id = o.subject_id
        where cs.id = any(${ids}::uuid[])`.execute(ctx.db)
    : { rows: [] };
  const byId = new Map(classes.rows.map((c) => [c.id, c]));
  const files = rows.length
    ? await ctx.db.selectFrom('od_attachments').select(['id', 'od_request_id', 'filename', 'content_type', 'size']).where('od_request_id', 'in', rows.map((r) => r.id)).orderBy('created_at').execute()
    : [];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    dates: r.dates,
    classes: r.class_session_ids.map((id) => byId.get(id)).filter((c): c is NonNullable<typeof c> => Boolean(c)),
    event: r.event,
    reason: r.reason,
    status: r.status,
    rejected_by_role: r.rejected_by_role,
    created_at: r.created_at.toISOString(),
    student: { name: r.student_name, usn: r.usn, section: r.section_name },
    attachments: files.filter((f) => f.od_request_id === r.id).map(({ od_request_id: _, ...f }) => f),
    community_manager: r.cm_name ? { name: r.cm_name, note: r.cm_note, at: r.cm_decided_at?.toISOString() ?? null } : null,
    acadops: r.ops_name ? { name: r.ops_name, note: r.ops_note, at: r.ops_decided_at?.toISOString() ?? null } : null,
  }));
}

export async function myOdRequests(ctx: AppContext, studentId: string) {
  return { items: await present(ctx, await listQuery(ctx).where('o.student_id', '=', studentId).execute()) };
}

export async function odQueue(ctx: AppContext, status: OdStatus | 'all') {
  let q = listQuery(ctx);
  if (status !== 'all') q = q.where('o.status', '=', status);
  return { items: await present(ctx, await q.execute()) };
}
