/**
 * QR tags computed in the browser with WebCrypto (protocol §5.3), byte-for-byte
 * the same as backend/src/attendance/crypto.ts; the shared test vector in
 * test/qr.test.ts keeps them in sync.
 *
 *   tag = first12bytes(HMAC-SHA256(K_qr,r, "argus/v1/qr-tag" ‖ uuid16(session_id) ‖ u32be(r) ‖ u64be(epoch)))
 *   QR  = "argus://a/{session_id}/{r}/{epoch}/{b64url(tag)}"
 */

const PREFIX = new TextEncoder().encode('argus/v1/qr-tag');

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function uuid16(id: string): Uint8Array {
  const hex = id.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('not a UUID');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Imports the round key as a non-extractable HMAC key: script code can use it but not read it back. */
export function importRoundKey(kqr: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64urlDecode(kqr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function qrTag(key: CryptoKey, sessionId: string, round: number, epoch: number): Promise<string> {
  const msg = new Uint8Array(PREFIX.length + 16 + 4 + 8);
  msg.set(PREFIX, 0);
  msg.set(uuid16(sessionId), PREFIX.length);
  const view = new DataView(msg.buffer);
  view.setUint32(PREFIX.length + 16, round);
  view.setBigUint64(PREFIX.length + 20, BigInt(epoch));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  return b64urlEncode(mac.subarray(0, 12));
}

export function qrContent(sessionId: string, round: number, epoch: number, tag: string): string {
  return `argus://a/${sessionId}/${round}/${epoch}/${tag}`;
}

export function epochAt(serverNowMs: number, t0Ms: number, epochMs: number): number {
  return Math.floor((serverNowMs - t0Ms) / epochMs);
}
