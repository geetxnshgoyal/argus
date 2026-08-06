import { readFileSync } from 'node:fs';
import { importPKCS8, SignJWT } from 'jose';
import { AttestationFailed, AttestationUnavailable, b64any } from './errors.ts';

/**
 * Google Play Integrity, standard requests (spec §5/§6, ADR-0011).
 *
 * The app requests a token with requestHash = base64url(SHA-256(payload bytes)).
 * The server decodes it through Google's API with a service account and
 * checks the verdict. Network/5xx problems are `AttestationUnavailable`
 * (flag, don't reject); a bad or foreign token is `AttestationFailed`.
 */

export interface PlayVerdict {
  requestDetails?: { requestPackageName?: string; requestHash?: string; timestampMillis?: string };
  appIntegrity?: { appRecognitionVerdict?: string; packageName?: string; certificateSha256Digest?: string[] };
  deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
}

export interface PlayIntegrityDecoder {
  decode(token: string): Promise<PlayVerdict>;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const SCOPE = 'https://www.googleapis.com/auth/playintegrity';
const TIMEOUT_MS = 5000;

export class GooglePlayIntegrity implements PlayIntegrityDecoder {
  private readonly account: ServiceAccount;
  private readonly packageName: string;
  private readonly fetchImpl: typeof fetch;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(opts: { credentialsPath: string; packageName: string; fetchImpl?: typeof fetch }) {
    const parsed = JSON.parse(readFileSync(opts.credentialsPath, 'utf8')) as Partial<ServiceAccount>;
    if (!parsed.client_email || !parsed.private_key) throw new Error('PLAY_INTEGRITY_CREDENTIALS is not a service-account key file');
    this.account = parsed as ServiceAccount;
    this.packageName = opts.packageName;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new AttestationUnavailable(err instanceof Error ? err.message : 'network error');
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const tokenUri = this.account.token_uri ?? 'https://oauth2.googleapis.com/token';
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.account.client_email)
      .setAudience(tokenUri)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(await importPKCS8(this.account.private_key, 'RS256'));
    const res = await this.call(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    if (!res.ok) throw new AttestationUnavailable(`Google sign-in for Play Integrity failed (${res.status})`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  async decode(integrityToken: string): Promise<PlayVerdict> {
    const res = await this.call(`https://playintegrity.googleapis.com/v1/${encodeURIComponent(this.packageName)}:decodeIntegrityToken`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ integrity_token: integrityToken }),
    });
    if (res.status >= 500 || res.status === 429) throw new AttestationUnavailable(`Play Integrity API returned ${res.status}`);
    if (!res.ok) throw new AttestationFailed(`integrity token rejected by Google (${res.status})`);
    const body = (await res.json()) as { tokenPayloadExternal?: PlayVerdict };
    if (!body.tokenPayloadExternal) throw new AttestationFailed('empty integrity verdict');
    return body.tokenPayloadExternal;
  }
}

export const PLAY_TOKEN_MAX_AGE_MS = 10 * 60_000;

/** Checks a decoded verdict against what we expect for this exact request. */
export function checkPlayVerdict(
  v: PlayVerdict,
  expect: { packageName: string; requestHash: string; signingCertDigests: string[]; nowMs: number },
): void {
  const fail = (reason: string): never => {
    throw new AttestationFailed(reason);
  };
  const req = v.requestDetails ?? {};
  if (req.requestPackageName !== expect.packageName) fail('token was requested by another app');
  if (req.requestHash !== expect.requestHash) fail('token is not bound to this request');
  const ts = Number(req.timestampMillis);
  if (!Number.isFinite(ts) || Math.abs(expect.nowMs - ts) > PLAY_TOKEN_MAX_AGE_MS) fail('token is too old');

  const app = v.appIntegrity ?? {};
  if (app.appRecognitionVerdict !== 'PLAY_RECOGNIZED') fail(`app not recognized by Google Play (${app.appRecognitionVerdict ?? 'no verdict'})`);
  if (app.packageName !== expect.packageName) fail('verdict is for another app');
  if (expect.signingCertDigests.length > 0) {
    const digests = (app.certificateSha256Digest ?? []).map((d) => b64any(d, 'certificate digest').toString('hex'));
    if (digests.length === 0 || !digests.every((d) => expect.signingCertDigests.includes(d))) fail('app is not signed with the college release key');
  }
  const device = v.deviceIntegrity?.deviceRecognitionVerdict ?? [];
  if (!device.includes('MEETS_DEVICE_INTEGRITY')) fail('phone failed Google device integrity (rooted, emulator or modified system)');
}
