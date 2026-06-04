import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562): 48-bit Unix-ms timestamp, then random bits. Time-ordered,
 * so primary-key indexes stay compact. Generated in the app because
 * Postgres 16 has no uuidv7() (ADR-0011).
 */
export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = ((b[6] as number) & 0x0f) | 0x70; // version 7
  b[8] = ((b[8] as number) & 0x3f) | 0x80; // RFC 9562 variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** The 16 raw bytes of a UUID string (protocol encodings use uuid16). */
export function uuidBytes(id: string): Buffer {
  if (!isUuid(id)) throw new Error('not a UUID');
  return Buffer.from(id.replace(/-/g, ''), 'hex');
}
