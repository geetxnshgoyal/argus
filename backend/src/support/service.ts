import { sql } from 'kysely';
import { z } from 'zod';
import { appendAudit } from '../audit/audit.ts';
import { verifyP256 } from '../auth/device-sig.ts';
import type { AppContext } from '../context.ts';
import type { Tx } from '../db/index.ts';
import type { AttemptSignals, SupportReason } from '../db/schema.ts';
import { isExpected, loadClass } from '../attendance/service.ts';
import { AttestationFailed, type RequestEvidence } from '../devices/attestation/index.ts';
import { promoteDueDevices } from '../devices/service.ts';
import { payloadBytes, peekJson } from '../devices/signed.ts';
import { ApiError } from '../errors.ts';
import { evaluateLocation } from '../geo/geofence.ts';
import { sha256Hex } from '../platform/crypto.ts';
import { uuidv7 } from '../platform/ids.ts';
import { assess, REASON_TEXT } from '../risk/scorers.ts';
import { num } from '../risk/settings.ts';
import { presentSession, sessionsView } from '../timetable/service.ts';
import { parse } from '../validation.ts';
import { campusNetworkResult, geofencesFor } from '../attendance/attempts.ts';

/**
 * Support requests (spec §7, ADR-0006, ADR-0020).
 *
 *  Student (bound phone, during class): a signed request; the server snapshots evidence.
 *  Verifier: Approve only when evidence score < threshold AND the phone produced a valid QR
 *    tag for this session; otherwise Ask teacher or Reject. The server enforces this.
 *  Teacher: answers "Is {name} ({USN}) in the room?" → present / absent / not sure.
 *  Decisions are possible until 15 minutes after class end; later changes are corrections.
 */

export const DECISION_GRACE_MS = 15 * 60_000;
const NONCE_TTL_MS = 15 * 60_000;

const evidenceSchema: z.ZodType<RequestEvidence> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('play_integrity'), token: z.string().max(20000) }),
  z.object({ kind: z.literal('app_attest'), assertion: z.string().max(20000) }),
  z.object({ kind: z.literal('missing'), error: z.string().max(200).optional() }),
  z.object({ kind: z.literal('none') }),
]);

const supportBody = z.object({
  payload: z.string().regex(/^[A-Za-z0-9_-]+$/).max(6000),
  signature: z.string().regex(/^[A-Za-z0-9_-]+$/).max(200),
  attestation: evidenceSchema.default({ kind: 'none' }),
});

const supportPayload = z.object({
  v: z.literal(1),
  action: z.literal('support_request'),
  attendance_session_id: z.string().uuid(),
  device_id: z.string().uuid(),
  reason: z.enum(['cant_scan', 'camera_broken', 'phone_problem', 'app_error', 'other']),
  note: z.string().max(300).nullable().default(null),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  device_time: z.string().datetime({ offset: true }),
  location: z
    .object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), accuracy_m: z.number().min(0), fix_age_ms: z.number().int().min(0), is_mock: z.boolean() })
    .nullable(),
  app_version: z.string().max(30),
});

export const REASON_LABEL: Record<SupportReason, string> = {
  cant_scan: 'The code would not scan',
  camera_broken: 'Camera not working',
  phone_problem: 'Phone problem (battery, screen)',
  app_error: 'The app showed an error',
  other: 'Other',
};

function withinDecisionWindow(ctx: AppContext, classEnd: Date): boolean {
  return ctx.now() <= classEnd.getTime() + DECISION_GRACE_MS;
}

// ── Student ──────────────────────────────────────────────────────────────────

export async function createSupportRequest(ctx: AppContext, studentId: string, body: unknown, ip: string) {
  const b = parse(supportBody, body);
  const bytes = payloadBytes(b.payload);
  const deviceId = String(peekJson(bytes).device_id ?? '');
  await promoteDueDevices(ctx, studentId);
  const device = await ctx.db.selectFrom('devices').selectAll().where('id', '=', deviceId).where('user_id', '=', studentId).executeTakeFirst();
  // Only from the bound phone (spec §7).
  if (!device || device.state !== 'active') throw new ApiError(403, 'device_not_active', 'Support requests can only be sent from your registered phone.');
  if (!verifyP256(device.attempt_key_spki, bytes, b.signature)) throw new ApiError(401, 'bad_signature', 'This request could not be verified.');
  let p: z.infer<typeof supportPayload>;
  try {
    p = parse(supportPayload, JSON.parse(bytes.toString('utf8')));
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, 'validation_failed', 'The request was malformed.');
  }
  const nonce = await ctx.db
    .insertInto('used_nonces')
    .values({ device_id: device.id, nonce: p.nonce, expires_at: new Date(ctx.now() + NONCE_TTL_MS) })
    .onConflict((oc) => oc.doNothing())
    .returning('nonce')
    .executeTakeFirst();
  if (!nonce) throw new ApiError(409, 'replayed_nonce', 'This request was already sent.');

  const session = await ctx.db.selectFrom('attendance_sessions').selectAll().where('id', '=', p.attendance_session_id).executeTakeFirst();
  if (!session) throw new ApiError(404, 'not_found', 'No attendance for this class.');
  const cls = await loadClass(ctx.db, session.class_session_id);
  if (!cls) throw new ApiError(404, 'not_found', 'Class not found.');
  const now = ctx.now();
  // Only while the class is on (spec §7).
  if (now < cls.starts_at.getTime() - 10 * 60_000 || now > cls.ends_at.getTime()) {
    throw new ApiError(409, 'class_not_ongoing', 'Support requests can only be sent during the class. Ask your teacher or Academic Operations for a correction.');
  }
  if (!(await isExpected(ctx.db, cls.id, studentId))) throw new ApiError(403, 'not_enrolled', 'You are not on the list for this class.');
  const record = await ctx.db.selectFrom('attendance_records').select(['status', 'basis']).where('student_id', '=', studentId).where('class_session_id', '=', cls.id).executeTakeFirst();
  if (record && (record.status === 'present' || record.status === 'late')) throw new ApiError(409, 'already_marked', "You're already marked present for this class.");

  let attestation: AttemptSignals['attestation'];
  try {
    const r = await ctx.attestation.verifyRequest(device, bytes, b.attestation);
    attestation = r.result;
    if (r.newCounter !== undefined) {
      const upd = await ctx.db.updateTable('devices').set({ app_attest_counter: r.newCounter }).where('id', '=', device.id).where(sql<boolean>`app_attest_counter < ${r.newCounter}`).executeTakeFirst();
      if (upd.numUpdatedRows === 0n) throw new AttestationFailed('assertion counter replayed');
    }
  } catch (err) {
    if (err instanceof AttestationFailed) throw new ApiError(422, 'attestation_failed', 'This app or phone failed the security check.');
    throw err;
  }

  // Evidence score: the same scorers as attempts, on the facts of this request.
  const loc = evaluateLocation(p.location, await geofencesFor(ctx, cls.room_id));
  const campusNetwork = await campusNetworkResult(ctx, ip);
  const settings = await ctx.risk.load(ctx.db, now);
  const recentFlags = await ctx.db
    .selectFrom('risk_flags')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('student_id', '=', studentId)
    .where('created_at', '>=', new Date(now - 14 * 24 * 3600_000))
    .where((eb) => eb.or([eb('resolution', 'is', null), eb('resolution', '<>', 'confirmed_present')]))
    .executeTakeFirst();
  const a = assess(
    { location: loc, campusNetwork, lateInWindow: false, deviceActivatedAt: device.activated_at, attestation, recentFlags: Number(recentFlags?.n ?? 0), now: new Date(now) },
    settings,
  );
  const validTag = await ctx.db
    .selectFrom('attendance_attempts')
    .select('id')
    .where('session_id', '=', session.id)
    .where('student_id', '=', studentId)
    .where('device_id', '=', device.id)
    .where('tag_valid', '=', true)
    .limit(1)
    .executeTakeFirst();
  const evidence = await snapshotEvidence(ctx, { studentId, classSessionId: cls.id, sessionId: session.id, deviceId: device.id, request: { location: loc.result, accuracy_m: loc.accuracy_m, distance_m: loc.distance_m, is_mock: loc.is_mock, campus_network: campusNetwork, attestation }, scoreFlags: a.flags, payloadSha256: sha256Hex(bytes) });

  const id = uuidv7(now);
  try {
    await ctx.db.transaction().execute(async (tx) => {
      await tx
        .insertInto('support_requests')
        .values({
          id,
          student_id: studentId,
          class_session_id: cls.id,
          attendance_session_id: session.id,
          device_id: device.id,
          reason: p.reason,
          note: p.note,
          evidence: JSON.stringify(evidence),
          evidence_score: a.score,
          valid_tag_seen: Boolean(validTag),
        })
        .execute();
      await appendAudit(tx, { actorId: studentId, action: 'support.request', entityType: 'support_request', entityId: id, after: { class_session_id: cls.id, reason: p.reason, score: a.score, valid_tag_seen: Boolean(validTag) }, ip }, new Date(now));
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new ApiError(409, 'already_requested', 'You already asked for support for this class. Please wait.');
    throw err;
  }
  ctx.events.publish({ type: 'record', sessionId: session.id });
  return { id, status: 'pending' as const, message: 'Support requested. A verifier will check it; your teacher may be asked to confirm you are in the room.' };
}

/** The evidence snapshot a verifier sees (spec §7). Coordinates are never included. */
async function snapshotEvidence(
  ctx: AppContext,
  x: { studentId: string; classSessionId: string; sessionId: string; deviceId: string; request: Record<string, unknown>; scoreFlags: string[]; payloadSha256: string },
) {
  const [student, cls, attempts, device, flags, history] = await Promise.all([
    ctx.db
      .selectFrom('users as u')
      .leftJoin('students as s', 's.user_id', 'u.id')
      .leftJoin('section_groups as g', 'g.id', 's.group_id')
      .select(['u.name', 'u.email', 's.usn', 'g.name as batch'])
      .where('u.id', '=', x.studentId)
      .executeTakeFirstOrThrow(),
    sessionsView(ctx.db, ctx.config.timeZone).where('cs.id', '=', x.classSessionId).executeTakeFirstOrThrow(),
    ctx.db
      .selectFrom('attendance_attempts as a')
      .leftJoin('attendance_rounds as r', 'r.id', 'a.round_id')
      .select(['a.received_at', 'a.qr_round', 'r.round_no', 'a.decision', 'a.reason_codes', 'a.tag_valid', 'a.signals', 'a.risk_score', 'a.offline_queued', 'a.device_id'])
      .where('a.session_id', '=', x.sessionId)
      .where('a.student_id', '=', x.studentId)
      .orderBy('a.received_at')
      .execute(),
    ctx.db.selectFrom('devices').select(['model', 'platform', 'os_version', 'app_version', 'attestation_level', 'bound_at', 'activated_at']).where('id', '=', x.deviceId).executeTakeFirstOrThrow(),
    ctx.db
      .selectFrom('risk_flags')
      .select(['type', 'severity', 'created_at', 'resolution'])
      .where('student_id', '=', x.studentId)
      .where('created_at', '>=', new Date(ctx.now() - 30 * 24 * 3600_000))
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute(),
    sql<{ total: number; attended: number; absent: number }>`
      select count(*)::int as total,
        count(*) filter (where ar.status in ('present','late','excused'))::int as attended,
        count(*) filter (where ar.status = 'absent')::int as absent
      from attendance_records ar join class_sessions cs on cs.id = ar.class_session_id
      where ar.student_id = ${x.studentId} and cs.date >= ${new Date(ctx.now() - 30 * 24 * 3600_000).toISOString().slice(0, 10)}
        and ar.status <> 'pending'`.execute(ctx.db),
  ]);
  const h = history.rows[0] ?? { total: 0, attended: 0, absent: 0 };
  return {
    captured_at: new Date(ctx.now()).toISOString(),
    student: { name: student.name, email: student.email, usn: student.usn, batch: student.batch },
    class: presentSession(cls),
    attempts: attempts.map((a) => ({
      at: a.received_at.toISOString(),
      round: a.round_no ?? a.qr_round,
      decision: a.decision,
      reasons: a.reason_codes,
      tag_valid: a.tag_valid,
      score: a.risk_score,
      offline_queued: a.offline_queued,
      other_device: a.device_id !== x.deviceId,
      signals: a.signals,
    })),
    device: { ...device, bound_at: new Date(device.bound_at).toISOString(), activated_at: device.activated_at ? new Date(device.activated_at).toISOString() : null },
    request: x.request,
    score_factors: x.scoreFlags.map((f) => ({ code: f, text: REASON_TEXT[f] ?? f })),
    flags_30d: flags.map((f) => ({ type: f.type, text: REASON_TEXT[f.type] ?? f.type, severity: f.severity, at: f.created_at.toISOString(), resolution: f.resolution })),
    history_30d: { ...h, percent: h.total ? Math.round((h.attended / h.total) * 1000) / 10 : null },
    payload_sha256: x.payloadSha256,
  };
}

export async function mySupportRequests(ctx: AppContext, studentId: string) {
  const rows = await ctx.db
    .selectFrom('support_requests as r')
    .innerJoin('class_sessions as cs', 'cs.id', 'r.class_session_id')
    .innerJoin('course_offerings as o', 'o.id', 'cs.offering_id')
    .innerJoin('subjects as s', 's.id', 'o.subject_id')
    .select(['r.id', 'r.status', 'r.reason', 'r.created_at', 'r.decided_at', 'r.decided_role', 'r.decision_reason', 'r.class_session_id', 'r.attendance_session_id', 's.code as subject_code', 's.name as subject_name', 'cs.date'])
    .where('r.student_id', '=', studentId)
    .orderBy('r.created_at', 'desc')
    .limit(20)
    .execute();
  return { items: rows.map(presentStudentRequest) };
}

function presentStudentRequest(r: { id: string; status: string; reason: string; created_at: Date; decided_at: Date | null; decided_role: string | null; decision_reason: string | null; class_session_id: string; attendance_session_id: string; subject_code: string; subject_name: string; date: string }) {
  return {
    id: r.id,
    status: r.status,
    reason: r.reason,
    subject: { code: r.subject_code, name: r.subject_name },
    date: r.date,
    class_session_id: r.class_session_id,
    attendance_session_id: r.attendance_session_id,
    created_at: r.created_at.toISOString(),
    decided_at: r.decided_at?.toISOString() ?? null,
    // Rejection reasons are shown to the student; approvals just say who decided.
    decided_by: r.decided_role,
    decision_reason: r.status === 'rejected' ? r.decision_reason : null,
  };
}

export async function getMySupportRequest(ctx: AppContext, studentId: string, id: string) {
  const all = await mySupportRequests(ctx, studentId);
  const r = all.items.find((i) => i.id === id);
  if (!r) throw new ApiError(404, 'not_found', 'Request not found.');
  return r;
}

// ── Verifier ─────────────────────────────────────────────────────────────────

async function loadRequest(tx: Tx | AppContext['db'], id: string, lock = false) {
  let q = tx
    .selectFrom('support_requests as r')
    .innerJoin('class_sessions as cs', 'cs.id', 'r.class_session_id')
    .selectAll('r')
    .select([sql<Date>`upper(cs.time_range)`.as('class_end'), 'cs.teacher_id as class_teacher_id'])
    .where('r.id', '=', id);
  if (lock) q = q.forUpdate('r');
  const r = await q.executeTakeFirst();
  if (!r) throw new ApiError(404, 'not_found', 'Support request not found.');
  return { ...r, class_end: new Date(r.class_end) };
}

/** Why a verifier may not approve (ADR-0006), or null if approval is allowed. */
export function approvalBlock(r: { evidence_score: number; valid_tag_seen: boolean }, threshold: number): string | null {
  if (!r.valid_tag_seen) return "The student's phone never scanned a valid code in this class, so only the teacher can confirm they are in the room.";
  if (r.evidence_score >= threshold) return `The evidence score (${r.evidence_score}) is too high to approve without the teacher (limit ${threshold}).`;
  return null;
}

export async function listForVerifier(ctx: AppContext, status: 'open' | 'all' | 'pending' | 'asked_teacher' | 'approved' | 'rejected' | 'expired') {
  let q = ctx.db
    .selectFrom('support_requests as r')
    .innerJoin('users as u', 'u.id', 'r.student_id')
    .leftJoin('students as st', 'st.user_id', 'r.student_id')
    .innerJoin('class_sessions as cs', 'cs.id', 'r.class_session_id')
    .innerJoin('course_offerings as o', 'o.id', 'cs.offering_id')
    .innerJoin('subjects as s', 's.id', 'o.subject_id')
    .leftJoin('rooms as rm', 'rm.id', 'cs.room_id')
    .leftJoin('users as t', 't.id', 'cs.teacher_id')
    .select([
      'r.id', 'r.status', 'r.reason', 'r.evidence_score', 'r.valid_tag_seen', 'r.teacher_answer', 'r.created_at', 'r.decided_at',
      'u.name as student_name', 'st.usn', 's.code as subject_code', 'rm.code as room', 't.name as teacher_name', 'cs.date',
      sql<string>`to_char(lower(cs.time_range) at time zone ${ctx.config.timeZone}, 'HH24:MI')`.as('start'),
      sql<string>`to_char(upper(cs.time_range) at time zone ${ctx.config.timeZone}, 'HH24:MI')`.as('end'),
    ])
    .orderBy('r.created_at', 'desc')
    .limit(200);
  if (status === 'open') q = q.where('r.status', 'in', ['pending', 'asked_teacher']);
  else if (status !== 'all') q = q.where('r.status', '=', status);
  const settings = await ctx.risk.load(ctx.db, ctx.now());
  const threshold = num(settings, 'support_approval_threshold');
  const rows = await q.execute();
  return {
    items: rows.map((r) => ({
      ...r,
      reason_text: REASON_LABEL[r.reason],
      created_at: r.created_at.toISOString(),
      decided_at: r.decided_at?.toISOString() ?? null,
      can_approve: approvalBlock(r, threshold) === null,
    })),
  };
}

/** Evidence access is role-restricted and itself audited (spec §13). */
export async function verifierDetail(ctx: AppContext, verifierId: string, id: string, ip: string) {
  const r = await loadRequest(ctx.db, id);
  const settings = await ctx.risk.load(ctx.db, ctx.now());
  const block = approvalBlock(r, num(settings, 'support_approval_threshold'));
  await ctx.db.transaction().execute((tx) => appendAudit(tx, { actorId: verifierId, action: 'support.view_evidence', entityType: 'support_request', entityId: id, ip }, new Date(ctx.now())));
  const names = await ctx.db.selectFrom('users').select(['id', 'name']).where('id', 'in', [r.verifier_id, r.teacher_id, r.decided_by, r.class_teacher_id].filter((x): x is string => Boolean(x)).concat(['00000000-0000-0000-0000-000000000000'])).execute();
  const nameOf = (uid: string | null) => names.find((n) => n.id === uid)?.name ?? null;
  const open = r.status === 'pending' || r.status === 'asked_teacher';
  return {
    id: r.id,
    status: r.status,
    reason: r.reason,
    reason_text: REASON_LABEL[r.reason],
    note: r.note,
    evidence: r.evidence,
    evidence_score: r.evidence_score,
    valid_tag_seen: r.valid_tag_seen,
    threshold: num(settings, 'support_approval_threshold'),
    can_approve: open && block === null,
    approve_blocked_reason: block,
    can_decide: open && withinDecisionWindow(ctx, r.class_end),
    decision_deadline: new Date(r.class_end.getTime() + DECISION_GRACE_MS).toISOString(),
    teacher: { name: nameOf(r.class_teacher_id), answer: r.teacher_answer, answered_at: r.teacher_answered_at?.toISOString() ?? null },
    decided_by: nameOf(r.decided_by),
    decided_role: r.decided_role,
    decision_reason: r.decision_reason,
    created_at: r.created_at.toISOString(),
    decided_at: r.decided_at?.toISOString() ?? null,
  };
}

async function markPresent(tx: Tx, r: { student_id: string; class_session_id: string; attendance_session_id: string }, basis: 'verifier' | 'teacher', actorId: string, note: string) {
  await tx
    .insertInto('attendance_records')
    .values({ student_id: r.student_id, class_session_id: r.class_session_id, attendance_session_id: r.attendance_session_id, status: 'present', basis, updated_by: actorId, note })
    .onConflict((oc) => oc.columns(['student_id', 'class_session_id']).doUpdateSet({ status: 'present', basis, updated_by: actorId, note }))
    .execute();
}

/** Expires an open request whose decision window has passed (committed on its own, then reported). */
async function expireIfLate(ctx: AppContext, id: string): Promise<void> {
  const r = await loadRequest(ctx.db, id);
  if ((r.status === 'pending' || r.status === 'asked_teacher') && !withinDecisionWindow(ctx, r.class_end)) {
    await ctx.db
      .updateTable('support_requests')
      .set({ status: 'expired', decided_at: new Date(ctx.now()), decided_role: 'system', decision_reason: 'Class ended; use a correction' })
      .where('id', '=', id)
      .where('status', 'in', ['pending', 'asked_teacher'])
      .execute();
    throw new ApiError(409, 'expired', 'The class is over. Changes now need a correction by the teacher and Academic Operations.');
  }
}

export async function verifierDecision(ctx: AppContext, verifierId: string, id: string, action: 'approve' | 'ask_teacher' | 'reject', reason: string | null, ip: string) {
  const now = new Date(ctx.now());
  await expireIfLate(ctx, id);
  const out = await ctx.db.transaction().execute(async (tx) => {
    const r = await loadRequest(tx, id, true);
    if (r.status !== 'pending' && !(r.status === 'asked_teacher' && action === 'reject')) {
      throw new ApiError(409, 'already_decided', r.status === 'asked_teacher' ? 'Waiting for the teacher. You can still reject it.' : 'This request has already been decided.');
    }
    if (action === 'approve') {
      const settings = await ctx.risk.load(tx, ctx.now());
      const block = approvalBlock(r, num(settings, 'support_approval_threshold'));
      if (block) throw new ApiError(403, 'approval_not_allowed', block);
      const record = await tx.selectFrom('attendance_records').select(['status', 'basis']).where('student_id', '=', r.student_id).where('class_session_id', '=', r.class_session_id).executeTakeFirst();
      if (record?.basis === 'teacher' && record.status === 'absent') throw new ApiError(409, 'teacher_decided', 'The teacher has marked this student absent.');
      await markPresent(tx, r, 'verifier', verifierId, 'Support request approved');
      await tx.updateTable('support_requests').set({ status: 'approved', verifier_id: verifierId, decided_by: verifierId, decided_role: 'verifier', decided_at: now, decision_reason: reason }).where('id', '=', id).execute();
    } else if (action === 'ask_teacher') {
      if (!r.class_teacher_id) throw new ApiError(409, 'no_teacher', 'This class has no teacher assigned.');
      await tx.updateTable('support_requests').set({ status: 'asked_teacher', verifier_id: verifierId, teacher_id: r.class_teacher_id, teacher_answer: null, teacher_answered_at: null }).where('id', '=', id).execute();
    } else {
      if (!reason || reason.trim().length < 3) throw new ApiError(400, 'validation_failed', 'Please give a reason for rejecting.', { fields: { reason: 'Required' } });
      await tx.updateTable('support_requests').set({ status: 'rejected', verifier_id: verifierId, decided_by: verifierId, decided_role: 'verifier', decided_at: now, decision_reason: reason }).where('id', '=', id).execute();
    }
    await appendAudit(tx, { actorId: verifierId, action: `support.${action}`, entityType: 'support_request', entityId: id, after: { student_id: r.student_id, reason }, ip }, now);
    return r.attendance_session_id;
  });
  ctx.events.publish({ type: 'record', sessionId: out });
  return verifierDetail(ctx, verifierId, id, ip);
}

// ── Teacher ──────────────────────────────────────────────────────────────────

/** "Is {name} ({USN}) in the room?" questions waiting for this teacher. */
export async function teacherQuestions(ctx: AppContext, teacherId: string, attendanceSessionId?: string) {
  let q = ctx.db
    .selectFrom('support_requests as r')
    .innerJoin('users as u', 'u.id', 'r.student_id')
    .leftJoin('students as st', 'st.user_id', 'r.student_id')
    .leftJoin('section_groups as g', 'g.id', 'st.group_id')
    .innerJoin('class_sessions as cs', 'cs.id', 'r.class_session_id')
    .innerJoin('course_offerings as o', 'o.id', 'cs.offering_id')
    .innerJoin('subjects as s', 's.id', 'o.subject_id')
    .select(['r.id', 'r.attendance_session_id', 'r.reason', 'r.created_at', 'u.name', 'st.usn', 'g.name as batch', 's.code as subject_code'])
    .where('r.teacher_id', '=', teacherId)
    .where('r.status', '=', 'asked_teacher')
    .orderBy('r.created_at');
  if (attendanceSessionId) q = q.where('r.attendance_session_id', '=', attendanceSessionId);
  const rows = await q.execute();
  return { items: rows.map((r) => ({ ...r, reason_text: REASON_LABEL[r.reason], created_at: r.created_at.toISOString() })) };
}

export async function teacherConfirmation(ctx: AppContext, teacherId: string, id: string, answer: 'present' | 'absent' | 'not_sure', ip: string) {
  const now = new Date(ctx.now());
  await expireIfLate(ctx, id);
  const sessionId = await ctx.db.transaction().execute(async (tx) => {
    const r = await loadRequest(tx, id, true);
    if (r.teacher_id !== teacherId || r.status !== 'asked_teacher') throw new ApiError(404, 'not_found', 'There is no question waiting for you about this student.');
    const base = { teacher_answer: answer, teacher_answered_at: now };
    if (answer === 'present') {
      await markPresent(tx, r, 'teacher', teacherId, 'Confirmed in the room (support request)');
      await tx.updateTable('support_requests').set({ ...base, status: 'approved', decided_by: teacherId, decided_role: 'teacher', decided_at: now }).where('id', '=', id).execute();
    } else if (answer === 'absent') {
      await tx.updateTable('support_requests').set({ ...base, status: 'rejected', decided_by: teacherId, decided_role: 'teacher', decided_at: now, decision_reason: 'The teacher did not see you in the room.' }).where('id', '=', id).execute();
    } else {
      // Not sure: back to the verifier, who can reject or leave it.
      await tx.updateTable('support_requests').set({ ...base, status: 'pending' }).where('id', '=', id).execute();
    }
    await appendAudit(tx, { actorId: teacherId, action: 'support.teacher_confirmation', entityType: 'support_request', entityId: id, after: { student_id: r.student_id, answer }, ip }, now);
    return r.attendance_session_id;
  });
  ctx.events.publish({ type: 'record', sessionId });
  return { ok: true };
}

/** Housekeeping: open requests whose decision window has passed expire. */
export async function expireSupportRequests(ctx: AppContext): Promise<number> {
  const r = await sql<{ id: string }>`
    update support_requests r set status = 'expired', decided_at = now(), decided_role = 'system', decision_reason = 'Class ended; use a correction'
    from class_sessions cs
    where cs.id = r.class_session_id and r.status in ('pending','asked_teacher')
      and upper(cs.time_range) < ${new Date(ctx.now() - DECISION_GRACE_MS)}
    returning r.id`.execute(ctx.db);
  return r.rows.length;
}

