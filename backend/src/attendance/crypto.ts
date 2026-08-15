import { randomBytes } from 'node:crypto';
import { aesGcmDecrypt, aesGcmEncrypt, b64url, deriveKey, hkdf32, hmacSha256, safeEqual } from '../platform/crypto.ts';
import { uuidBytes } from '../platform/ids.ts';

/**
 * Attendance session cryptography (protocol.md §3, §5.3; ADR-0004, ADR-0011).
 *
 *   K_s     32 random bytes per attendance session; never leaves the server
 *   K_qr,r  = HKDF-SHA256(K_s, salt = uuid16(session_id), info = "argus/v1/qr" ‖ u32be(r))
 *   tag     = first 12 bytes of HMAC-SHA256(K_qr,r, "argus/v1/qr-tag" ‖ uuid16(session_id) ‖ u32be(r) ‖ u64be(epoch))
 *   QR      = "argus://a/{session_id}/{r}/{epoch}/{b64url(tag)}"
 */

const KS_AAD_PREFIX = Buffer.from('argus/v1/ks');
const QR_INFO_PREFIX = Buffer.from('argus/v1/qr');
const BLE_INFO = Buffer.from('argus/v1/ble');
const QR_TAG_PREFIX = Buffer.from('argus/v1/qr-tag');

export const DEFAULT_EPOCH_MS = 3000;
/** A code from the previous epoch is accepted up to this long after the boundary (spec §6 step 5). */
export const GRACE_MS = 2000;
const TAG_BYTES = 12;

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function u64be(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

export function generateKs(): Buffer {
  return randomBytes(32);
}

/** AES-256-GCM under a master-derived key; the AAD ties the ciphertext to its session. */
export function encryptKs(masterKey: Buffer, sessionId: string, ks: Buffer): Buffer {
  return aesGcmEncrypt(deriveKey(masterKey, 'argus/v1/ks-enc'), ks, Buffer.concat([KS_AAD_PREFIX, uuidBytes(sessionId)]));
}

export function decryptKs(masterKey: Buffer, sessionId: string, ciphertext: Buffer): Buffer {
  return aesGcmDecrypt(deriveKey(masterKey, 'argus/v1/ks-enc'), ciphertext, Buffer.concat([KS_AAD_PREFIX, uuidBytes(sessionId)]));
}

export function deriveKqr(ks: Buffer, sessionId: string, round: number): Buffer {
  return hkdf32(ks, uuidBytes(sessionId), Buffer.concat([QR_INFO_PREFIX, u32be(round)]));
}

/** Phase 2 hook (spec §12): BLE tokens share epochs but use their own key. */
export function deriveKble(ks: Buffer, sessionId: string): Buffer {
  return hkdf32(ks, uuidBytes(sessionId), BLE_INFO);
}

export function computeTag(kqr: Buffer, sessionId: string, round: number, epoch: number): Buffer {
  return hmacSha256(kqr, Buffer.concat([QR_TAG_PREFIX, uuidBytes(sessionId), u32be(round), u64be(epoch)])).subarray(0, TAG_BYTES);
}

export function formatQr(sessionId: string, round: number, epoch: number, tag: Buffer): string {
  return `argus://a/${sessionId}/${round}/${epoch}/${b64url(tag)}`;
}

export function currentEpoch(nowMs: number, t0Ms: number, epochMs: number = DEFAULT_EPOCH_MS): number {
  return Math.floor((nowMs - t0Ms) / epochMs);
}

export interface EpochCheck {
  valid: boolean;
  /** Accepted through the previous-epoch grace (soft signal late_in_window). */
  lateInWindow: boolean;
}

/**
 * Live window (protocol §5.5): with E = floor((received − t0)/epoch_ms), accept
 * epoch = E, or E − 1 if received − (t0 + E·epoch_ms) ≤ 2000 ms.
 */
export function checkEpochWindow(claimed: number, receivedMs: number, t0Ms: number, epochMs: number = DEFAULT_EPOCH_MS): EpochCheck {
  const e = currentEpoch(receivedMs, t0Ms, epochMs);
  if (claimed === e) return { valid: true, lateInWindow: false };
  if (claimed === e - 1 && receivedMs - (t0Ms + e * epochMs) <= GRACE_MS) return { valid: true, lateInWindow: true };
  return { valid: false, lateInWindow: false };
}

/** Offline-queued attempts (protocol §5.10): the epoch must match device_time within ±1 epoch. */
export function checkOfflineEpoch(claimed: number, deviceTimeMs: number, t0Ms: number, epochMs: number = DEFAULT_EPOCH_MS): boolean {
  return Math.abs(claimed - currentEpoch(deviceTimeMs, t0Ms, epochMs)) <= 1;
}

export function verifyTag(kqr: Buffer, sessionId: string, round: number, epoch: number, claimed: Buffer): boolean {
  return safeEqual(computeTag(kqr, sessionId, round, epoch), claimed);
}
