import { sql } from 'kysely';
import { isExpected, loadClass } from '../attendance/service.ts';
import { appendAudit } from '../audit/audit.ts';
import type { AppContext } from '../context.ts';
import type { Tx } from '../db/index.ts';
import type { IssueReason, IssueStatus } from '../db/schema.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../platform/ids.ts';
import { requestCorrection, type NewStatus } from '../support/corrections.ts';

/**
 * A student raises an issue about a past class (ADR-0027): the class's teacher
 * confirms (which files an ordinary correction as the teacher's attestation) or
 * declines; Acad Ops then approves the correction under the two-person rule.
 * Classes without a teacher go straight to Acad Ops.
 */

export const ISSUE_LOOKBACK_DAYS = 30;

const REASON_STATUS: Record<IssueReason, NewStatus> = {
  marked_absent_but_present: 'present',
  marked_late_but_on_time: 'present',
  wrong_record: 'present',
  other: 'present',
};

export async function raiseIssue(ctx: AppContext, studentId: string, input: { class_session_id: string; reason: IssueReason; note: string }, ip: string) {
  const cls = await loadClass(ctx.db, input.class_session_id);
  if (!cls || !(await isExpected(ctx.db, cls.id, studentId))) throw new ApiError(404, 'not_found', 'Class not found.');
  if (ctx.now() < cls.ends_at.getTime()) throw new ApiError(409, 'class_ongoing', 'You can raise an issue once the class has ended. During class, use "Can\'t scan? Ask for help".');
  if (ctx.now() - cls.ends_at.getTime() > ISSUE_LOOKBACK_DAYS * 86_400_000) throw new ApiError(409, 'too_old', `Issues can be raised for classes in the last ${ISSUE_LOOKBACK_DAYS} days. Please contact Academic Operations.`);
  const record = await ctx.db.selectFrom('attendance_records').select('status').where('student_id', '=', studentId).where('class_session_id', '=', cls.id).executeTakeFirst();
  if (record && (record.status === 'present' || record.status === 'od') && input.reason !== 'other') {
    throw new ApiError(409, 'no_change', `You are already recorded as ${record.status === 'od' ? 'on duty' : 'present'} for this class.`);
  }
  const id = uuidv7(ctx.now());
  const status: IssueStatus = cls.teacher_id ? 'pending_teacher' : 'pending_ops';
  try {
    await ctx.db.transaction().execute(async (tx) => {
      await tx.insertInto('attendance_issues').values({ id, student_id: studentId, class_session_id: cls.id, reason: input.reason, note: input.note.trim(), status, teacher_id: cls.teacher_id }).execute();
      await appendAudit(tx, { actorId: studentId, action: 'issue.raise', entityType: 'attendance_issue', entityId: id, after: { class_session_id: cls.id, reason: input.reason, record: record?.status ?? null }, ip }, new Date(ctx.now()));
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new ApiError(409, 'already_raised', 'You already raised an issue for this class; it is being looked at.');
    throw err;
  }
  return { id, status };
}

/** The class's teacher confirms (files a correction for Acad Ops) or declines. */
export async function answerIssue(ctx: AppContext, teacherId: string, id: string, input: { decision: 'confirm' | 'decline'; new_status?: NewStatus | undefined; note: string | null }, ip: string) {
  const issue = await ctx.db.selectFrom('attendance_issues').selectAll().where('id', '=', id).executeTakeFirst();
  if (!issue || issue.teacher_id !== teacherId) throw new ApiError(404, 'not_found', 'Issue not found.');
  if (issue.status !== 'pending_teacher') throw new ApiError(409, 'already_decided', 'This issue has already been answered.');
  const now = new Date(ctx.now());
  if (input.decision === 'decline') {
    if (!input.note || input.note.trim().length < 3) throw new ApiError(400, 'validation_failed', 'Please tell the student why.', { fields: { note: 'Required' } });
    await ctx.db.transaction().execute(async (tx) => {
      await tx.updateTable('attendance_issues').set({ status: 'declined', teacher_note: input.note, teacher_decided_at: now, resolved_at: now }).where('id', '=', id).execute();
      await appendAudit(tx, { actorId: teacherId, action: 'issue.decline', entityType: 'attendance_issue', entityId: id, after: { note: input.note }, ip }, now);
    });
    return { status: 'declined' as const };
  }
  const newStatus = input.new_status ?? REASON_STATUS[issue.reason];
  const correction = await requestCorrection(
    ctx,
    { id: teacherId, role: 'teacher' },
    { student_id: issue.student_id, class_session_id: issue.class_session_id, new_status: newStatus, reason: `Student issue confirmed by teacher${input.note ? `: ${input.note}` : ''}` },
    ip,
  );
  await ctx.db.transaction().execute(async (tx) => {
    await tx.updateTable('attendance_issues').set({ status: 'pending_ops', teacher_note: input.note, teacher_decided_at: now, correction_id: correction.id }).where('id', '=', id).execute();
    await appendAudit(tx, { actorId: teacherId, action: 'issue.confirm', entityType: 'attendance_issue', entityId: id, after: { correction_id: correction.id, new_status: newStatus }, ip }, now);
  });
  return { status: 'pending_ops' as const, correction_id: correction.id };
}

/** Acad Ops, for issues with no teacher: file a correction (another person approves it) or decline. */
export async function opsIssueDecision(ctx: AppContext, actorId: string, id: string, input: { decision: 'correct' | 'decline'; new_status?: NewStatus | undefined; note: string | null }, ip: string) {
  const issue = await ctx.db.selectFrom('attendance_issues').selectAll().where('id', '=', id).executeTakeFirst();
  if (!issue) throw new ApiError(404, 'not_found', 'Issue not found.');
  if (issue.status !== 'pending_ops' || issue.correction_id) throw new ApiError(409, 'already_decided', issue.correction_id ? 'A correction is already waiting for approval; decide it under Corrections.' : 'This issue has already been decided.');
  const now = new Date(ctx.now());
  if (input.decision === 'decline') {
    if (!input.note || input.note.trim().length < 3) throw new ApiError(400, 'validation_failed', 'Please tell the student why.', { fields: { note: 'Required' } });
    await ctx.db.transaction().execute(async (tx) => {
      await tx.updateTable('attendance_issues').set({ status: 'declined', teacher_note: input.note, resolved_at: now }).where('id', '=', id).execute();
      await appendAudit(tx, { actorId, action: 'issue.decline', entityType: 'attendance_issue', entityId: id, after: { note: input.note, by: 'acadops' }, ip }, now);
    });
    return { status: 'declined' as const };
  }
  const correction = await requestCorrection(
    ctx,
    { id: actorId, role: 'acadops' },
    { student_id: issue.student_id, class_session_id: issue.class_session_id, new_status: input.new_status ?? REASON_STATUS[issue.reason], reason: `Student issue${input.note ? `: ${input.note}` : ''}` },
    ip,
  );
  await ctx.db.updateTable('attendance_issues').set({ correction_id: correction.id }).where('id', '=', id).execute();
  return { status: 'pending_ops' as const, correction_id: correction.id };
}

/** Called when a correction is decided: closes the issue that produced it. */
export async function closeIssueForCorrection(tx: Tx, correctionId: string, approved: boolean, now: Date): Promise<void> {
  await tx
    .updateTable('attendance_issues')
    .set({ status: approved ? 'resolved' : 'declined', resolved_at: now })
    .where('correction_id', '=', correctionId)
    .where('status', '=', 'pending_ops')
    .execute();
}

export async function cancelIssue(ctx: AppContext, studentId: string, id: string, ip: string) {
  const r = await ctx.db
    .updateTable('attendance_issues')
    .set({ status: 'cancelled', resolved_at: new Date(ctx.now()) })
    .where('id', '=', id)
    .where('student_id', '=', studentId)
    .where('status', '=', 'pending_teacher')
    .executeTakeFirst();
  if (r.numUpdatedRows === 0n) throw new ApiError(409, 'already_decided', 'This issue can no longer be cancelled.');
  await ctx.db.transaction().execute((tx) => appendAudit(tx, { actorId: studentId, action: 'issue.cancel', entityType: 'attendance_issue', entityId: id, ip }, new Date(ctx.now())));
  return { ok: true as const };
}

export async function listIssues(ctx: AppContext, filter: { studentId?: string; teacherId?: string; status?: IssueStatus | 'all' }) {
  let q = ctx.db
    .selectFrom('attendance_issues as i')
    .innerJoin('users as u', 'u.id', 'i.student_id')
    .leftJoin('students as st', 'st.user_id', 'i.student_id')
    .leftJoin('users as t', 't.id', 'i.teacher_id')
    .innerJoin('class_sessions as cs', 'cs.id', 'i.class_session_id')
    .innerJoin('course_offerings as o', 'o.id', 'cs.offering_id')
    .innerJoin('subjects as s', 's.id', 'o.subject_id')
    .leftJoin('attendance_records as r', (j) => j.onRef('r.student_id', '=', 'i.student_id').onRef('r.class_session_id', '=', 'i.class_session_id'))
    .select([
      'i.id', 'i.reason', 'i.note', 'i.status', 'i.teacher_note', 'i.correction_id', 'i.created_at', 'i.resolved_at', 'i.class_session_id',
      'u.name as student_name', 'st.usn', 't.name as teacher_name', 's.code as subject_code', 's.name as subject_name', 'cs.date', 'r.status as record_status',
      sql<string>`to_char(lower(cs.time_range) at time zone ${ctx.config.timeZone}, 'HH24:MI')`.as('start'),
    ])
    .orderBy('i.created_at', 'desc')
    .limit(300);
  if (filter.studentId) q = q.where('i.student_id', '=', filter.studentId);
  if (filter.teacherId) q = q.where('i.teacher_id', '=', filter.teacherId);
  if (filter.status && filter.status !== 'all') q = q.where('i.status', '=', filter.status);
  const rows = await q.execute();
  return {
    items: rows.map((r) => ({
      id: r.id,
      reason: r.reason,
      note: r.note,
      status: r.status,
      teacher_note: r.teacher_note,
      correction_id: r.correction_id,
      created_at: r.created_at.toISOString(),
      resolved_at: r.resolved_at?.toISOString() ?? null,
      record_status: r.record_status,
      student: { name: r.student_name, usn: r.usn },
      teacher: r.teacher_name,
      class: { id: r.class_session_id, date: r.date, start: r.start, code: r.subject_code, name: r.subject_name },
    })),
  };
}
