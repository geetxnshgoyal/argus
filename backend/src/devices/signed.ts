import { z, type ZodType } from 'zod';
import { verifyP256 } from '../auth/device-sig.ts';
import { ApiError } from '../errors.ts';
import { fromB64url } from '../platform/crypto.ts';
import { parse } from '../validation.ts';

/**
 * Signed device requests (ADR-0011): the app sends the exact JCS bytes it
 * signed, base64url-encoded, next to a DER ECDSA-P256-SHA256 signature. The
 * server verifies over the received bytes first and only then parses them;
 * it never re-serializes to verify.
 */

export const signedBody = z.object({
  payload: z.string().regex(/^[A-Za-z0-9_-]+$/).max(8192),
  signature: z.string().regex(/^[A-Za-z0-9_-]+$/).max(200),
});

export function payloadBytes(b64: string): Buffer {
  try {
    return fromB64url(b64);
  } catch {
    throw new ApiError(400, 'validation_failed', 'payload must be base64url');
  }
}

/** Verifies `signature` over `bytes` with `spki`, then parses the JSON with `schema`. */
export function verifyAndParse<T>(bytes: Buffer, signature: string, spki: string, schema: ZodType<T>): T {
  if (!verifyP256(spki, bytes, signature)) throw new ApiError(401, 'bad_signature', 'The request signature is not valid for this phone.');
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ApiError(400, 'validation_failed', 'payload is not JSON');
  }
  return parse(schema, json);
}

/** Parses JSON without verifying (used to find which device's key to verify with). */
export function peekJson(bytes: Buffer): Record<string, unknown> {
  try {
    const v = JSON.parse(bytes.toString('utf8')) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new ApiError(400, 'validation_failed', 'payload is not a JSON object');
}

/** Signed actions carry a timestamp; reject stale or future ones (device clock may be off by a few minutes). */
export function assertFresh(tsMs: number, nowMs: number, skewMs = 5 * 60_000): void {
  if (!Number.isFinite(tsMs) || Math.abs(nowMs - tsMs) > skewMs) {
    throw new ApiError(401, 'stale_request', 'Your phone clock is too far off. Check the date and time settings.');
  }
}
