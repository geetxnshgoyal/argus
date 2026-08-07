import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { importPKCS8, SignJWT } from 'jose';

/**
 * Apple DeviceCheck two-bit storage (spec §5, ADR-0009): bit0 marks a
 * physical iPhone as "has been bound to an Argus account". It survives app
 * reinstalls, so a second account on the same phone is detected.
 * Failures return null / false: DeviceCheck is a supporting signal, never a
 * reason to block a binding on its own.
 */

export interface DeviceBits {
  bit0: boolean;
  bit1: boolean;
}

export interface DeviceCheck {
  query(deviceToken: string): Promise<DeviceBits | null>;
  mark(deviceToken: string): Promise<boolean>;
}

const TIMEOUT_MS = 5000;

export class AppleDeviceCheck implements DeviceCheck {
  private readonly base: string;
  private readonly teamId: string;
  private readonly keyId: string;
  private readonly keyPem: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { teamId: string; keyId: string; keyPath: string; environment: 'production' | 'development'; fetchImpl?: typeof fetch }) {
    this.base = opts.environment === 'production' ? 'https://api.devicecheck.apple.com/v1' : 'https://api.development.devicecheck.apple.com/v1';
    this.teamId = opts.teamId;
    this.keyId = opts.keyId;
    this.keyPem = readFileSync(opts.keyPath, 'utf8');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<Response | null> {
    try {
      const jwt = await new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: this.keyId })
        .setIssuer(this.teamId)
        .setIssuedAt()
        .sign(await importPKCS8(this.keyPem, 'ES256'));
      return await this.fetchImpl(`${this.base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
        body: JSON.stringify({ device_token: body.device_token, transaction_id: randomUUID(), timestamp: Date.now(), ...body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return null;
    }
  }

  async query(deviceToken: string): Promise<DeviceBits | null> {
    const res = await this.post('/query_two_bits', { device_token: deviceToken });
    if (!res?.ok) return null;
    const text = await res.text();
    // Apple answers 200 with a plain-text message when the bits were never set.
    if (!text.trim().startsWith('{')) return { bit0: false, bit1: false };
    const j = JSON.parse(text) as Partial<DeviceBits>;
    return { bit0: Boolean(j.bit0), bit1: Boolean(j.bit1) };
  }

  async mark(deviceToken: string): Promise<boolean> {
    const res = await this.post('/update_two_bits', { device_token: deviceToken, bit0: true, bit1: false });
    return Boolean(res?.ok);
  }
}
