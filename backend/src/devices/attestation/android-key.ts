import { createPublicKey, X509Certificate } from 'node:crypto';
import {
  asBool,
  asEnum,
  asInt,
  asOctets,
  asSequence,
  asSet,
  certExtension,
  contextFields,
  parseDer,
  type DerNode,
} from '../../platform/asn1.ts';
import { safeEqual } from '../../platform/crypto.ts';
import { AttestationFailed, b64any } from './errors.ts';

/**
 * Android key attestation (spec §5, protocol §4 step 5).
 *
 * The phone's Keystore returns a certificate chain for a key generated with
 * `setAttestationChallenge(challenge)`. The leaf certificate carries a
 * KeyDescription extension describing the key and the device. We check that:
 *  - the chain links up to a Google attestation root (compared by public key,
 *    since Google re-issued its roots with the same keys) and no certificate
 *    is revoked or expired;
 *  - the challenge is the one we issued, and the leaf key is the key the app
 *    claims;
 *  - the key lives in a TEE or StrongBox, was generated there, is an EC P-256
 *    signing key, and (for the attempt key) needs the user to unlock;
 *  - the device booted a verified, locked OS;
 *  - the key belongs to our package, signed with our certificate.
 *
 * Reference: https://source.android.com/docs/security/features/keystore/attestation
 */

export const KEY_DESCRIPTION_OID = '1.3.6.1.4.1.11129.2.1.17';

// AuthorizationList tags (Keymaster/KeyMint).
const TAG_PURPOSE = 1;
const TAG_ALGORITHM = 2;
const TAG_EC_CURVE = 10;
const TAG_NO_AUTH_REQUIRED = 503;
const TAG_USER_AUTH_TYPE = 504;
const TAG_ORIGIN = 702;
const TAG_ROOT_OF_TRUST = 704;
const TAG_OS_PATCH_LEVEL = 706;
const TAG_ATTESTATION_APPLICATION_ID = 709;

const PURPOSE_SIGN = 2;
const ALGORITHM_EC = 3;
const CURVE_P256 = 1;
const ORIGIN_GENERATED = 0;
const BOOT_VERIFIED = 0;
const SECURITY_LEVEL = ['software', 'tee', 'strongbox'] as const;

export interface AndroidKeyPolicy {
  packageName: string;
  /** Lowercase hex SHA-256 of accepted signing certificates. Empty = not checked (dev/test only). */
  signingCertDigests: string[];
  /** The key must require device unlock / biometric before use (the attempt key). */
  requireUserAuth: boolean;
}

export interface AndroidKeyResult {
  securityLevel: 'tee' | 'strongbox';
  attestationVersion: number;
  osPatchLevel: number | null;
}

export interface AndroidKeyInput {
  /** DER certificates, leaf first, base64 or base64url. */
  chain: string[];
  challenge: Buffer;
  /** SPKI DER of the key the app claims this chain attests. */
  publicKeySpki: Buffer;
  policy: AndroidKeyPolicy;
  /** SPKI DER of trusted Google roots. */
  rootKeys: Buffer[];
  now: Date;
  /** Revoked certificate serial numbers (normalizeSerial form), from Google's status list. */
  revokedSerials?: ReadonlySet<string>;
}

function fail(reason: string): never {
  throw new AttestationFailed(reason);
}

function spkiOf(cert: X509Certificate): Buffer {
  return cert.publicKey.export({ format: 'der', type: 'spki' });
}

export function verifyAndroidKeyAttestation(input: AndroidKeyInput): AndroidKeyResult {
  if (!Array.isArray(input.chain) || input.chain.length < 2 || input.chain.length > 10) fail('certificate chain must have 2–10 certificates');
  let certs: X509Certificate[];
  try {
    certs = input.chain.map((c) => new X509Certificate(b64any(c, 'certificate')));
  } catch (err) {
    if (err instanceof AttestationFailed) throw err;
    fail('certificate chain is not valid X.509');
  }

  // ── Chain ──────────────────────────────────────────────────────────────────
  for (let i = 0; i < certs.length - 1; i++) {
    const child = certs[i] as X509Certificate;
    const parent = certs[i + 1] as X509Certificate;
    if (!child.verify(parent.publicKey)) fail(`certificate ${i} is not signed by certificate ${i + 1}`);
  }
  const root = certs[certs.length - 1] as X509Certificate;
  const rootSpki = spkiOf(root);
  if (!input.rootKeys.some((k) => safeEqual(k, rootSpki))) fail('chain does not end at a Google attestation root');
  if (!root.verify(root.publicKey)) fail('root certificate is not self-signed');

  const now = input.now.getTime();
  certs.forEach((c, i) => {
    // The leaf's notBefore is set from the phone's clock; tolerate a day of skew.
    const skew = i === 0 ? 24 * 3600_000 : 0;
    if (new Date(c.validFrom).getTime() - skew > now || new Date(c.validTo).getTime() < now) fail(`certificate ${i} is expired or not yet valid`);
    if (input.revokedSerials?.has(normalizeSerial(c.serialNumber))) fail(`certificate ${i} has been revoked by Google`);
  });

  const leaf = certs[0] as X509Certificate;
  if (!safeEqual(spkiOf(leaf), canonicalSpki(input.publicKeySpki))) fail('attested key does not match the submitted public key');

  // ── KeyDescription ─────────────────────────────────────────────────────────
  let ext: Buffer | null;
  try {
    ext = certExtension(leaf, KEY_DESCRIPTION_OID);
  } catch {
    fail('leaf certificate is malformed');
  }
  if (!ext) fail('leaf certificate has no key attestation extension');

  let kd: DerNode[];
  let sw: Map<number, DerNode>;
  let hw: Map<number, DerNode>;
  try {
    kd = asSequence(parseDer(ext));
    if (kd.length < 8) fail('key description is too short');
    sw = contextFields(kd[6] as DerNode);
    hw = contextFields(kd[7] as DerNode);
  } catch (err) {
    if (err instanceof AttestationFailed) throw err;
    fail('key description is malformed');
  }

  try {
    const attestationVersion = asInt(kd[0] as DerNode);
    const attestationLevel = asEnum(kd[1] as DerNode);
    const keymintLevel = asEnum(kd[3] as DerNode);
    const challenge = asOctets(kd[4] as DerNode);

    if (!safeEqual(challenge, input.challenge)) fail('challenge does not match');
    if (attestationLevel < 1 || keymintLevel < 1) fail('key is not stored in secure hardware');

    // Hardware-enforced properties: only these are trustworthy.
    const purposes = hw.has(TAG_PURPOSE) ? asSet(hw.get(TAG_PURPOSE) as DerNode).map((n) => asInt(n)) : [];
    if (!purposes.includes(PURPOSE_SIGN)) fail('key is not a signing key');
    if (!hw.has(TAG_ALGORITHM) || asInt(hw.get(TAG_ALGORITHM) as DerNode) !== ALGORITHM_EC) fail('key is not an EC key');
    if (!hw.has(TAG_EC_CURVE) || asInt(hw.get(TAG_EC_CURVE) as DerNode) !== CURVE_P256) fail('key is not P-256');
    if (!hw.has(TAG_ORIGIN) || asInt(hw.get(TAG_ORIGIN) as DerNode) !== ORIGIN_GENERATED) fail('key was imported, not generated in hardware');

    if (input.policy.requireUserAuth) {
      if (hw.has(TAG_NO_AUTH_REQUIRED) || sw.has(TAG_NO_AUTH_REQUIRED)) fail('key does not require the user to unlock the phone');
      if (!hw.has(TAG_USER_AUTH_TYPE)) fail('key does not require the user to unlock the phone');
    }

    const rot = hw.get(TAG_ROOT_OF_TRUST);
    if (!rot) fail('no root of trust');
    const rotFields = asSequence(rot);
    if (rotFields.length < 3) fail('root of trust is malformed');
    if (!asBool(rotFields[1] as DerNode)) fail('bootloader is unlocked');
    if (asEnum(rotFields[2] as DerNode) !== BOOT_VERIFIED) fail('operating system is not verified');

    const appIdNode = sw.get(TAG_ATTESTATION_APPLICATION_ID) ?? hw.get(TAG_ATTESTATION_APPLICATION_ID);
    if (!appIdNode) fail('no application id');
    checkApplicationId(asOctets(appIdNode), input.policy);

    const osPatch = hw.get(TAG_OS_PATCH_LEVEL);
    return {
      securityLevel: SECURITY_LEVEL[Math.min(attestationLevel, keymintLevel)] === 'strongbox' ? 'strongbox' : 'tee',
      attestationVersion,
      osPatchLevel: osPatch ? asInt(osPatch) : null,
    };
  } catch (err) {
    if (err instanceof AttestationFailed) throw err;
    fail('key description is malformed');
  }
}

function checkApplicationId(der: Buffer, policy: AndroidKeyPolicy): void {
  const [packages, digests] = asSequence(parseDer(der));
  if (!packages || !digests) fail('application id is malformed');
  const names = asSet(packages).map((p) => asOctets(asSequence(p)[0] as DerNode).toString('utf8'));
  if (!names.includes(policy.packageName)) fail(`key belongs to another app (${names.join(', ') || 'none'})`);
  if (policy.signingCertDigests.length > 0) {
    const certDigests = asSet(digests).map((d) => asOctets(d).toString('hex'));
    if (certDigests.length === 0 || !certDigests.every((d) => policy.signingCertDigests.includes(d))) {
      fail('app is not signed with the college release key');
    }
  }
}

/** Google's status list keys serials as lowercase hex without leading zeros. */
export function normalizeSerial(hex: string): string {
  return hex.toLowerCase().replace(/^0+(?=.)/, '');
}

/** Re-encodes SPKI DER so equivalent encodings compare equal. */
function canonicalSpki(der: Buffer): Buffer {
  try {
    return createPublicKey({ key: der, format: 'der', type: 'spki' }).export({ format: 'der', type: 'spki' });
  } catch {
    fail('submitted public key is invalid');
  }
}
