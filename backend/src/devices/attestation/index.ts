import { X509Certificate } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../../config.ts';
import { b64url, sha256 } from '../../platform/crypto.ts';
import { verifyAndroidKeyAttestation, normalizeSerial } from './android-key.ts';
import { verifyAppAssertion, verifyAppAttestation } from './app-attest.ts';
import { AppleDeviceCheck, type DeviceCheck } from './devicecheck.ts';
import { AttestationFailed, AttestationUnavailable } from './errors.ts';
import { checkPlayVerdict, GooglePlayIntegrity, type PlayIntegrityDecoder } from './play-integrity.ts';
import { APPLE_APP_ATTEST_ROOT_PEM, GOOGLE_ATTESTATION_ROOTS_PEM } from './roots.ts';

export { AttestationFailed, AttestationUnavailable };

/** Evidence the app sends when binding (protocol §4). */
export type BindEvidence =
  | { kind: 'android'; attempt_key_chain: string[]; play_integrity_token?: string | undefined }
  | { kind: 'ios'; app_attest_key_id: string; attestation_object: string; devicecheck_token?: string | undefined }
  | { kind: 'dev_bypass' };

/** Evidence attached to an attempt or other signed request (protocol §5.4). */
export type RequestEvidence =
  | { kind: 'play_integrity'; token: string }
  | { kind: 'app_attest'; assertion: string }
  /** The app could not get a token (e.g. Play services error); flagged, not rejected. */
  | { kind: 'missing'; error?: string | undefined }
  | { kind: 'none' };

export interface BindResult {
  level: 'strongbox' | 'tee' | 'app_attest' | 'dev_bypass';
  appAttest?: { keyId: string; publicKeySpki: string };
  /** iOS: DeviceCheck bit0 was already set (phone bound to an Argus account before). */
  deviceCheckSeen?: boolean;
}

export type RequestAttestation = { result: 'ok' | 'unavailable' | 'missing' | 'bypass'; newCounter?: number };

export interface AttestationDeps {
  play?: PlayIntegrityDecoder | null;
  deviceCheck?: DeviceCheck | null;
  androidRootKeys?: Buffer[];
  appleRoot?: X509Certificate;
  /** Google's attestation revocation list; defaults to fetching it daily. */
  revokedSerials?: () => Promise<ReadonlySet<string>>;
  now?: () => number;
}

const STATUS_URL = 'https://android.googleapis.com/attestation/status';

/**
 * Checks device evidence against Google/Apple. Policy (who may bind, rebind
 * cooldowns) lives in devices/service.ts; this class only answers "is this
 * evidence genuine and bound to these exact bytes?".
 */
export class AttestationService {
  private readonly config: Config;
  private readonly logger: FastifyBaseLogger;
  private readonly play: PlayIntegrityDecoder | null;
  private readonly deviceCheck: DeviceCheck | null;
  private readonly androidRootKeys: Buffer[];
  private readonly appleRoot: X509Certificate;
  private readonly revoked: () => Promise<ReadonlySet<string>>;
  private readonly now: () => number;
  private revokedCache: { at: number; set: ReadonlySet<string> } | null = null;

  constructor(config: Config, logger: FastifyBaseLogger, deps: AttestationDeps = {}) {
    this.config = config;
    this.logger = logger;
    this.now = deps.now ?? Date.now;
    const a = config.attestation;
    this.play =
      deps.play !== undefined
        ? deps.play
        : a.android.playIntegrityCredentialsPath
          ? new GooglePlayIntegrity({ credentialsPath: a.android.playIntegrityCredentialsPath, packageName: a.android.packageName })
          : null;
    this.deviceCheck =
      deps.deviceCheck !== undefined
        ? deps.deviceCheck
        : a.ios.deviceCheckKeyId && a.ios.deviceCheckKeyPath && a.ios.appId
          ? new AppleDeviceCheck({
              teamId: a.ios.appId.split('.')[0] as string,
              keyId: a.ios.deviceCheckKeyId,
              keyPath: a.ios.deviceCheckKeyPath,
              environment: a.ios.environment,
            })
          : null;
    this.androidRootKeys = deps.androidRootKeys ?? GOOGLE_ATTESTATION_ROOTS_PEM.map((p) => new X509Certificate(p).publicKey.export({ format: 'der', type: 'spki' }));
    this.appleRoot = deps.appleRoot ?? new X509Certificate(APPLE_APP_ATTEST_ROOT_PEM);
    this.revoked = deps.revokedSerials ?? (() => this.fetchRevoked());
  }

  private get strict(): boolean {
    return this.config.env === 'staging' || this.config.env === 'production';
  }

  get bypassAllowed(): boolean {
    return this.config.attestationBypass && this.config.env === 'dev';
  }

  /** Whether phones of this platform can be bound with real attestation on this server. */
  platformReady(platform: 'android' | 'ios'): { ok: true } | { ok: false; reason: string } {
    const a = this.config.attestation;
    if (platform === 'android') {
      if (this.strict && (a.android.signingCertDigests.length === 0 || !this.play)) {
        return { ok: false, reason: 'Android phones cannot be registered yet: the server is missing its Play Integrity settings.' };
      }
      return { ok: true };
    }
    if (!a.ios.appId) return { ok: false, reason: 'iPhones cannot be registered yet: the server is missing its App Attest settings.' };
    return { ok: true };
  }

  async verifyBind(input: { platform: 'android' | 'ios'; evidence: BindEvidence; payload: Buffer; challenge: Buffer; attemptKeySpki: Buffer }): Promise<BindResult> {
    const { evidence } = input;
    if (evidence.kind === 'dev_bypass') {
      if (!this.bypassAllowed) throw new AttestationFailed('development builds cannot register on this server');
      return { level: 'dev_bypass' };
    }
    const ready = this.platformReady(input.platform);
    if (!ready.ok) throw new AttestationUnavailable(ready.reason);

    if (input.platform === 'android') {
      if (evidence.kind !== 'android') throw new AttestationFailed('Android evidence expected');
      const r = verifyAndroidKeyAttestation({
        chain: evidence.attempt_key_chain,
        challenge: input.challenge,
        publicKeySpki: input.attemptKeySpki,
        policy: { packageName: this.config.attestation.android.packageName, signingCertDigests: this.config.attestation.android.signingCertDigests, requireUserAuth: true },
        rootKeys: this.androidRootKeys,
        now: new Date(this.now()),
        revokedSerials: await this.revoked(),
      });
      if (this.play) {
        if (!evidence.play_integrity_token) throw new AttestationFailed('Play Integrity token missing');
        const verdict = await this.play.decode(evidence.play_integrity_token);
        checkPlayVerdict(verdict, {
          packageName: this.config.attestation.android.packageName,
          requestHash: b64url(sha256(input.payload)),
          signingCertDigests: this.config.attestation.android.signingCertDigests,
          nowMs: this.now(),
        });
      }
      return { level: r.securityLevel };
    }

    if (evidence.kind !== 'ios') throw new AttestationFailed('iOS evidence expected');
    const ios = this.config.attestation.ios;
    const r = verifyAppAttestation({
      keyId: evidence.app_attest_key_id,
      attestationObject: evidence.attestation_object,
      clientDataHash: sha256(input.payload),
      policy: { appId: ios.appId as string, environment: ios.environment },
      root: this.appleRoot,
      now: new Date(this.now()),
    });
    let deviceCheckSeen = false;
    if (this.deviceCheck && evidence.devicecheck_token) {
      const bits = await this.deviceCheck.query(evidence.devicecheck_token);
      deviceCheckSeen = Boolean(bits?.bit0);
    }
    return { level: 'app_attest', appAttest: { keyId: r.keyId, publicKeySpki: r.publicKeySpki }, deviceCheckSeen };
  }

  /** Marks the physical iPhone as bound (DeviceCheck bit0). Best effort. */
  async markIosDevice(token: string | undefined): Promise<boolean> {
    if (!this.deviceCheck || !token) return false;
    return this.deviceCheck.mark(token);
  }

  /**
   * Checks the per-request attestation for a signed payload. Throws
   * AttestationFailed for bad evidence; provider outages come back as
   * `unavailable` so the caller can flag instead of rejecting.
   */
  async verifyRequest(
    device: { platform: 'android' | 'ios'; attestation_level: string; app_attest_public_key: string | null; app_attest_counter: string | number },
    payload: Buffer,
    evidence: RequestEvidence,
  ): Promise<RequestAttestation> {
    if (device.attestation_level === 'dev_bypass') {
      if (!this.bypassAllowed) throw new AttestationFailed('this phone was registered with a development build');
      return { result: 'bypass' };
    }
    // Only possible in dev/test: staging and production refuse Android binds without Play Integrity
    // (platformReady), so there is nothing to check a token against. Don't flag every scan for it.
    const play = this.play;
    if (device.platform === 'android' && !play) return { result: this.strict ? 'unavailable' : 'bypass' };
    if (evidence.kind === 'missing' || evidence.kind === 'none') return { result: 'missing' };

    if (device.platform === 'android' && play) {
      if (evidence.kind !== 'play_integrity') throw new AttestationFailed('Play Integrity token expected');
      try {
        const verdict = await play.decode(evidence.token);
        checkPlayVerdict(verdict, {
          packageName: this.config.attestation.android.packageName,
          requestHash: b64url(sha256(payload)),
          signingCertDigests: this.config.attestation.android.signingCertDigests,
          nowMs: this.now(),
        });
        return { result: 'ok' };
      } catch (err) {
        if (err instanceof AttestationUnavailable) {
          this.logger.warn({ err: err.message }, 'Play Integrity unavailable');
          return { result: 'unavailable' };
        }
        throw err;
      }
    }

    if (evidence.kind !== 'app_attest') throw new AttestationFailed('App Attest assertion expected');
    if (!device.app_attest_public_key || !this.config.attestation.ios.appId) throw new AttestationFailed('phone has no App Attest key');
    const { counter } = verifyAppAssertion({
      assertion: evidence.assertion,
      clientDataHash: sha256(payload),
      publicKeySpki: device.app_attest_public_key,
      appId: this.config.attestation.ios.appId,
      previousCounter: Number(device.app_attest_counter),
    });
    return { result: 'ok', newCounter: counter };
  }

  private async fetchRevoked(): Promise<ReadonlySet<string>> {
    const now = this.now();
    if (this.revokedCache && now - this.revokedCache.at < 24 * 3600_000) return this.revokedCache.set;
    if (this.config.env === 'test') return new Set();
    try {
      const res = await fetch(STATUS_URL, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = (await res.json()) as { entries?: Record<string, { status?: string }> };
      const set = new Set(Object.keys(body.entries ?? {}).map(normalizeSerial));
      this.revokedCache = { at: now, set };
      return set;
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not refresh Android attestation revocation list');
      return this.revokedCache?.set ?? new Set();
    }
  }
}
