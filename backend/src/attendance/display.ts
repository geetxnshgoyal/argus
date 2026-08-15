import { randomInt } from 'node:crypto';
import { appendAudit } from '../audit/audit.ts';
import type { AppContext } from '../context.ts';
import { ApiError } from '../errors.ts';
import { fromB64url, safeEqual, sha256, b64url } from '../platform/crypto.ts';
import { uuidv7 } from '../platform/ids.ts';
import { displayState } from './service.ts';

/**
 * Classroom display pairing (ADR-0004, protocol §5.2).
 *
 * 1. /display creates `pair_secret` in memory and registers SHA-256(secret);
 *    it shows only a short code.
 * 2. The teacher enters or scans the code in their signed-in web app and
 *    picks the attendance session.
 * 3. The display polls with its secret and receives the current round's QR
 *    key. A photographed code is useless without the teacher's session, and
 *    the secret never appears on screen.
 */

export const PAIRING_TTL_MS = 5 * 60_000;
// No 0/O/1/I/L: easy to read aloud and type.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function newCode(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

export async function createPairing(ctx: AppContext, secretHash: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secretHash)) throw new ApiError(400, 'validation_failed', 'secret_hash must be a base64url SHA-256.');
  const expiresAt = new Date(ctx.now() + PAIRING_TTL_MS);
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = uuidv7(ctx.now());
    const code = newCode();
    try {
      await ctx.db.insertInto('display_pairings').values({ id, secret_hash: secretHash, code, expires_at: expiresAt }).execute();
      return { pairing_id: id, code, expires_at: expiresAt.toISOString() };
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err;
    }
  }
  throw new ApiError(503, 'busy', 'Please try again.');
}

export async function linkPairing(ctx: AppContext, teacherId: string, sessionId: string, code: string, ip: string) {
  const s = await ctx.db.selectFrom('attendance_sessions').select(['id', 'started_by', 'status']).where('id', '=', sessionId).executeTakeFirst();
  if (!s || s.started_by !== teacherId) throw new ApiError(404, 'not_found', 'Attendance session not found.');
  if (s.status !== 'active') throw new ApiError(409, 'session_ended', 'Attendance has already ended.');
  const normalized = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const now = new Date(ctx.now());
  return ctx.db.transaction().execute(async (tx) => {
    const linked = await tx
      .updateTable('display_pairings')
      .set({ session_id: sessionId, linked_by: teacherId, linked_at: now })
      .where('code', '=', normalized)
      .where('session_id', 'is', null)
      .where('expires_at', '>', now)
      .returning('id')
      .executeTakeFirst();
    if (!linked) throw new ApiError(404, 'invalid_code', 'That code is not valid or has expired. Check the code on the classroom screen.');
    await appendAudit(tx, { actorId: teacherId, action: 'display.link', entityType: 'attendance_session', entityId: sessionId, after: { pairing_id: linked.id }, ip }, now);
    return { ok: true };
  });
}

/** Polled by the display with its in-memory secret. */
export async function pairingState(ctx: AppContext, pairingId: string, secret: string) {
  const row = await ctx.db.selectFrom('display_pairings').selectAll().where('id', '=', pairingId).executeTakeFirst();
  let secretHash: string;
  try {
    secretHash = b64url(sha256(fromB64url(secret)));
  } catch {
    throw new ApiError(403, 'forbidden', 'Not allowed.');
  }
  if (!row || !safeEqual(Buffer.from(secretHash), Buffer.from(row.secret_hash))) throw new ApiError(403, 'forbidden', 'Not allowed.');
  if (!row.session_id) {
    if (row.expires_at.getTime() <= ctx.now()) return { status: 'expired' as const };
    return { status: 'waiting' as const, code: row.code, expires_at: row.expires_at.toISOString(), server_time_ms: ctx.now() };
  }
  return displayState(ctx, row.session_id);
}
