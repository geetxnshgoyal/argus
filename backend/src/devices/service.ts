import { sql, type Selectable } from 'kysely';
import { z } from 'zod';
import { appendAudit } from '../audit/audit.ts';
import { parseP256Spki, verifyP256 } from '../auth/device-sig.ts';
import type { AppContext } from '../context.ts';
import type { DbOrTx, Tx } from '../db/index.ts';
import type { DevicesTable } from '../db/schema.ts';
import { ApiError } from '../errors.ts';
import { deriveKey, fromB64url, hmacSha256, randomToken, sha256Hex } from '../platform/crypto.ts';
import { uuidv7 } from '../platform/ids.ts';
import { parse } from '../validation.ts';
import { AttestationFailed, AttestationUnavailable, type BindEvidence } from './attestation/index.ts';
import { payloadBytes } from './signed.ts';

/**
 * Device binding policy (spec §5, protocol §4, ADR-0007/0008/0009).
 *
 *  - First phone: active immediately (unless the phone was recently another
 *    student's, then Acad Ops must approve).
 *  - Another phone: a rebind request. The old phone stays active until the
 *    new one becomes eligible (48 h, configurable) or Acad Ops approves after
 *    an ID check. The old phone can cancel ("This wasn't me").
 *  - The same phone again (same ANDROID_ID hash, or the same hardware session key, e.g.
 *    re-registering after the attempt key was lost): replaces the old binding immediately.
 *  - A phone that is actively bound to another student cannot be bound.
 *  - At most N rebinds per term (default 2); cancelled or rejected ones don't count.
 */

export const CHALLENGE_TTL_MS = 5 * 60_000;
export const PREVIOUS_OWNER_WINDOW_MS = 180 * 24 * 3600_000;

export const bindPayloadSchema = z.object({
  v: z.literal(1),
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  session_pub: z.string().max(300),
  attempt_pub: z.string().max(300),
  platform: z.enum(['android', 'ios']),
  model: z.string().max(100).default(''),
  os_version: z.string().max(50).default(''),
  app_version: z.string().max(30).default(''),
  android_id: z.string().max(64).optional(),
});

export const bindEvidenceSchema: z.ZodType<BindEvidence> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('android'), attempt_key_chain: z.array(z.string().max(8192)).min(2).max(10), play_integrity_token: z.string().max(20000).optional() }),
  z.object({ kind: z.literal('ios'), app_attest_key_id: z.string().max(100), attestation_object: z.string().max(20000), devicecheck_token: z.string().max(10000).optional() }),
  z.object({ kind: z.literal('dev_bypass') }),
]);

export const bindBodySchema = z.object({
  payload: z.string().regex(/^[A-Za-z0-9_-]+$/).max(8192),
  session_signature: z.string().regex(/^[A-Za-z0-9_-]+$/).max(200),
  attempt_signature: z.string().regex(/^[A-Za-z0-9_-]+$/).max(200),
  evidence: bindEvidenceSchema,
});

type Device = Selectable<DevicesTable>;

export function hardwareIdHash(ctx: AppContext, androidId: string): string {
  return hmacSha256(deriveKey(ctx.config.masterKey, 'argus/v1/android-id'), androidId).toString('hex');
}

export async function newBindChallenge(ctx: AppContext, userId: string): Promise<{ challenge: string; expires_at: string }> {
  const challenge = randomToken(32);
  const expiresAt = new Date(ctx.now() + CHALLENGE_TTL_MS);
  await ctx.db.insertInto('device_bind_challenges').values({ challenge_hash: sha256Hex(fromB64url(challenge)), user_id: userId, expires_at: expiresAt }).execute();
  return { challenge, expires_at: expiresAt.toISOString() };
}

/** Promotes pending phones whose cooldown has passed (lazily on requests, and by the housekeeping job). */
export async function promoteDueDevices(ctx: AppContext, userId?: string): Promise<number> {
  let q = ctx.db
    .selectFrom('device_rebind_requests')
    .select(['id', 'user_id', 'old_device_id', 'new_device_id'])
    .where('status', '=', 'pending')
    .where('needs_approval', '=', false)
    .where('eligible_at', '<=', new Date(ctx.now()));
  if (userId) q = q.where('user_id', '=', userId);
  const due = await q.execute();
  for (const r of due) {
    await ctx.db.transaction().execute(async (tx) => {
      const claimed = await tx
        .updateTable('device_rebind_requests')
        .set({ status: 'completed', decided_at: new Date(ctx.now()), decision_note: 'Waiting period passed' })
        .where('id', '=', r.id)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      if (claimed.numUpdatedRows === 0n) return;
      await activate(tx, ctx, r.user_id, r.new_device_id, 'replaced');
      await appendAudit(tx, { actorId: null, action: 'device.activate', entityType: 'device', entityId: r.new_device_id, after: { request_id: r.id, reason: 'cooldown_passed' } }, new Date(ctx.now()));
    });
  }
  return due.length;
}

/** Makes `deviceId` the user's active phone, revoking the previous active one. */
async function activate(tx: Tx, ctx: AppContext, userId: string, deviceId: string, revokeReason: string): Promise<void> {
  const now = new Date(ctx.now());
  await tx
    .updateTable('devices')
    .set({ state: 'revoked', revoked_at: now, revoke_reason: revokeReason })
    .where('user_id', '=', userId)
    .where('state', '=', 'active')
    .execute();
  await tx.updateTable('devices').set({ state: 'active', activated_at: now }).where('id', '=', deviceId).execute();
}

async function rebindsUsed(db: DbOrTx, ctx: AppContext, userId: string): Promise<number> {
  // Counted within the student's current term (fallback: the last 180 days).
  const term = await db
    .selectFrom('students as s')
    .innerJoin('sections as sec', 'sec.id', 's.section_id')
    .innerJoin('terms as t', 't.id', 'sec.term_id')
    .select('t.start_date')
    .where('s.user_id', '=', userId)
    .executeTakeFirst();
  const since = term ? new Date(`${term.start_date}T00:00:00Z`) : new Date(ctx.now() - PREVIOUS_OWNER_WINDOW_MS);
  const r = await db
    .selectFrom('device_rebind_requests')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('user_id', '=', userId)
    .where('old_device_id', 'is not', null)
    .where('status', 'in', ['pending', 'completed', 'approved'])
    .where('created_at', '>=', since)
    .executeTakeFirst();
  return Number(r?.n ?? 0);
}

export interface BindOutcome {
  device_id: string;
  state: 'active' | 'pending';
  eligible_at: string | null;
  needs_approval: boolean;
  message: string;
}

export async function bindDevice(ctx: AppContext, user: { id: string; tokenFamily?: string | undefined }, body: unknown, ip: string): Promise<BindOutcome> {
  const b = parse(bindBodySchema, body);
  const bytes = payloadBytes(b.payload);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ApiError(400, 'validation_failed', 'payload is not JSON');
  }
  const p = parse(bindPayloadSchema, raw);
  try {
    parseP256Spki(p.session_pub);
    parseP256Spki(p.attempt_pub);
  } catch {
    throw new ApiError(400, 'validation_failed', 'Keys must be EC P-256 public keys.');
  }

  // The session key must be the one this sign-in is bound to (ADR-0016).
  if (!user.tokenFamily) throw new ApiError(403, 'forbidden', 'Register your phone from the Argus app.');
  const fam = await ctx.db
    .selectFrom('refresh_tokens')
    .select('session_key_spki')
    .where('family_id', '=', user.tokenFamily)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!fam || fam.session_key_spki !== p.session_pub) throw new ApiError(401, 'bad_device_proof', 'This sign-in belongs to another phone. Please sign in again.');
  if (!verifyP256(p.session_pub, bytes, b.session_signature) || !verifyP256(p.attempt_pub, bytes, b.attempt_signature)) {
    throw new ApiError(401, 'bad_signature', 'Phone registration could not be verified. Please try again.');
  }

  const used = await ctx.db
    .updateTable('device_bind_challenges')
    .set({ used_at: new Date(ctx.now()) })
    .where('challenge_hash', '=', sha256Hex(fromB64url(p.challenge)))
    .where('user_id', '=', user.id)
    .where('used_at', 'is', null)
    .where('expires_at', '>', new Date(ctx.now()))
    .executeTakeFirst();
  if (used.numUpdatedRows === 0n) throw new ApiError(400, 'challenge_invalid', 'Registration took too long. Please try again.');

  if (b.evidence.kind !== 'dev_bypass' && b.evidence.kind !== p.platform) throw new ApiError(400, 'validation_failed', 'Evidence does not match the platform.');
  let att;
  try {
    att = await ctx.attestation.verifyBind({ platform: p.platform, evidence: b.evidence, payload: bytes, challenge: fromB64url(p.challenge), attemptKeySpki: fromB64url(p.attempt_pub) });
  } catch (err) {
    if (err instanceof AttestationFailed) {
      await ctx.db.transaction().execute((tx) =>
        appendAudit(tx, { actorId: user.id, action: 'device.bind_refused', entityType: 'user', entityId: user.id, after: { reason: err.reason, platform: p.platform }, ip }, new Date(ctx.now())),
      );
      throw new ApiError(422, 'attestation_failed', `This phone or app could not be verified: ${err.reason}.`);
    }
    if (err instanceof AttestationUnavailable) throw new ApiError(503, 'attestation_unavailable', 'Phone verification is unavailable right now. Please try again in a few minutes.');
    throw err;
  }

  const hwHash = p.platform === 'android' && p.android_id ? hardwareIdHash(ctx, p.android_id) : null;
  const now = new Date(ctx.now());

  const outcome = await ctx.db.transaction().execute(async (tx) => {
    // Serialize bindings per student.
    await sql`select pg_advisory_xact_lock(hashtext(${`bind:${user.id}`}))`.execute(tx);
    const mine = await tx.selectFrom('devices').selectAll().where('user_id', '=', user.id).execute();
    const active = mine.find((d) => d.state === 'active');
    const pending = mine.find((d) => d.state === 'pending');

    let approvalReason: string | null = null;
    // The session key never leaves the phone's secure hardware, so the same key means the same
    // phone and app install. Another student's registration on it = two accounts on one phone.
    const sameInstall = await tx
      .selectFrom('devices')
      .select('user_id')
      .where('session_key_spki', '=', p.session_pub)
      .where('state', '<>', 'revoked')
      .where('user_id', '<>', user.id)
      .executeTakeFirst();
    if (sameInstall) throw new ApiError(409, 'device_in_use', 'This phone is already registered to another student. Each student needs their own phone.');
    if (hwHash) {
      const others = await tx
        .selectFrom('devices')
        .select(['state', 'revoked_at'])
        .where('hardware_id_hash', '=', hwHash)
        .where('user_id', '<>', user.id)
        .execute();
      if (others.some((d) => d.state !== 'revoked')) {
        throw new ApiError(409, 'device_in_use', 'This phone is already registered to another student. Each student needs their own phone.');
      }
      if (others.some((d) => d.revoked_at && now.getTime() - d.revoked_at.getTime() < PREVIOUS_OWNER_WINDOW_MS)) {
        approvalReason = 'This phone was registered to another student in the last 6 months.';
      }
    }
    if (att.deviceCheckSeen && !mine.some((d) => d.platform === 'ios')) {
      approvalReason = 'This iPhone was registered to an Argus account before.';
    }

    const samePhone = Boolean(active && ((hwHash && active.hardware_id_hash === hwHash) || active.session_key_spki === p.session_pub));
    const isRebind = Boolean(active) && !samePhone;
    if (isRebind && (await rebindsUsed(tx, ctx, user.id)) >= ctx.config.devices.maxRebindsPerTerm) {
      throw new ApiError(409, 'rebind_limit', 'You have changed phones too many times this term. Please visit Academic Operations.');
    }

    // A newer registration replaces an older pending one.
    if (pending) {
      await tx.updateTable('devices').set({ state: 'revoked', revoked_at: now, revoke_reason: 'superseded' }).where('id', '=', pending.id).execute();
      await tx
        .updateTable('device_rebind_requests')
        .set({ status: 'cancelled', decided_at: now, decision_note: 'Replaced by a newer registration' })
        .where('new_device_id', '=', pending.id)
        .where('status', '=', 'pending')
        .execute();
    }

    const deviceId = uuidv7(ctx.now());
    const immediate = !approvalReason && (!active || samePhone);
    await tx
      .insertInto('devices')
      .values({
        id: deviceId,
        user_id: user.id,
        state: 'pending',
        platform: p.platform,
        model: p.model,
        os_version: p.os_version,
        app_version: p.app_version,
        session_key_spki: p.session_pub,
        attempt_key_spki: p.attempt_pub,
        attestation_level: att.level,
        hardware_id_hash: hwHash,
        app_attest_key_id: att.appAttest?.keyId ?? null,
        app_attest_public_key: att.appAttest?.publicKeySpki ?? null,
        bound_at: now,
      })
      .execute()
      .catch((err: { code?: string }) => {
        if (err.code === '23505') throw new ApiError(409, 'key_reused', 'These phone keys are already registered. Please reinstall the app.');
        throw err;
      });

    if (immediate) {
      await activate(tx, ctx, user.id, deviceId, samePhone ? 'reinstalled' : 'replaced');
      await appendAudit(tx, { actorId: user.id, action: 'device.bind', entityType: 'device', entityId: deviceId, after: { platform: p.platform, model: p.model, level: att.level, same_phone: samePhone }, ip }, now);
      return { device_id: deviceId, state: 'active' as const, eligible_at: null, needs_approval: false, message: 'This phone is now registered for attendance.' };
    }

    const eligibleAt = approvalReason ? null : new Date(ctx.now() + ctx.config.devices.rebindCooldownMs);
    const requestId = uuidv7(ctx.now());
    await tx
      .insertInto('device_rebind_requests')
      .values({
        id: requestId,
        user_id: user.id,
        old_device_id: active?.id ?? null,
        new_device_id: deviceId,
        eligible_at: eligibleAt,
        needs_approval: Boolean(approvalReason),
        approval_reason: approvalReason,
      })
      .execute();
    await appendAudit(tx, { actorId: user.id, action: 'device.rebind_request', entityType: 'device', entityId: deviceId, after: { request_id: requestId, platform: p.platform, model: p.model, level: att.level, eligible_at: eligibleAt, approval_reason: approvalReason }, ip }, now);
    return {
      device_id: deviceId,
      state: 'pending' as const,
      eligible_at: eligibleAt?.toISOString() ?? null,
      needs_approval: Boolean(approvalReason),
      message: approvalReason
        ? `${approvalReason} Academic Operations must approve it after checking your ID.`
        : `Your new phone will be ready for attendance on ${eligibleAt?.toISOString()}. Your old phone keeps working until then, or visit Academic Operations to activate it sooner.`,
    };
  });

  if (b.evidence.kind === 'ios' && (await ctx.attestation.markIosDevice(b.evidence.devicecheck_token))) {
    await ctx.db.updateTable('devices').set({ devicecheck_marked: true }).where('id', '=', outcome.device_id).execute();
  }
  return outcome;
}

export function presentDevice(d: Pick<Device, 'id' | 'state' | 'platform' | 'model' | 'os_version' | 'app_version' | 'attestation_level' | 'bound_at' | 'activated_at' | 'revoked_at' | 'revoke_reason'>) {
  return {
    id: d.id,
    state: d.state,
    platform: d.platform,
    model: d.model,
    os_version: d.os_version,
    app_version: d.app_version,
    attestation_level: d.attestation_level,
    bound_at: new Date(d.bound_at).toISOString(),
    activated_at: d.activated_at ? new Date(d.activated_at).toISOString() : null,
    revoked_at: d.revoked_at ? new Date(d.revoked_at).toISOString() : null,
    revoke_reason: d.revoke_reason,
  };
}

export async function myDevices(ctx: AppContext, user: { id: string; tokenFamily?: string | undefined }) {
  await promoteDueDevices(ctx, user.id);
  const devices = await ctx.db.selectFrom('devices').selectAll().where('user_id', '=', user.id).where('state', '<>', 'revoked').orderBy('bound_at', 'desc').execute();
  const fam = user.tokenFamily
    ? await ctx.db.selectFrom('refresh_tokens').select('session_key_spki').where('family_id', '=', user.tokenFamily).orderBy('created_at', 'desc').limit(1).executeTakeFirst()
    : undefined;
  const request = await ctx.db
    .selectFrom('device_rebind_requests')
    .select(['id', 'old_device_id', 'new_device_id', 'eligible_at', 'needs_approval', 'approval_reason', 'created_at'])
    .where('user_id', '=', user.id)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  const thisDevice = devices.find((d) => fam && d.session_key_spki === fam.session_key_spki);
  return {
    this_device_id: thisDevice?.id ?? null,
    devices: devices.map(presentDevice),
    rebind: request
      ? {
          id: request.id,
          old_device_id: request.old_device_id,
          new_device_id: request.new_device_id,
          eligible_at: request.eligible_at?.toISOString() ?? null,
          needs_approval: request.needs_approval,
          approval_reason: request.approval_reason,
          created_at: request.created_at.toISOString(),
        }
      : null,
    rebinds_used: await rebindsUsed(ctx.db, ctx, user.id),
    max_rebinds: ctx.config.devices.maxRebindsPerTerm,
  };
}

/** Decides a pending request as Acad Ops (approve = activate now, after an ID check; reject = discard the new phone). */
export async function decideRebind(ctx: AppContext, actorId: string, requestId: string, decision: 'approve' | 'reject', note: string, ip: string) {
  return ctx.db.transaction().execute(async (tx) => {
    const r = await tx.selectFrom('device_rebind_requests').selectAll().where('id', '=', requestId).forUpdate().executeTakeFirst();
    if (!r) throw new ApiError(404, 'not_found', 'Request not found.');
    if (r.status !== 'pending') throw new ApiError(409, 'already_decided', 'This request has already been decided.');
    const now = new Date(ctx.now());
    await tx
      .updateTable('device_rebind_requests')
      .set({ status: decision === 'approve' ? 'approved' : 'rejected', decided_by: actorId, decided_at: now, decision_note: note })
      .where('id', '=', requestId)
      .execute();
    if (decision === 'approve') await activate(tx, ctx, r.user_id, r.new_device_id, 'replaced');
    else await tx.updateTable('devices').set({ state: 'revoked', revoked_at: now, revoke_reason: 'rebind_rejected' }).where('id', '=', r.new_device_id).execute();
    await appendAudit(tx, { actorId, action: `device.rebind_${decision}`, entityType: 'device', entityId: r.new_device_id, after: { request_id: requestId, user_id: r.user_id, note }, ip }, now);
    return { ok: true as const };
  });
}

export async function revokeDevice(ctx: AppContext, actorId: string | null, deviceId: string, reason: string, ip: string, tx?: Tx) {
  const run = async (t: Tx) => {
    const d = await t.selectFrom('devices').select(['id', 'user_id', 'state']).where('id', '=', deviceId).forUpdate().executeTakeFirst();
    if (!d) throw new ApiError(404, 'not_found', 'Phone not found.');
    if (d.state === 'revoked') return { ok: true as const };
    const now = new Date(ctx.now());
    await t.updateTable('devices').set({ state: 'revoked', revoked_at: now, revoke_reason: reason }).where('id', '=', deviceId).execute();
    if (d.state === 'pending') {
      await t.updateTable('device_rebind_requests').set({ status: 'cancelled', decided_by: actorId, decided_at: now, decision_note: reason }).where('new_device_id', '=', deviceId).where('status', '=', 'pending').execute();
    }
    await appendAudit(t, { actorId, action: 'device.revoke', entityType: 'device', entityId: deviceId, after: { user_id: d.user_id, reason }, ip }, now);
    return { ok: true as const };
  };
  return tx ? run(tx) : ctx.db.transaction().execute(run);
}
