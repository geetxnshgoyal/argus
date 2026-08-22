import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { computeTag, currentEpoch } from '../../src/attendance/crypto.ts';
import { b64url, fromB64url } from '../../src/platform/crypto.ts';
import { canonicalize } from '../../src/platform/jcs.ts';
import { deviceKey, type DeviceKey } from './app.ts';

/**
 * A simulated student phone: hardware session + attempt keys, the app's sign-in,
 * device binding (dev bypass) and signed attendance attempts, byte-for-byte as
 * protocol.md describes.
 */
export class Phone {
  readonly session: DeviceKey = deviceKey();
  readonly attempt: DeviceKey = deviceKey();
  readonly androidId = randomBytes(8).toString('hex');
  access = '';
  deviceId = '';
  private readonly app: FastifyInstance;
  readonly email: string;

  constructor(app: FastifyInstance, email: string) {
    this.app = app;
    this.email = email;
  }

  get auth(): Record<string, string> {
    return { authorization: `Bearer ${this.access}` };
  }

  async signIn(): Promise<this> {
    const res = await this.app.inject({
      method: 'POST',
      url: '/v1/auth/dev/mobile-login',
      payload: { email: this.email, session_public_key: this.session.spki, signature: this.session.sign(`argus/v1/dev-login|${this.email}`) },
    });
    if (res.statusCode !== 200) throw new Error(`mobile login failed: ${res.body}`);
    this.access = res.json().access_token;
    return this;
  }

  /** Binds with the dev attestation bypass; returns the raw response. */
  async bind(overrides: { androidId?: string } = {}) {
    const ch = await this.app.inject({ method: 'POST', url: '/v1/devices/bind/challenge', headers: this.auth });
    if (ch.statusCode !== 200) throw new Error(`challenge failed: ${ch.body}`);
    const payload = Buffer.from(
      canonicalize({
        v: 1,
        challenge: ch.json().challenge,
        session_pub: this.session.spki,
        attempt_pub: this.attempt.spki,
        platform: 'android',
        model: 'Test Phone',
        os_version: '16',
        app_version: '1.0.0',
        android_id: overrides.androidId ?? this.androidId,
      }),
    );
    const res = await this.app.inject({
      method: 'POST',
      url: '/v1/devices/bind',
      headers: this.auth,
      payload: { payload: b64url(payload), session_signature: this.session.sign(payload), attempt_signature: this.attempt.sign(payload), evidence: { kind: 'dev_bypass' } },
    });
    if (res.statusCode === 200) this.deviceId = res.json().device_id;
    return res;
  }

  /** Builds the attempt payload exactly as the app does (JCS bytes). */
  payload(qr: { sessionId: string; round: number; epoch: number; tag: string }, over: Record<string, unknown> = {}): Buffer {
    return Buffer.from(
      canonicalize({
        v: 1,
        session_id: qr.sessionId,
        round: qr.round,
        epoch: qr.epoch,
        tag: qr.tag,
        device_id: this.deviceId,
        nonce: randomBytes(16).toString('base64url'),
        device_time: new Date().toISOString(),
        location: { lat: 12.9, lon: 77.5, accuracy_m: 15, fix_age_ms: 1200, is_mock: false },
        signals: {},
        app_version: '1.0.0',
        offline_queued: false,
        ...over,
      }),
    );
  }

  async send(payload: Buffer, signature = this.attempt.sign(payload)) {
    return this.app.inject({ method: 'POST', url: '/v1/attendance/attempts', headers: this.auth, payload: { payload: b64url(payload), signature, attestation: { kind: 'none' } } });
  }

  async scan(qr: { sessionId: string; round: number; epoch: number; tag: string }, over: Record<string, unknown> = {}) {
    return this.send(this.payload(qr, over));
  }

  /** "Request attendance support" from the app (spec §7): signed by the attempt key. */
  async requestSupport(attendanceSessionId: string, over: Record<string, unknown> = {}) {
    const payload = Buffer.from(
      canonicalize({
        v: 1,
        action: 'support_request',
        attendance_session_id: attendanceSessionId,
        device_id: this.deviceId,
        reason: 'cant_scan',
        note: null,
        nonce: randomBytes(16).toString('base64url'),
        device_time: new Date().toISOString(),
        location: { lat: 12.9, lon: 77.5, accuracy_m: 15, fix_age_ms: 1200, is_mock: false },
        app_version: '1.0.0',
        ...over,
      }),
    );
    return this.app.inject({
      method: 'POST',
      url: '/v1/support-requests',
      headers: this.auth,
      payload: { payload: b64url(payload), signature: this.attempt.sign(payload), attestation: { kind: 'none' } },
    });
  }
}

/** What the classroom display computes from its round key (protocol §5.3). */
export function displayQr(state: { session_id: string; round: number; t0_ms: number; epoch_ms: number; k_qr: string }, nowMs: number, epochOverride?: number) {
  const epoch = epochOverride ?? currentEpoch(nowMs, state.t0_ms, state.epoch_ms);
  return { sessionId: state.session_id, round: state.round, epoch, tag: b64url(computeTag(fromB64url(state.k_qr), state.session_id, state.round, epoch)) };
}
