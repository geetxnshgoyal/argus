import ipaddr from 'ipaddr.js';
import { sql } from 'kysely';
import { z } from 'zod';
import { verifyP256 } from '../auth/device-sig.ts';
import type { AppContext } from '../context.ts';
import type { AttemptSignals, RecordStatus } from '../db/schema.ts';
import { AttestationFailed, type RequestEvidence } from '../devices/attestation/index.ts';
import { promoteDueDevices } from '../devices/service.ts';
import { payloadBytes, peekJson } from '../devices/signed.ts';
import { ApiError } from '../errors.ts';
import { evaluateLocation, type Geofence } from '../geo/geofence.ts';
import { fromB64url, sha256Hex } from '../platform/crypto.ts';
import { uuidv7 } from '../platform/ids.ts';
import { assess } from '../risk/scorers.ts';
import { num } from '../risk/settings.ts';
import { parse } from '../validation.ts';
import { checkEpochWindow, checkOfflineEpoch, deriveKqr, verifyTag } from './crypto.ts';
import { isExpected, loadClass, sessionKey } from './service.ts';

/**
 * POST /v1/attendance/attempts (spec §6, protocol §5.4–§5.6, ADR-0005 order).
 *
 * Hard checks, fail fast:
 *   1 device active and bound to the caller   2 signature over the exact bytes
 *   3 nonce unused                            4 session/round open, enrolled, targeted
 *   5 epoch window + tag                      6 not already marked this round
 *   7 attestation (outage → flag)             8 location: clearly off campus
 * Then soft signals → verified | flagged | flagged_high. Soft signals never reject.
 *
 * Attempts that fail steps 1–3 are not stored (unauthenticated or replayed);
 * from step 4 on, rejections are stored with their reason for the evidence
 * trail (support requests, ADR-0006).
 */

export const NONCE_TTL_MS = 15 * 60_000;
export const OFFLINE_MAX_AGE_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 2 * 60_000;

const evidenceSchema: z.ZodType<RequestEvidence> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('play_integrity'), token: z.string().max(20000) }),
  z.object({ kind: z.literal('app_attest'), assertion: z.string().max(20000) }),
  z.object({ kind: z.literal('missing'), error: z.string().max(200).optional() }),
  z.object({ kind: z.literal('none') }),
]);

export const attemptBody = z.object({
  payload: z.string().regex(/^[A-Za-z0-9_-]+$/).max(6000),
  signature: z.string().regex(/^[A-Za-z0-9_-]+$/).max(200),
  attestation: evidenceSchema.default({ kind: 'none' }),
});

export const attemptPayload = z.object({
  v: z.literal(1),
  session_id: z.string().uuid(),
  round: z.number().int().min(1).max(1000),
  epoch: z.number().int().min(0).max(2 ** 40),
  tag: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  device_id: z.string().uuid(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  device_time: z.string().datetime({ offset: true }),
  location: z
    .object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
      accuracy_m: z.number().min(0).max(100000),
      fix_age_ms: z.number().int().min(0),
      is_mock: z.boolean(),
    })
    .nullable(),
  signals: z.record(z.string(), z.unknown()).default({}),
  app_version: z.string().max(30),
  offline_queued: z.boolean().default(false),
});

export type AttemptPayload = z.infer<typeof attemptPayload>;

const MESSAGES: Record<string, string> = {
  device_not_active: 'This phone is not active for attendance.',
  bad_signature: 'This scan could not be verified. Please update the Argus app.',
  replayed_nonce: 'This scan was already sent.',
  session_closed: 'Attendance for this class has ended.',
  round_closed: 'This round has closed. Scan the code on the screen now.',
  not_enrolled: 'You are not on the list for this class.',
  not_targeted: "You're already verified. Nothing to do.",
  epoch_expired: 'That code expired. Point your camera at the screen and try again.',
  bad_tag: 'That is not a valid Argus code. Scan the code on the classroom screen.',
  already_marked: 'You are already marked for this round.',
  attestation_failed: 'This app or phone failed the security check. Use the official Argus app on your own phone.',
  off_campus: 'You appear to be off campus. Turn on precise location and try again in the classroom.',
  key_expired: 'This scan arrived too late to be checked.',
};

function reject(code: string, status = 422, details?: Record<string, unknown>, message?: string): never {
  throw new ApiError(status, code, message ?? MESSAGES[code] ?? 'Attendance could not be marked.', details);
}

function inCampusNetwork(ip: string, cidrs: string[]): boolean | null {
  if (cidrs.length === 0) return null;
  try {
    let addr = ipaddr.parse(ip);
    if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) addr = (addr as ipaddr.IPv6).toIPv4Address();
    return cidrs.some((c) => {
      const [range, bits] = ipaddr.parseCIDR(c);
      return range.kind() === addr.kind() && addr.match([range, bits]);
    });
  } catch {
    return false;
  }
}

export interface AttemptOutcome {
  attempt_id: string;
  decision: 'verified' | 'flagged' | 'flagged_high';
  reason_codes: string[];
  record: RecordStatus;
  message: string;
}

export async function submitAttempt(ctx: AppContext, studentId: string, body: unknown, ip: string): Promise<AttemptOutcome> {
  const receivedMs = ctx.now();
  const b = parse(attemptBody, body);
  const bytes = payloadBytes(b.payload);

  // 1. Device: exists, belongs to the caller, active (pending phones become active lazily).
  const deviceId = String(peekJson(bytes).device_id ?? '');
  await promoteDueDevices(ctx, studentId);
  const device = await ctx.db.selectFrom('devices').selectAll().where('id', '=', deviceId).where('user_id', '=', studentId).executeTakeFirst();
  if (!device || device.state !== 'active') {
    const pending = device?.state === 'pending'
      ? await ctx.db.selectFrom('device_rebind_requests').select(['eligible_at', 'needs_approval']).where('new_device_id', '=', device.id).where('status', '=', 'pending').executeTakeFirst()
      : undefined;
    reject('device_not_active', 403, { eligible_at: pending?.eligible_at?.toISOString() ?? null, needs_approval: pending?.needs_approval ?? null },
      pending ? (pending.needs_approval ? 'This phone is waiting for Academic Operations to approve it.' : `This phone becomes active for attendance on ${pending.eligible_at?.toISOString()}. Use your old phone until then.`) : 'This phone is not registered for attendance. Register it in the app first.');
  }

  // 2. Signature over the exact bytes received (ADR-0011).
  if (!verifyP256(device.attempt_key_spki, bytes, b.signature)) reject('bad_signature', 401);
  let p: AttemptPayload;
  try {
    p = parse(attemptPayload, JSON.parse(bytes.toString('utf8')));
  } catch (err) {
    if (err instanceof ApiError) throw err;
    return reject('validation_failed', 400, undefined, 'The scan was malformed.');
  }

  // 3. Nonce: single use per device.
  const nonce = await ctx.db
    .insertInto('used_nonces')
    .values({ device_id: device.id, nonce: p.nonce, expires_at: new Date(receivedMs + NONCE_TTL_MS) })
    .onConflict((oc) => oc.doNothing())
    .returning('nonce')
    .executeTakeFirst();
  if (!nonce) reject('replayed_nonce', 409);

  const session = await ctx.db.selectFrom('attendance_sessions').selectAll().where('id', '=', p.session_id).executeTakeFirst();
  if (!session) reject('session_closed');
  const deviceTimeMs = Date.parse(p.device_time);
  const payloadHash = sha256Hex(bytes);
  const offline = p.offline_queued;

  // From here on every outcome is stored.
  const store = async (decision: 'rejected' | 'verified' | 'flagged' | 'flagged_high', reasons: string[], extra: { roundId: string | null; tagValid: boolean; score?: number; signals?: AttemptSignals | null }) => {
    const id = uuidv7(receivedMs);
    await ctx.db
      .insertInto('attendance_attempts')
      .values({
        id,
        session_id: session.id,
        round_id: extra.roundId,
        student_id: studentId,
        device_id: device.id,
        received_at: new Date(receivedMs),
        device_time: Number.isFinite(deviceTimeMs) ? new Date(deviceTimeMs) : null,
        qr_round: p.round,
        qr_epoch: p.epoch,
        nonce: p.nonce,
        tag_valid: extra.tagValid,
        offline_queued: offline,
        decision,
        reason_codes: reasons,
        risk_score: extra.score ?? 0,
        signals: extra.signals ? JSON.stringify(extra.signals) : null,
        payload_sha256: payloadHash,
      })
      .execute();
    return id;
  };
  const rejectStored = async (code: string, roundId: string | null, tagValid: boolean, status = 422): Promise<never> => {
    const id = await store('rejected', [code], { roundId, tagValid });
    ctx.events.publish({ type: 'attempt', sessionId: session.id });
    return reject(code, status, { attempt_id: id });
  };

  // 4. Session and round open; enrolled; targeted.
  const round = await ctx.db.selectFrom('attendance_rounds').selectAll().where('session_id', '=', session.id).where('round_no', '=', p.round).executeTakeFirst();
  if (offline) {
    // Queued while the network was down: the round must have been open at device_time,
    // which must be recent (protocol §5.10).
    if (!Number.isFinite(deviceTimeMs) || receivedMs - deviceTimeMs > OFFLINE_MAX_AGE_MS || deviceTimeMs - receivedMs > CLOCK_SKEW_MS) return rejectStored('epoch_expired', round?.id ?? null, false);
    if (!round || deviceTimeMs < round.opened_at.getTime() || (round.closed_at && deviceTimeMs > round.closed_at.getTime())) return rejectStored('round_closed', round?.id ?? null, false);
  } else {
    if (session.status !== 'active') return rejectStored('session_closed', round?.id ?? null, false);
    if (!round || round.closed_at) return rejectStored('round_closed', round?.id ?? null, false);
  }
  if (!(await isExpected(ctx.db, session.class_session_id, studentId))) return rejectStored('not_enrolled', round.id, false, 403);
  if (round.target_student_ids && !round.target_student_ids.includes(studentId)) return rejectStored('not_targeted', round.id, false, 409);

  // 5. Epoch window and tag (constant-time). tag_valid is kept even when the window fails (ADR-0006).
  const ks = sessionKey(ctx, session);
  if (!ks) return rejectStored('key_expired', round.id, false);
  let tagValid: boolean;
  try {
    tagValid = verifyTag(deriveKqr(ks, session.id, round.round_no), session.id, round.round_no, p.epoch, fromB64url(p.tag));
  } catch {
    tagValid = false;
  }
  const t0 = Number(session.t0_ms);
  const window = offline
    ? { valid: checkOfflineEpoch(p.epoch, deviceTimeMs, t0, session.epoch_ms), lateInWindow: false }
    : checkEpochWindow(p.epoch, receivedMs, t0, session.epoch_ms);
  if (!window.valid) return rejectStored('epoch_expired', round.id, tagValid);
  if (!tagValid) return rejectStored('bad_tag', round.id, false);

  // 6. One accepted attempt per student per round.
  const existing = await ctx.db.selectFrom('attendance_attempts').select('id').where('round_id', '=', round.id).where('student_id', '=', studentId).where('decision', '<>', 'rejected').executeTakeFirst();
  if (existing) return rejectStored('already_marked', round.id, true, 409);

  // 7. Attestation bound to this payload (outage → flag, never reject).
  let attestation: AttemptSignals['attestation'];
  try {
    const r = await ctx.attestation.verifyRequest(device, bytes, b.attestation);
    attestation = r.result;
    if (r.newCounter !== undefined) {
      const upd = await ctx.db
        .updateTable('devices')
        .set({ app_attest_counter: r.newCounter })
        .where('id', '=', device.id)
        .where(sql<boolean>`app_attest_counter < ${r.newCounter}`)
        .executeTakeFirst();
      if (upd.numUpdatedRows === 0n) throw new AttestationFailed('assertion counter replayed');
    }
  } catch (err) {
    if (err instanceof AttestationFailed) {
      ctx.logger.warn({ reason: err.reason, deviceId: device.id }, 'attempt attestation failed');
      return rejectStored('attestation_failed', round.id, true);
    }
    throw err;
  }

  // 8. Location: reject only when clearly off campus.
  const cls = await loadClass(ctx.db, session.class_session_id);
  const fences = await geofencesFor(ctx, cls?.room_id ?? null);
  const loc = evaluateLocation(p.location, fences);
  const signals: AttemptSignals = {
    location: loc.result,
    accuracy_m: loc.accuracy_m,
    distance_m: loc.distance_m,
    is_mock: loc.is_mock,
    campus_network: await campusNetworkResult(ctx, ip),
    attestation,
    app_version: p.app_version,
  };
  if (loc.clearlyOff) {
    const id = await store('rejected', ['off_campus'], { roundId: round.id, tagValid: true, signals });
    ctx.events.publish({ type: 'attempt', sessionId: session.id });
    return reject('off_campus', 422, { attempt_id: id });
  }

  // Soft signals → decision.
  const settings = await ctx.risk.load(ctx.db, receivedMs);
  const recent = await ctx.db
    .selectFrom('risk_flags')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('student_id', '=', studentId)
    .where('created_at', '>=', new Date(receivedMs - 14 * 24 * 3600_000))
    .where((eb) => eb.or([eb('resolution', 'is', null), eb('resolution', '<>', 'confirmed_present')]))
    .executeTakeFirst();
  const a = assess(
    {
      location: loc,
      campusNetwork: signals.campus_network,
      lateInWindow: window.lateInWindow,
      deviceActivatedAt: device.activated_at,
      attestation,
      recentFlags: Number(recent?.n ?? 0),
      now: new Date(receivedMs),
    },
    settings,
  );
  let decision = a.decision;
  const reasons = [...a.flags];
  if (offline) {
    reasons.push('offline_queued');
    if (decision === 'verified') decision = 'flagged';
  }

  const now = new Date(receivedMs);
  const outcome = await ctx.db.transaction().execute(async (tx) => {
    const id = uuidv7(receivedMs);
    try {
      await tx
        .insertInto('attendance_attempts')
        .values({
          id,
          session_id: session.id,
          round_id: round.id,
          student_id: studentId,
          device_id: device.id,
          received_at: now,
          device_time: Number.isFinite(deviceTimeMs) ? new Date(deviceTimeMs) : null,
          qr_round: p.round,
          qr_epoch: p.epoch,
          nonce: p.nonce,
          tag_valid: true,
          offline_queued: offline,
          decision,
          reason_codes: reasons,
          risk_score: a.score,
          signals: JSON.stringify(signals),
          payload_sha256: payloadHash,
        })
        .execute();
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return null; // lost a race with another scan in the same round
      throw err;
    }

    // The official record. Teacher/verifier/correction decisions are never overwritten by scans.
    const before = await tx.selectFrom('attendance_records').selectAll().where('student_id', '=', studentId).where('class_session_id', '=', session.class_session_id).forUpdate().executeTakeFirst();
    let status: RecordStatus = before?.status ?? 'present';
    if (!before || (before.basis === 'system' && (before.status === 'absent' || before.status === 'pending'))) {
      if (offline) status = 'pending';
      else {
        const lateAfter = num(settings, 'late_after_minutes', 10) * 60_000;
        // A later round (recheck) opened well after class start marks first-time scanners late (ADR-0010).
        const late = round.round_no > 1 && cls !== undefined && round.opened_at.getTime() - cls.starts_at.getTime() > lateAfter;
        status = late ? 'late' : 'present';
      }
      await tx
        .insertInto('attendance_records')
        .values({ student_id: studentId, class_session_id: session.class_session_id, attendance_session_id: session.id, status, basis: 'system', final_attempt_id: id })
        .onConflict((oc) => oc.columns(['student_id', 'class_session_id']).doUpdateSet({ status, basis: 'system', final_attempt_id: id }))
        .execute();
    }
    if (decision === 'flagged_high' || offline) {
      await tx
        .insertInto('risk_flags')
        .values({ id: uuidv7(receivedMs), student_id: studentId, session_id: session.id, attempt_id: id, type: offline ? 'offline_queued' : 'flagged_high', severity: offline ? 'medium' : 'high', details: JSON.stringify({ reasons, score: a.score }) })
        .execute();
    }
    return { id, status };
  });
  if (!outcome) return rejectStored('already_marked', round.id, true, 409);
  ctx.events.publish({ type: 'attempt', sessionId: session.id });

  return {
    attempt_id: outcome.id,
    decision,
    reason_codes: reasons,
    record: outcome.status,
    message:
      offline ? 'Sent. Your teacher will confirm this scan.'
      : decision === 'verified' ? "You're marked present."
      : "You're marked present. Your teacher may confirm it in class.",
  };
}

/** Whether `ip` is on a campus network; null when none are configured (the signal is skipped). */
export async function campusNetworkResult(ctx: AppContext, ip: string): Promise<boolean | null> {
  const networks = (await ctx.db.selectFrom('campus_networks').select('cidr').execute()).map((n) => n.cidr);
  return inCampusNetwork(ip, networks);
}

/** The room's geofence if it has one, else every campus geofence. */
export async function geofencesFor(ctx: AppContext, roomId: string | null): Promise<Geofence[]> {
  if (roomId) {
    const room = await ctx.db
      .selectFrom('rooms as r')
      .innerJoin('campus_geofences as g', 'g.id', 'r.geofence_id')
      .select(['g.center_lat', 'g.center_lon', 'g.radius_m', 'g.polygon'])
      .where('r.id', '=', roomId)
      .executeTakeFirst();
    if (room) return [room];
  }
  return ctx.db.selectFrom('campus_geofences').select(['center_lat', 'center_lon', 'radius_m', 'polygon']).execute();
}
