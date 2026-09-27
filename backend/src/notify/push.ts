import type { FastifyBaseLogger } from 'fastify';
import { importPKCS8, SignJWT } from 'jose';
import type { AppContext } from '../context.ts';

/**
 * Phone notifications (ADR-0025): Firebase Cloud Messaging for Android. iPhones
 * would need APNs, which Apple offers only to paid developer accounts, so iPhones
 * see notices when the app is opened.
 *
 * Sends happen after the change is committed, in the background, and never fail
 * the request: a notification is a courtesy, the notice itself is in the database.
 */

export interface PushMessage {
  title: string;
  body: string;
  /** Small string map for the app, e.g. { kind: 'notice' }. */
  data?: Record<string, string>;
}

export type PushResult = 'ok' | 'invalid' | 'error';

export interface PushSender {
  send(token: string, msg: PushMessage): Promise<PushResult>;
}

export interface FcmServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export class FcmSender implements PushSender {
  private access: { value: string; exp: number } | null = null;
  private readonly sa: FcmServiceAccount;
  private readonly logger: FastifyBaseLogger;
  private readonly fetchImpl: typeof fetch;

  constructor(sa: FcmServiceAccount, logger: FastifyBaseLogger, fetchImpl: typeof fetch = fetch) {
    this.sa = sa;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
  }

  /** OAuth access token for FCM from the service account (JWT bearer grant), cached for its lifetime. */
  private async accessToken(): Promise<string> {
    if (this.access && this.access.exp > Date.now() + 60_000) return this.access.value;
    const key = await importPKCS8(this.sa.private_key, 'RS256');
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.sa.client_email)
      .setAudience(TOKEN_URL)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`FCM sign-in failed (${res.status})`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.access = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }

  async send(token: string, msg: PushMessage): Promise<PushResult> {
    const res = await this.fetchImpl(`https://fcm.googleapis.com/v1/projects/${this.sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: msg.title, body: msg.body },
          data: msg.data ?? {},
          // The app creates the "argus_notices" channel with sound and heads-up display.
          android: { priority: 'HIGH', notification: { channel_id: 'argus_notices', sound: 'default' } },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return 'ok';
    const text = await res.text();
    // The app was uninstalled or the token rotated: forget it.
    if (res.status === 404 || (res.status === 400 && /registration token|UNREGISTERED/i.test(text))) return 'invalid';
    this.logger.warn({ status: res.status, body: text.slice(0, 300) }, 'push send failed');
    return 'error';
  }
}

export function parseServiceAccount(raw: string): FcmServiceAccount {
  const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const sa = JSON.parse(json) as Partial<FcmServiceAccount>;
  if (!sa.project_id || !sa.client_email || !sa.private_key) throw new Error('not a Firebase service account key');
  return { project_id: sa.project_id, client_email: sa.client_email, private_key: sa.private_key };
}

/** Sends one message to every phone of these users; forgets tokens FCM says are dead. */
export async function pushToUsers(ctx: AppContext, userIds: string[], msg: PushMessage): Promise<{ sent: number; failed: number }> {
  const push = ctx.push;
  if (!push || userIds.length === 0) return { sent: 0, failed: 0 };
  const unique = [...new Set(userIds)];
  const tokens: string[] = [];
  for (let i = 0; i < unique.length; i += 1000) {
    const rows = await ctx.db.selectFrom('push_tokens').select('token').where('user_id', 'in', unique.slice(i, i + 1000)).execute();
    tokens.push(...rows.map((r) => r.token));
  }
  const invalid: string[] = [];
  let sent = 0;
  let failed = 0;
  // A handful at a time: fast enough for a section, gentle on FCM.
  for (let i = 0; i < tokens.length; i += 20) {
    const batch = tokens.slice(i, i + 20);
    const results = await Promise.all(batch.map((t) => push.send(t, msg).catch(() => 'error' as const)));
    results.forEach((r, j) => {
      if (r === 'ok') sent++;
      else if (r === 'invalid') invalid.push(batch[j]!);
      else failed++;
    });
  }
  if (invalid.length) await ctx.db.deleteFrom('push_tokens').where('token', 'in', invalid).execute();
  return { sent, failed };
}

/** Notification text for a notice: the title, and the start of the message. */
export function noticePush(n: { id: string; title: string; body: string }): PushMessage {
  const body = n.body.replace(/\s+/g, ' ').trim();
  return { title: n.title, body: body.length > 180 ? `${body.slice(0, 177)}…` : body || 'Open Argus to read it.', data: { kind: 'notice', id: n.id } };
}
