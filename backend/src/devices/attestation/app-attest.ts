import { createPublicKey, verify, X509Certificate } from 'node:crypto';
import { asOctets, asSequence, certExtension, explicit, parseDer } from '../../platform/asn1.ts';
import { asBytes, decodeCbor, mapGet } from '../../platform/cbor.ts';
import { b64url, fromB64url, safeEqual, sha256 } from '../../platform/crypto.ts';
import { AttestationFailed, b64any } from './errors.ts';

/**
 * Apple App Attest (spec §5, protocol §4/§5.4).
 * https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server
 *
 * Binding: the app attests a fresh App Attest key with
 * clientDataHash = SHA-256(bind payload bytes). We check Apple's certificate
 * chain, the nonce extension, the key id, our app id, a zero counter and the
 * environment, then keep the key's public key.
 *
 * Attempts: the app signs an assertion with clientDataHash = SHA-256(attempt
 * payload bytes). We verify it with the stored key; the counter must grow,
 * so an assertion can never be replayed.
 */

export const APP_ATTEST_NONCE_OID = '1.2.840.113635.100.8.2';
const AAGUID_PRODUCTION = Buffer.concat([Buffer.from('appattest'), Buffer.alloc(7)]);
const AAGUID_DEVELOPMENT = Buffer.from('appattestdevelop');

export interface AppAttestPolicy {
  /** "<team id>.<bundle id>" */
  appId: string;
  environment: 'production' | 'development';
}

function fail(reason: string): never {
  throw new AttestationFailed(reason);
}

/** Uncompressed X9.62 point (0x04 ‖ X ‖ Y) of a P-256 public key. */
function rawPoint(spkiDer: Buffer): Buffer {
  const jwk = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' }).export({ format: 'jwk' });
  if (jwk.crv !== 'P-256' || !jwk.x || !jwk.y) fail('key is not P-256');
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
}

export interface AppAttestationResult {
  /** SPKI DER, base64url; stored on the device record. */
  publicKeySpki: string;
  keyId: string;
}

export function verifyAppAttestation(input: {
  keyId: string;
  attestationObject: string;
  clientDataHash: Buffer;
  policy: AppAttestPolicy;
  root: X509Certificate;
  now: Date;
}): AppAttestationResult {
  let obj;
  try {
    obj = decodeCbor(b64any(input.attestationObject, 'attestation object'));
  } catch (err) {
    if (err instanceof AttestationFailed) throw err;
    fail('attestation object is not valid CBOR');
  }
  if (mapGet(obj, 'fmt') !== 'apple-appattest') fail('not an App Attest attestation');
  const attStmt = mapGet(obj, 'attStmt');
  const authData = asBytes(mapGet(obj, 'authData'), 'authData');
  const x5c = mapGet(attStmt, 'x5c');
  if (!Array.isArray(x5c) || x5c.length < 2) fail('certificate chain missing');

  let cred: X509Certificate;
  let intermediate: X509Certificate;
  try {
    cred = new X509Certificate(asBytes(x5c[0], 'x5c[0]'));
    intermediate = new X509Certificate(asBytes(x5c[1], 'x5c[1]'));
  } catch {
    fail('certificate chain is not valid X.509');
  }
  if (!cred.verify(intermediate.publicKey) || !intermediate.verify(input.root.publicKey)) fail('chain does not lead to the Apple App Attestation root');
  const now = input.now.getTime();
  for (const c of [cred, intermediate]) {
    if (new Date(c.validFrom).getTime() > now || new Date(c.validTo).getTime() < now) fail('certificate expired or not yet valid');
  }

  // Nonce: SHA-256(authData ‖ clientDataHash) must equal the extension value.
  const nonce = sha256(Buffer.concat([authData, input.clientDataHash]));
  let certNonce: Buffer;
  try {
    const ext = certExtension(cred, APP_ATTEST_NONCE_OID);
    if (!ext) fail('nonce extension missing');
    const wrapped = asSequence(parseDer(ext))[0];
    if (!wrapped) fail('nonce extension is empty');
    certNonce = asOctets(explicit(wrapped, 1));
  } catch (err) {
    if (err instanceof AttestationFailed) throw err;
    fail('nonce extension is malformed');
  }
  if (!safeEqual(nonce, certNonce)) fail('nonce does not match this request');

  const spki = cred.publicKey.export({ format: 'der', type: 'spki' });
  const keyIdBytes = sha256(rawPoint(spki));
  const claimedKeyId = b64any(input.keyId, 'key id');
  if (!safeEqual(keyIdBytes, claimedKeyId)) fail('key id does not match the attested key');

  // authData: rpIdHash(32) flags(1) counter(4) aaguid(16) credIdLen(2) credId(L) …
  if (authData.length < 55) fail('authData too short');
  if (!safeEqual(authData.subarray(0, 32), sha256(input.policy.appId))) fail('attestation is for another app');
  if (authData.readUInt32BE(33) !== 0) fail('counter must start at zero');
  const aaguid = authData.subarray(37, 53);
  const expected = input.policy.environment === 'production' ? AAGUID_PRODUCTION : AAGUID_DEVELOPMENT;
  if (!safeEqual(aaguid, expected)) fail(`attestation is not from the ${input.policy.environment} App Attest environment`);
  const credLen = authData.readUInt16BE(53);
  if (authData.length < 55 + credLen || !safeEqual(authData.subarray(55, 55 + credLen), keyIdBytes)) fail('credential id does not match the key');

  return { publicKeySpki: b64url(spki), keyId: b64url(keyIdBytes) };
}

export function verifyAppAssertion(input: {
  assertion: string;
  clientDataHash: Buffer;
  publicKeySpki: string;
  appId: string;
  previousCounter: number;
}): { counter: number } {
  let obj;
  try {
    obj = decodeCbor(b64any(input.assertion, 'assertion'));
  } catch (err) {
    if (err instanceof AttestationFailed) throw err;
    fail('assertion is not valid CBOR');
  }
  const signature = asBytes(mapGet(obj, 'signature'), 'signature');
  const authData = asBytes(mapGet(obj, 'authenticatorData'), 'authenticatorData');
  if (authData.length < 37) fail('authenticatorData too short');

  const nonce = sha256(Buffer.concat([authData, input.clientDataHash]));
  let ok: boolean;
  try {
    const key = createPublicKey({ key: fromB64url(input.publicKeySpki), format: 'der', type: 'spki' });
    ok = verify('sha256', nonce, { key, dsaEncoding: 'der' }, signature);
  } catch {
    ok = false;
  }
  if (!ok) fail('assertion signature is invalid');
  if (!safeEqual(authData.subarray(0, 32), sha256(input.appId))) fail('assertion is for another app');
  const counter = authData.readUInt32BE(33);
  if (counter <= input.previousCounter) fail('assertion counter did not increase (replay)');
  return { counter };
}
