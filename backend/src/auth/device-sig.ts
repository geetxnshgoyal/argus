import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { fromB64url } from '../platform/crypto.ts';

/**
 * Verification of signatures made by phone hardware keys: ECDSA P-256 with
 * SHA-256, DER-encoded (Android `SHA256withECDSA`, iOS
 * `ecdsaSignatureMessageX962SHA256`). Public keys travel as base64url SPKI DER.
 */

export function parseP256Spki(spkiB64url: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: fromB64url(spkiB64url), format: 'der', type: 'spki' });
  } catch {
    throw new Error('invalid public key');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('public key must be EC P-256');
  }
  return key;
}

/** True only for a valid signature; never throws on malformed input. */
export function verifyP256(spkiB64url: string, message: Uint8Array, signatureB64url: string): boolean {
  try {
    const key = parseP256Spki(spkiB64url);
    const sig = fromB64url(signatureB64url);
    if (sig.length < 8 || sig.length > 80) return false;
    return verify('sha256', message, { key, dsaEncoding: 'der' }, sig);
  } catch {
    return false;
  }
}
