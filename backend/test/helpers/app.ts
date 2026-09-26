import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp, type AppOptions } from '../../src/app.ts';
import type { OidcService } from '../../src/auth/oidc.ts';
import type { Config } from '../../src/config.ts';
import { createContext, type AppContext } from '../../src/context.ts';
import { createDb, type Db } from '../../src/db/index.ts';
import type { Role } from '../../src/db/schema.ts';
import { createLogger } from '../../src/logger.ts';
import { uuidv7 } from '../../src/platform/ids.ts';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    env: 'test',
    databaseUrl: 'postgres://unused',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'info',
    masterKey: Buffer.alloc(32, 3),
    masterKeyEphemeral: false,
    attestationBypass: false,
    devLogin: true,
    trustProxy: false,
    webDir: undefined,
    publicUrl: 'http://localhost:5173',
    oidc: { issuer: 'http://idp.test', clientId: undefined, clientSecret: undefined, hostedDomains: ['college.test'], allowedEmails: [] },
    mobileRedirectUri: 'app.argus.argus:/auth/callback',
    timeZone: 'Asia/Kolkata',
    attestation: {
      android: { packageName: 'app.argus.argus', signingCertDigests: [], playIntegrityCredentialsPath: undefined, playIntegrityMode: 'required' },
      ios: { appId: undefined, environment: 'production', deviceCheckKeyId: undefined, deviceCheckKeyPath: undefined },
    },
    devices: { rebindCooldownMs: 48 * 3600_000, maxRebindsPerTerm: 2 },
    serverless: false,
    cronSecret: undefined,
    bootstrapAdminEmails: [],
    dbPoolMax: 20,
    ...overrides,
  };
}

/** A DB handle that never connects (for tests that don't touch the database). */
export function noDb(): Db {
  return createDb('postgres://127.0.0.1:1/none');
}

export function logSink() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _e, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { logger: createLogger('info', stream), text: () => lines.join('') };
}

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  apiRoutes: string[];
  logs: () => string;
  clock: { now: number };
}

export async function makeApp(
  opts: { db?: Db; config?: Partial<Config>; oidc?: OidcService | null; now?: number } & AppOptions = {},
): Promise<TestApp> {
  const { logger, text } = logSink();
  const clock = { now: opts.now ?? Date.UTC(2026, 8, 21, 4, 0, 0) };
  const ctx = createContext({
    config: testConfig(opts.config),
    db: opts.db ?? noDb(),
    logger,
    version: '9.9.9-test',
    now: () => clock.now,
    oidc: opts.oidc ?? null,
  });
  const { app, apiRoutes } = await buildApp(ctx, { checkDb: opts.checkDb ?? (async () => {}), webDir: opts.webDir });
  return { app, ctx, apiRoutes, logs: text, clock };
}

// ── Users and sessions ───────────────────────────────────────────────────────

export async function createUser(db: Db, role: Role, email: string, name = email.split('@')[0] ?? 'user') {
  const id = uuidv7();
  await db.insertInto('users').values({ id, role, email, name }).execute();
  return { id, role, email, name };
}

/** Signs in through the dev login and returns headers for authenticated requests. */
export async function loginAs(app: FastifyInstance, email: string): Promise<{ cookie: string; csrf: string; headers: Record<string, string> }> {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/dev/login', payload: { email } });
  if (res.statusCode !== 200) throw new Error(`dev login failed: ${res.body}`);
  const cookie = cookieFrom(res);
  const me = await app.inject({ url: '/v1/me', headers: { cookie } });
  const csrf = me.json().csrf_token as string;
  return { cookie, csrf, headers: { cookie, 'x-argus-csrf': csrf } };
}

export function cookieFrom(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (!first) throw new Error('no cookie set');
  return first.split(';')[0] as string;
}

// ── Device keys (simulating a phone's hardware key) ──────────────────────────

export interface DeviceKey {
  privateKey: KeyObject;
  spki: string;
  sign: (message: Uint8Array | string) => string;
}

export function deviceKey(): DeviceKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey,
    spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    sign: (m) => sign('sha256', typeof m === 'string' ? Buffer.from(m) : m, { key: privateKey, dsaEncoding: 'der' }).toString('base64url'),
  };
}
