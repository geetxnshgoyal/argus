import { sql } from 'kysely';
import { appendAudit } from '../audit/audit.ts';
import type { AppContext } from '../context.ts';
import type { Role } from '../db/schema.ts';
import { isExpected, loadClass } from '../attendance/service.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../platform/ids.ts';

/**
 * Attendance corrections after class (spec §7, §9): a request (by the class's
 * teacher, as their attestation, or by Acad Ops) and an approval by a
 * different Acad Ops/admin. The database also refuses requested_by = approved_by.
 */

export type NewStatus = 'present' | 'late' | 'absent' | 'excused';

export async function requestCorrection(
  ctx: AppContext,
  actor: { id: string; role: Role },
  input: { student_id: string; class_session_id: string; new_status: NewStatus; reason: string },
  ip: string,
) {
  const cls = await loadClass(ctx.db, input.class_session_id);
  if (!cls) throw new ApiError(404, 'not_found', 'Class not found.');
  if (actor.role === 'teacher' && cls.teacher_id !== actor.id) throw new ApiError(403, 'not_your_class', 'You can only request corrections for your own classes.');
  if (ctx.now() < cls.ends_at.getTime()) throw new ApiError(409, 'class_ongoing', 'The class is still on. Change the student directly in the live attendance panel.');
  if (!(await isExpected(ctx.db, cls.id, input.student_id))) throw new ApiError(404, 'not_found', 'This student is not in this class.');
  const current = await ctx.db.selectFrom('attendance_records').select('status').where('student_id', '=', input.student_id).where('class_session_id', '=', cls.id).executeTakeFirst();
  if (current?.status === input.new_status) throw new ApiError(409, 'no_change', `The student is already recorded as ${input.new_status}.`);
  const id = uuidv7(ctx.now());
  try {
    await ctx.db.transaction().execute(async (tx) => {
      await tx
        .insertInto('attendance_corrections')
        .values({ id, student_id: input.student_id, class_session_id: cls.id, old_status: current?.status ?? null, new_status: input.new_status, reason: input.reason, requested_by: actor.id })
        .execute();
      await appendAudit(tx, { actorId: actor.id, action: 'correction.request', entityType: 'attendance_correction', entityId: id, after: { ...input, old_status: current?.status ?? null }, ip }, new Date(ctx.now()));
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new ApiError(409, 'already_requested', 'A correction for this student and class is already waiting for approval.');
    throw err;
  }
  return { id, status: 'pending' as const };
}

export async function decideCorrection(ctx: AppContext, actorId: string, id: string, decision: 'approve' | 'reject', note: string | null, ip: string) {
  const now = new Date(ctx.now());
  return ctx.db.transaction().execute(async (tx) => {
    const c = await tx.selectFrom('attendance_corrections').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!c) throw new ApiError(404, 'not_found', 'Correction not found.');
    if (c.status !== 'pending') throw new ApiError(409, 'already_decided', 'This correction has already been decided.');
    if (decision === 'approve') {
      // Two-person rule (spec §16 #11); the DB check constraint enforces it too.
      if (c.requested_by === actorId) throw new ApiError(403, 'two_person_rule', 'Someone else must approve a correction you requested.');
      const s = await tx.selectFrom('class_sessions').select('id').where('id', '=', c.class_session_id).executeTakeFirstOrThrow();
      const att = await tx.selectFrom('attendance_sessions').select('id').where('class_session_id', '=', s.id).orderBy('started_at', 'desc').limit(1).executeTakeFirst();
      const before = await tx.selectFrom('attendance_records').selectAll().where('student_id', '=', c.student_id).where('class_session_id', '=', c.class_session_id).executeTakeFirst();
      await tx
        .insertInto('attendance_records')
        .values({ student_id: c.student_id, class_session_id: c.class_session_id, attendance_session_id: att?.id ?? null, status: c.new_status, basis: 'correction', updated_by: actorId, note: c.reason })
        .onConflict((oc) => oc.columns(['student_id', 'class_session_id']).doUpdateSet({ status: c.new_status, basis: 'correction', updated_by: actorId, note: c.reason }))
        .execute();
      await tx.updateTable('attendance_corrections').set({ status: 'approved', approved_by: actorId, decided_at: now, decision_note: note }).where('id', '=', id).execute();
      await appendAudit(tx, { actorId, action: 'correction.approve', entityType: 'attendance_record', entityId: `${c.student_id}:${c.class_session_id}`, before: before ? { status: before.status, basis: before.basis } : null, after: { status: c.new_status, correction_id: id, requested_by: c.requested_by, note }, ip }, now);
    } else {
      if (!note || note.trim().length < 3) throw new ApiError(400, 'validation_failed', 'Please give a reason.', { fields: { note: 'Required' } });
      await tx.updateTable('attendance_corrections').set({ status: 'rejected', approved_by: c.requested_by === actorId ? null : actorId, decided_at: now, decision_note: note }).where('id', '=', id).execute();
      await appendAudit(tx, { actorId, action: 'correction.reject', entityType: 'attendance_correction', entityId: id, after: { note }, ip }, now);
    }
    return { ok: true as const };
  });
}

export async function listCorrections(ctx: AppContext, status: 'pending' | 'approved' | 'rejected' | 'all', viewerId: string) {
  let q = ctx.db
    .selectFrom('attendance_corrections as c')
    .innerJoin('users as u', 'u.id', 'c.student_id')
    .leftJoin('students as st', 'st.user_id', 'c.student_id')
    .innerJoin('users as rq', 'rq.id', 'c.requested_by')
    .leftJoin('users as ap', 'ap.id', 'c.approved_by')
    .innerJoin('class_sessions as cs', 'cs.id', 'c.class_session_id')
    .innerJoin('course_offerings as o', 'o.id', 'cs.offering_id')
    .innerJoin('subjects as s', 's.id', 'o.subject_id')
    .select([
      'c.id', 'c.status', 'c.old_status', 'c.new_status', 'c.reason', 'c.decision_note', 'c.created_at', 'c.decided_at', 'c.requested_by',
      'u.name as student_name', 'st.usn', 'rq.name as requested_by_name', 'rq.role as requested_by_role', 'ap.name as approved_by_name',
      's.code as subject_code', 'cs.date',
      sql<string>`to_char(lower(cs.time_range) at time zone ${ctx.config.timeZone}, 'HH24:MI')`.as('start'),
    ])
    .orderBy('c.created_at', 'desc')
    .limit(300);
  if (status !== 'all') q = q.where('c.status', '=', status);
  const rows = await q.execute();
  return {
    items: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString(), decided_at: r.decided_at?.toISOString() ?? null, mine: r.requested_by === viewerId })),
  };
}
