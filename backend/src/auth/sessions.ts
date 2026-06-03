import type { Db } from '../db/index.ts';
import type { Role } from '../db/schema.ts';
import { randomToken, sha256Hex } from '../platform/crypto.ts';

/**
 * Staff web sessions: an opaque random cookie value; only its SHA-256 is
 * stored. 12 h absolute lifetime (spec §5), 2 h idle timeout.
 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
/** Sensitive actions need an IdP sign-in within this window. */
export const RECENT_AUTH_MS = 15 * 60 * 1000;

export function sessionCookieName(secure: boolean): string {
  // __Host- prefix: browser enforces Secure, Path=/ and no Domain (no subdomain can set it).
  return secure ? '__Host-argus_sid' : 'argus_sid';
}

export async function createWebSession(
  db: Db,
  userId: string,
  opts: { ip: string | null; userAgent: string | null; authAt: Date; now?: number },
): Promise<{ cookieValue: string; csrfToken: string; expiresAt: Date }> {
  const now = opts.now ?? Date.now();
  const cookieValue = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(now + SESSION_TTL_MS);
  await db
    .insertInto('web_sessions')
    .values({
      id_hash: sha256Hex(cookieValue),
      user_id: userId,
      csrf_token: csrfToken,
      auth_at: opts.authAt,
      expires_at: expiresAt,
      last_seen_at: new Date(now),
      ip: opts.ip,
      user_agent: opts.userAgent?.slice(0, 300) ?? null,
    })
    .execute();
  return { cookieValue, csrfToken, expiresAt };
}

export interface SessionUser {
  idHash: string;
  csrfToken: string;
  authAt: Date;
  user: { id: string; role: Role; name: string; email: string };
}

export async function findWebSession(db: Db, cookieValue: string, now = Date.now()): Promise<SessionUser | null> {
  if (!cookieValue || cookieValue.length > 100) return null;
  const idHash = sha256Hex(cookieValue);
  const row = await db
    .selectFrom('web_sessions as s')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .select(['s.id_hash', 's.csrf_token', 's.auth_at', 's.expires_at', 's.last_seen_at', 's.revoked_at', 'u.id', 'u.role', 'u.name', 'u.email', 'u.status'])
    .where('s.id_hash', '=', idHash)
    .executeTakeFirst();
  if (!row || row.revoked_at || row.status !== 'active') return null;
  if (row.expires_at.getTime() <= now) return null;
  if (now - row.last_seen_at.getTime() > SESSION_IDLE_MS) return null;
  // Touch at most once a minute to avoid a write per request.
  if (now - row.last_seen_at.getTime() > 60_000) {
    await db.updateTable('web_sessions').set({ last_seen_at: new Date(now) }).where('id_hash', '=', idHash).execute();
  }
  return {
    idHash,
    csrfToken: row.csrf_token,
    authAt: row.auth_at,
    user: { id: row.id, role: row.role, name: row.name, email: row.email },
  };
}

export async function revokeWebSession(db: Db, idHash: string): Promise<void> {
  await db.updateTable('web_sessions').set({ revoked_at: new Date() }).where('id_hash', '=', idHash).execute();
}

export async function revokeAllUserSessions(db: Db, userId: string): Promise<void> {
  await db
    .updateTable('web_sessions')
    .set({ revoked_at: new Date() })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
  await db
    .updateTable('refresh_tokens')
    .set({ revoked_at: new Date() })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
}
