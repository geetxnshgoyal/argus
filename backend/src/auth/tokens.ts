import { jwtVerify, SignJWT } from 'jose';
import type { Db } from '../db/index.ts';
import type { Role } from '../db/schema.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../platform/ids.ts';
import { deriveKey, randomToken, sha256Hex } from '../platform/crypto.ts';
import { verifyP256 } from './device-sig.ts';

/**
 * Mobile tokens (spec §5, ADR-0008):
 *  - access token: 15-minute JWT (HS256, key derived from the master key);
 *  - refresh token: opaque, 30 days, rotated on every use, bound to the
 *    device's session key. A refresh must be signed by that key, and reuse of
 *    an already-rotated token revokes the whole token family.
 */

export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const REFRESH_SKEW_MS = 5 * 60 * 1000;
const ISSUER = 'argus';
const AUDIENCE = 'argus-mobile';

export interface AccessClaims {
  sub: string;
  role: Role;
  fam: string;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: 'Bearer';
}

export class TokenService {
  private readonly key: Uint8Array;
  private readonly db: Db;

  constructor(masterKey: Uint8Array, db: Db) {
    this.key = deriveKey(masterKey, 'argus/v1/access-jwt');
    this.db = db;
  }

  async signAccess(c: AccessClaims, nowMs = Date.now()): Promise<string> {
    const iat = Math.floor(nowMs / 1000);
    return new SignJWT({ role: c.role, fam: c.fam })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(c.sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ACCESS_TTL_S)
      .sign(this.key);
  }

  async verifyAccess(token: string, nowMs = Date.now()): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
        currentDate: new Date(nowMs),
      });
      if (typeof payload.sub !== 'string' || typeof payload.role !== 'string' || typeof payload.fam !== 'string') return null;
      return { sub: payload.sub, role: payload.role as Role, fam: payload.fam };
    } catch {
      return null;
    }
  }

  /** Issues a new token pair in `familyId` (a new family on first sign-in). */
  async issue(user: { id: string; role: Role }, sessionKeySpki: string, familyId = uuidv7(), nowMs = Date.now()): Promise<TokenPair> {
    const refresh = randomToken(32);
    await this.db
      .insertInto('refresh_tokens')
      .values({
        id: uuidv7(nowMs),
        family_id: familyId,
        user_id: user.id,
        token_hash: sha256Hex(refresh),
        session_key_spki: sessionKeySpki,
        expires_at: new Date(nowMs + REFRESH_TTL_MS),
      })
      .execute();
    return {
      access_token: await this.signAccess({ sub: user.id, role: user.role, fam: familyId }, nowMs),
      refresh_token: refresh,
      expires_in: ACCESS_TTL_S,
      token_type: 'Bearer',
    };
  }

  /** Message a device signs to refresh: domain-separated and time-stamped. */
  static refreshMessage(refreshToken: string, ts: number): Buffer {
    return Buffer.from(`argus/v1/refresh|${refreshToken}|${ts}`);
  }

  async rotate(refreshToken: string, ts: number, signature: string, nowMs = Date.now()): Promise<TokenPair> {
    const row = await this.db
      .selectFrom('refresh_tokens as r')
      .innerJoin('users as u', 'u.id', 'r.user_id')
      .select(['r.id', 'r.family_id', 'r.session_key_spki', 'r.expires_at', 'r.used_at', 'r.revoked_at', 'u.id as user_id', 'u.role', 'u.status'])
      .where('r.token_hash', '=', sha256Hex(refreshToken))
      .executeTakeFirst();
    if (!row) throw new ApiError(401, 'invalid_refresh_token', 'Please sign in again.');

    // Possession of the device key is checked first: a stolen token without the key reveals nothing.
    if (!Number.isInteger(ts) || Math.abs(nowMs - ts) > REFRESH_SKEW_MS) {
      throw new ApiError(401, 'stale_proof', 'Device clock is too far off; check the phone date and time.');
    }
    if (!verifyP256(row.session_key_spki, TokenService.refreshMessage(refreshToken, ts), signature)) {
      throw new ApiError(401, 'bad_device_proof', 'This sign-in belongs to another device. Please sign in again.');
    }

    if (row.used_at) {
      // A rotated token came back: the family may be compromised. Revoke all of it.
      await this.revokeFamily(row.family_id, nowMs);
      throw new ApiError(401, 'refresh_reuse', 'Your session was ended for safety. Please sign in again.');
    }
    if (row.revoked_at || row.expires_at.getTime() <= nowMs || row.status !== 'active') {
      throw new ApiError(401, 'invalid_refresh_token', 'Please sign in again.');
    }

    const marked = await this.db
      .updateTable('refresh_tokens')
      .set({ used_at: new Date(nowMs) })
      .where('id', '=', row.id)
      .where('used_at', 'is', null)
      .executeTakeFirst();
    if (marked.numUpdatedRows === 0n) {
      // Lost a race with another use of the same token: treat as reuse.
      await this.revokeFamily(row.family_id, nowMs);
      throw new ApiError(401, 'refresh_reuse', 'Your session was ended for safety. Please sign in again.');
    }
    return this.issue({ id: row.user_id, role: row.role }, row.session_key_spki, row.family_id, nowMs);
  }

  async revokeFamily(familyId: string, nowMs = Date.now()): Promise<void> {
    await this.db
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date(nowMs) })
      .where('family_id', '=', familyId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  async familyActive(familyId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('refresh_tokens')
      .select('id')
      .where('family_id', '=', familyId)
      .where('revoked_at', 'is', null)
      .limit(1)
      .executeTakeFirst();
    return Boolean(row);
  }
}
