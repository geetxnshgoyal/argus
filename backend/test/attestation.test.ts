import { createHash, randomBytes, sign, X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyAppAssertion, verifyAppAttestation } from '../src/devices/attestation/app-attest.ts';
import { normalizeSerial, verifyAndroidKeyAttestation, type AndroidKeyInput } from '../src/devices/attestation/android-key.ts';
import { AttestationFailed } from '../src/devices/attestation/errors.ts';
import { checkPlayVerdict, type PlayVerdict } from '../src/devices/attestation/play-integrity.ts';
import { androidChain, der, ecKey, makeCert, type KeyDescriptionOptions, type TestKey } from './helpers/x509.ts';

/**
 * Spec §16 #7: debug, emulator, rooted or re-signed builds fail attestation.
 * Chains are built with a test root that the verifier is told to trust.
 */
describe('Android key attestation (spec §16 #7)', () => {
  const now = new Date('2026-09-21T04:00:00Z');
  const digest = Buffer.alloc(32, 0xab);
  const policy = { packageName: 'app.argus.argus', signingCertDigests: [digest.toString('hex')], requireUserAuth: true };

  function attest(over: Partial<KeyDescriptionOptions> & { leafSerial?: Buffer } = {}, input: Partial<AndroidKeyInput> = {}) {
    const leafKey = ecKey();
    const challenge = randomBytes(32);
    const { chain, root } = androidChain({ challenge, leafKey, now, certDigest: digest, ...over });
    return verifyAndroidKeyAttestation({ chain, challenge, publicKeySpki: leafKey.spki, policy, rootKeys: [root.spki], now, ...input });
  }
  const refused = (fn: () => unknown, reason: RegExp) => {
    expect(fn).toThrow(AttestationFailed);
    expect(fn).toThrow(reason);
  };

  it('accepts a genuine phone: hardware key, locked bootloader, verified OS, our app', () => {
    // userAuthType 2 = fingerprint/face only (ADR-0029), read from the hardware-enforced list.
    expect(attest()).toMatchObject({ securityLevel: 'tee', attestationVersion: 300, osPatchLevel: 202609, userAuthType: 2 });
    expect(attest({ securityLevel: 2 }).securityLevel).toBe('strongbox');
  });

  it('refuses an emulator (key held in software)', () => {
    refused(() => attest({ securityLevel: 0 }), /secure hardware/);
  });

  it('refuses a rooted phone: unlocked bootloader or unverified OS', () => {
    refused(() => attest({ deviceLocked: false }), /bootloader is unlocked/);
    refused(() => attest({ bootState: 2 }), /not verified/);
  });

  it('refuses a debug or re-signed build, and another app', () => {
    refused(() => attest({ certDigest: Buffer.alloc(32, 0xcd) }), /college release key/);
    refused(() => attest({ packageName: 'com.evil.clone' }), /another app/);
  });

  it('refuses imported keys, non-signing keys, and an attempt key that skips the phone lock', () => {
    refused(() => attest({ origin: 2 }), /imported/);
    refused(() => attest({ purposeSign: false }), /not a signing key/);
    refused(() => attest({ userAuth: false }), /unlock the phone/);
  });

  it('refuses a replayed challenge, a swapped key, a foreign root and a revoked certificate', () => {
    refused(() => attest({}, { challenge: randomBytes(32) }), /challenge/);
    refused(() => attest({}, { publicKeySpki: ecKey().spki }), /does not match/);
    refused(() => attest({}, { rootKeys: [ecKey().spki] }), /Google attestation root/);
    const serial = Buffer.from('00c0ffee', 'hex');
    refused(() => attest({ leafSerial: serial }, { revokedSerials: new Set([normalizeSerial('00c0ffee')]) }), /revoked/);
  });

  it('refuses a chain whose links are not signed by each other', () => {
    const leafKey = ecKey();
    const challenge = randomBytes(32);
    const a = androidChain({ challenge, leafKey, now, certDigest: digest });
    const b = androidChain({ challenge, leafKey, now, certDigest: digest });
    const mixed = [a.chain[0] as string, b.chain[1] as string, b.chain[2] as string];
    refused(() => verifyAndroidKeyAttestation({ chain: mixed, challenge, publicKeySpki: leafKey.spki, policy, rootKeys: [b.root.spki], now }), /not signed by/);
  });

  it('refuses an expired chain', () => {
    refused(() => attest({}, { now: new Date(now.getTime() + 400 * 86_400_000) }), /expired/);
  });
});

describe('Play Integrity verdict (spec §16 #7)', () => {
  const nowMs = Date.parse('2026-09-21T04:00:00Z');
  const certDigest = Buffer.alloc(32, 0xab);
  const expectOk = { packageName: 'app.argus.argus', requestHash: 'h', signingCertDigests: [certDigest.toString('hex')], nowMs };
  const verdict = (over: Partial<PlayVerdict> = {}): PlayVerdict => ({
    requestDetails: { requestPackageName: 'app.argus.argus', requestHash: 'h', timestampMillis: String(nowMs - 1000) },
    appIntegrity: { appRecognitionVerdict: 'PLAY_RECOGNIZED', packageName: 'app.argus.argus', certificateSha256Digest: [certDigest.toString('base64url')] },
    deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
    ...over,
  });

  it('accepts a Play-recognized app on a genuine phone', () => {
    expect(() => checkPlayVerdict(verdict(), expectOk)).not.toThrow();
  });

  it('refuses a rooted phone or emulator', () => {
    expect(() => checkPlayVerdict(verdict({ deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_BASIC_INTEGRITY'] } }), expectOk)).toThrow(/rooted, emulator/);
    expect(() => checkPlayVerdict(verdict({ deviceIntegrity: {} }), expectOk)).toThrow(/rooted, emulator/);
  });

  it('refuses a sideloaded or re-signed app', () => {
    expect(() => checkPlayVerdict(verdict({ appIntegrity: { appRecognitionVerdict: 'UNRECOGNIZED_VERSION', packageName: 'app.argus.argus' } }), expectOk)).toThrow(/not recognized/);
    const resigned = verdict({ appIntegrity: { appRecognitionVerdict: 'PLAY_RECOGNIZED', packageName: 'app.argus.argus', certificateSha256Digest: [Buffer.alloc(32, 1).toString('base64url')] } });
    expect(() => checkPlayVerdict(resigned, expectOk)).toThrow(/release key/);
  });

  it('refuses a token for another request, or an old one', () => {
    expect(() => checkPlayVerdict(verdict(), { ...expectOk, requestHash: 'other' })).toThrow(/not bound/);
    expect(() => checkPlayVerdict(verdict(), { ...expectOk, nowMs: nowMs + 11 * 60_000 })).toThrow(/too old/);
  });
});

// ── Apple App Attest ──────────────────────────────────────────────────────

/** Minimal CBOR encoder: maps with text keys, byte and text strings, arrays. */
type Cbor = Buffer | string | Cbor[] | { [k: string]: Cbor };
function cbor(v: Cbor): Buffer {
  const head = (major: number, n: number) =>
    n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const keys = Object.keys(v);
  return Buffer.concat([head(5, keys.length), ...keys.flatMap((k) => [cbor(k), cbor(v[k] as Cbor)])]);
}
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();
const point = (k: TestKey) => {
  const j = k.publicKey.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([4]), Buffer.from(j.x as string, 'base64url'), Buffer.from(j.y as string, 'base64url')]);
};

describe('Apple App Attest (spec §16 #7)', () => {
  const now = new Date('2026-09-21T04:00:00Z');
  const appId = 'TEAMID1234.app.argus.argus';
  const day = 86_400_000;

  function attestation(o: { appId?: string; aaguid?: Buffer; counter?: number; clientDataHash: Buffer; nonceFor?: Buffer }) {
    const root = ecKey();
    const inter = ecKey();
    const cred = ecKey();
    const keyId = sha(point(cred));
    const authData = Buffer.alloc(55 + 32);
    sha(o.appId ?? appId).copy(authData, 0);
    authData[32] = 0x40;
    authData.writeUInt32BE(o.counter ?? 0, 33);
    (o.aaguid ?? Buffer.from('appattestdevelop')).copy(authData, 37);
    authData.writeUInt16BE(32, 53);
    keyId.copy(authData, 55);
    const nonce = sha(Buffer.concat([authData, o.nonceFor ?? o.clientDataHash]));
    const from = new Date(now.getTime() - day);
    const to = new Date(now.getTime() + day);
    const rootDer = makeCert({ subject: 'Apple Root', issuer: 'Apple Root', subjectKey: root, issuerKey: root, notBefore: from, notAfter: to });
    const interDer = makeCert({ subject: 'Apple CA', issuer: 'Apple Root', subjectKey: inter, issuerKey: root, notBefore: from, notAfter: to });
    const credDer = makeCert({
      subject: 'cred', issuer: 'Apple CA', subjectKey: cred, issuerKey: inter, notBefore: from, notAfter: to,
      extensions: [{ oid: '1.2.840.113635.100.8.2', value: der.seq(der.explicit(1, der.octets(nonce))) }],
    });
    const obj = cbor({ fmt: 'apple-appattest', attStmt: { x5c: [credDer, interDer], receipt: Buffer.alloc(4) }, authData });
    return { attestationObject: obj.toString('base64'), keyId: keyId.toString('base64'), root: new X509Certificate(rootDer), cred };
  }

  const verify = (a: ReturnType<typeof attestation>, clientDataHash: Buffer, env: 'development' | 'production' = 'development') =>
    verifyAppAttestation({ keyId: a.keyId, attestationObject: a.attestationObject, clientDataHash, policy: { appId, environment: env }, root: a.root, now });

  it('accepts a genuine attestation', () => {
    const h = randomBytes(32);
    expect(verify(attestation({ clientDataHash: h }), h).keyId).toBeTruthy();
  });

  it('refuses another app, the wrong environment, a used key, a different request, a foreign root', () => {
    const h = randomBytes(32);
    expect(() => verify(attestation({ clientDataHash: h, appId: 'OTHER.app.clone' }), h)).toThrow(/another app/);
    expect(() => verify(attestation({ clientDataHash: h }), h, 'production')).toThrow(/production/);
    expect(() => verify(attestation({ clientDataHash: h, counter: 3 }), h)).toThrow(/counter/);
    expect(() => verify(attestation({ clientDataHash: h, nonceFor: randomBytes(32) }), h)).toThrow(/nonce/);
    const a = attestation({ clientDataHash: h });
    expect(() => verify({ ...a, root: attestation({ clientDataHash: h }).root }, h)).toThrow(/Apple App Attestation root/);
  });

  it('assertions: valid once, then a replay (same or lower counter) is refused', () => {
    const cred = ecKey();
    const spki = cred.spki.toString('base64url');
    const assertion = (counter: number, h: Buffer, id = appId) => {
      const authData = Buffer.alloc(37);
      sha(id).copy(authData, 0);
      authData.writeUInt32BE(counter, 33);
      const signature = sign('sha256', sha(Buffer.concat([authData, h])), cred.privateKey);
      return cbor({ signature, authenticatorData: authData }).toString('base64');
    };
    const h = randomBytes(32);
    expect(verifyAppAssertion({ assertion: assertion(5, h), clientDataHash: h, publicKeySpki: spki, appId, previousCounter: 4 })).toEqual({ counter: 5 });
    expect(() => verifyAppAssertion({ assertion: assertion(5, h), clientDataHash: h, publicKeySpki: spki, appId, previousCounter: 5 })).toThrow(/replay/);
    expect(() => verifyAppAssertion({ assertion: assertion(6, h), clientDataHash: randomBytes(32), publicKeySpki: spki, appId, previousCounter: 5 })).toThrow(/signature/);
    expect(() => verifyAppAssertion({ assertion: assertion(6, h, 'OTHER.app'), clientDataHash: h, publicKeySpki: spki, appId, previousCounter: 5 })).toThrow(/another app/);
  });
});
