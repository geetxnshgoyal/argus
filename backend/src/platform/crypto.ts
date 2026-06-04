import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Security helpers. Keep this file small and fully tested. */

export function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export function fromB64url(s: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('invalid base64url');
  return Buffer.from(s, 'base64url');
}

export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

export function sha256(data: Uint8Array | string): Buffer {
  return createHash('sha256').update(data).digest();
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256(key: Uint8Array, data: Uint8Array | string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** HKDF-SHA256 with 32-byte output. */
export function hkdf32(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array | string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, typeof info === 'string' ? Buffer.from(info) : info, 32));
}

/** Constant-time comparison; false for different lengths. */
export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function safeEqualStr(a: string, b: string): boolean {
  return safeEqual(Buffer.from(a), Buffer.from(b));
}

/** AES-256-GCM: returns nonce(12) ‖ ciphertext ‖ tag(16). `aad` binds the ciphertext to its context. */
export function aesGcmEncrypt(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Buffer {
  if (key.length !== 32) throw new Error('AES-256-GCM needs a 32-byte key');
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]);
}

export function aesGcmDecrypt(key: Uint8Array, blob: Uint8Array, aad: Uint8Array): Buffer {
  if (key.length !== 32) throw new Error('AES-256-GCM needs a 32-byte key');
  if (blob.length < 28) throw new Error('ciphertext too short');
  const buf = Buffer.from(blob);
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAAD(aad);
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
}

/** Derives a purpose-specific key from the master key so one key is never used for two jobs. */
export function deriveKey(masterKey: Uint8Array, purpose: string): Buffer {
  return hkdf32(masterKey, Buffer.from('argus/v1/master'), purpose);
}
