import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/platform/jcs.ts';
import { isUuid, uuidBytes, uuidv7 } from '../src/platform/ids.ts';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  deriveKey,
  fromB64url,
  hkdf32,
  safeEqual,
} from '../src/platform/crypto.ts';

describe('canonicalize (RFC 8785)', () => {
  it('sorts keys and removes whitespace', () => {
    expect(canonicalize({ b: 1, a: [true, null, 'x'], c: { z: 1, y: 2 } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}',
    );
  });

  it('matches the RFC 8785 number examples', () => {
    // RFC input 333333333.33333329 parses to the same double as 333333333.3333333.
    expect(canonicalize([1e30, 4.5, 0.002, 1e-7, -0, 333333333.3333333])).toBe(
      '[1e+30,4.5,0.002,1e-7,0,333333333.3333333]',
    );
  });

  it('sorts by UTF-16 code units, not locale', () => {
    // From RFC 8785 §3.2.3: "€" (euro) sorts after "\r" and "1" and before emoji surrogates.
    // (Re-parsing can't show order: JS objects always list integer-like keys first.)
    const obj = { '€': 'Euro Sign', '\r': 'Carriage Return', '1': 'One', '😀': 'Emoji', '\u0080': 'Control' };
    expect(canonicalize(obj)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","€":"Euro Sign","😀":"Emoji"}',
    );
  });

  it('rejects non-finite numbers and skips undefined properties', () => {
    expect(() => canonicalize({ a: Number.NaN })).toThrow();
    expect(canonicalize({ a: undefined, b: 2 })).toBe('{"b":2}');
  });
});

describe('uuidv7', () => {
  it('is a valid, time-ordered v7 UUID', () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);
    expect(isUuid(a)).toBe(true);
    expect(a[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(a[19]);
    expect(a < b).toBe(true);
    expect(uuidBytes(a)).toHaveLength(16);
  });

  it('rejects malformed UUIDs', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(() => uuidBytes('123')).toThrow();
  });
});

describe('crypto helpers', () => {
  const key = Buffer.alloc(32, 1);

  it('AES-GCM round-trips and binds the associated data', () => {
    const blob = aesGcmEncrypt(key, Buffer.from('secret'), Buffer.from('ctx-A'));
    expect(aesGcmDecrypt(key, blob, Buffer.from('ctx-A')).toString()).toBe('secret');
    expect(() => aesGcmDecrypt(key, blob, Buffer.from('ctx-B'))).toThrow();
  });

  it('AES-GCM detects tampering and wrong keys', () => {
    const blob = aesGcmEncrypt(key, Buffer.from('secret'), Buffer.from('ctx'));
    const tampered = Buffer.from(blob);
    tampered[15] = (tampered[15] as number) ^ 1;
    expect(() => aesGcmDecrypt(key, tampered, Buffer.from('ctx'))).toThrow();
    expect(() => aesGcmDecrypt(Buffer.alloc(32, 2), blob, Buffer.from('ctx'))).toThrow();
  });

  it('HKDF matches RFC 5869 test case 1 (first 32 bytes)', () => {
    const ikm = Buffer.alloc(22, 0x0b);
    const salt = Buffer.from('000102030405060708090a0b0c', 'hex');
    const info = Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex');
    expect(hkdf32(ikm, salt, info).toString('hex')).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf',
    );
  });

  it('derives distinct keys per purpose', () => {
    expect(deriveKey(key, 'jwt').equals(deriveKey(key, 'ks'))).toBe(false);
    expect(deriveKey(key, 'jwt').equals(deriveKey(key, 'jwt'))).toBe(true);
  });

  it('safeEqual handles length mismatch and base64url validation', () => {
    expect(safeEqual(Buffer.from('ab'), Buffer.from('abc'))).toBe(false);
    expect(() => fromB64url('abc+/')).toThrow();
  });
});
