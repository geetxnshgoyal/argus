import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Runtime configuration, read once from environment variables at startup.
 *
 * Safety rules enforced here (the server refuses to start if violated):
 *  - Dev-only switches (attestation bypass, fake SSO login) are allowed only when ARGUS_ENV=dev.
 *  - Staging and production must provide a 32-byte master key.
 * Error messages name the offending variable but never echo its value.
 */

export const ENVIRONMENTS = ['dev', 'test', 'staging', 'production'] as const;
export type ArgusEnv = (typeof ENVIRONMENTS)[number];

const bool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  ARGUS_ENV: z.enum(ENVIRONMENTS),
  DATABASE_URL: z.string().min(1),
  // Neon (Vercel Marketplace) also provides a direct connection; prefer it over the
  // transaction pooler, which rejects Argus's per-session settings (ADR-0020).
  DATABASE_URL_UNPOOLED: z.string().min(1).optional(),
  ARGUS_HOST: z.string().default('127.0.0.1'),
  ARGUS_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  ARGUS_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ARGUS_MASTER_KEY: z.string().optional(),
  ARGUS_ATTESTATION_BYPASS: bool,
  ARGUS_DEV_LOGIN: bool,
  ARGUS_TRUST_PROXY: bool,
  ARGUS_WEB_DIR: z.string().optional(),
  ARGUS_PUBLIC_URL: z.string().url().optional(),
  OIDC_ISSUER: z.string().url().default('https://accounts.google.com'),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  // Google Workspace domain(s), comma-separated; sign-in is limited to accounts in them when set.
  // e.g. "svyasa-sas.edu.in,newtonschool.co" (students on the college domain, teachers on Newton's).
  OIDC_HOSTED_DOMAIN: z.string().optional(),
  ARGUS_MOBILE_REDIRECT_URI: z.string().default('app.argus.argus:/auth/callback'),
  // ── Device attestation (M3). A platform that is not configured cannot bind phones outside dev/test.
  ANDROID_PACKAGE_NAME: z.string().default('app.argus.argus'),
  // SHA-256 of the app signing certificate(s), hex (colons allowed), comma-separated.
  ANDROID_SIGNING_CERT_SHA256: z.string().optional(),
  // Path to the Google Cloud service-account JSON allowed to decode Play Integrity tokens.
  PLAY_INTEGRITY_CREDENTIALS: z.string().optional(),
  // App Attest app ID: "<Apple team ID>.<bundle ID>".
  IOS_APP_ID: z.string().regex(/^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/, 'Use TEAMID.bundle.id').optional(),
  IOS_APP_ATTEST_ENV: z.enum(['production', 'development']).default('production'),
  // DeviceCheck key (.p8 file) from the Apple developer account, and its key ID.
  APPLE_DEVICECHECK_KEY_ID: z.string().optional(),
  APPLE_DEVICECHECK_KEY: z.string().optional(),
  // Rebind policy (ADR-0007).
  // Android pilot mode (ADR-0021): 'off' accepts phones without Play Integrity (e.g. an APK
  // installed outside Google Play) while still requiring hardware key attestation and our signing key.
  PLAY_INTEGRITY_MODE: z.enum(['required', 'off']).default('required'),
  // Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" (ADR-0020).
  CRON_SECRET: z.string().min(16).optional(),
  // Connections per process; serverless instances use a few each.
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).optional(),
  // Set by Vercel on its build and runtime.
  VERCEL: z.string().optional(),
  ARGUS_REBIND_COOLDOWN_HOURS: z.coerce.number().min(0).max(24 * 30).default(48),
  ARGUS_MAX_REBINDS_PER_TERM: z.coerce.number().int().min(0).max(50).default(2),
  // Time zone of the college: timetable times are local times in this zone.
  ARGUS_TIMEZONE: z
    .string()
    .default('Asia/Kolkata')
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown time zone'),
});

export interface Config {
  env: ArgusEnv;
  databaseUrl: string;
  host: string;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  /** 32-byte root key (session-secret encryption, token signing). Random per process in dev/test if unset. */
  masterKey: Buffer;
  masterKeyEphemeral: boolean;
  attestationBypass: boolean;
  devLogin: boolean;
  trustProxy: boolean;
  webDir: string | undefined;
  /** Origin users reach Argus at, e.g. https://argus.college.edu (no trailing slash). */
  publicUrl: string;
  oidc: {
    issuer: string;
    clientId: string | undefined;
    clientSecret: string | undefined;
    /** Allowed Google Workspace domains (lowercase). Empty = any account (dev/test only). */
    hostedDomains: string[];
  };
  mobileRedirectUri: string;
  timeZone: string;
  attestation: {
    android: {
      packageName: string;
      /** Lowercase hex SHA-256 digests of accepted signing certificates. */
      signingCertDigests: string[];
      playIntegrityCredentialsPath: string | undefined;
      playIntegrityMode: 'required' | 'off';
    };
    ios: {
      appId: string | undefined;
      environment: 'production' | 'development';
      deviceCheckKeyId: string | undefined;
      deviceCheckKeyPath: string | undefined;
    };
  };
  devices: {
    rebindCooldownMs: number;
    maxRebindsPerTerm: number;
  };
  /** Running as Vercel Functions: no long-lived process (ADR-0020). */
  serverless: boolean;
  cronSecret: string | undefined;
  dbPoolMax: number;
}

/** Normalizes "AB:CD:…" or "abcd…" digests; returns null for anything that isn't 32 bytes of hex. */
function parseDigest(d: string): string | null {
  const hex = d.trim().replace(/:/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Report which variables are wrong, not what they contained.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(problems);
  }
  const e = parsed.data;
  const problems: string[] = [];

  if (e.ARGUS_ENV !== 'dev') {
    if (e.ARGUS_ATTESTATION_BYPASS) problems.push('ARGUS_ATTESTATION_BYPASS is only allowed when ARGUS_ENV=dev');
    if (e.ARGUS_DEV_LOGIN) problems.push('ARGUS_DEV_LOGIN is only allowed when ARGUS_ENV=dev');
  }

  let masterKey: Buffer | null = null;
  if (e.ARGUS_MASTER_KEY !== undefined && e.ARGUS_MASTER_KEY !== '') {
    const decoded = Buffer.from(e.ARGUS_MASTER_KEY, 'base64');
    if (decoded.length !== 32) {
      problems.push('ARGUS_MASTER_KEY must be 32 bytes, base64-encoded (generate with: openssl rand -base64 32)');
    } else {
      masterKey = decoded;
    }
  } else if (e.ARGUS_ENV === 'staging' || e.ARGUS_ENV === 'production') {
    problems.push('ARGUS_MASTER_KEY is required in staging and production');
  }

  const strict = e.ARGUS_ENV === 'staging' || e.ARGUS_ENV === 'production';
  if (strict) {
    if (!e.ARGUS_PUBLIC_URL) problems.push('ARGUS_PUBLIC_URL is required in staging and production');
    else if (!e.ARGUS_PUBLIC_URL.startsWith('https://')) problems.push('ARGUS_PUBLIC_URL must use https in staging and production');
    if (!e.OIDC_CLIENT_ID || !e.OIDC_CLIENT_SECRET) {
      problems.push('OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are required in staging and production');
    }
  }

  const signingCertDigests: string[] = [];
  for (const d of (e.ANDROID_SIGNING_CERT_SHA256 ?? '').split(',').filter((x) => x.trim() !== '')) {
    const hex = parseDigest(d);
    if (hex) signingCertDigests.push(hex);
    else problems.push('ANDROID_SIGNING_CERT_SHA256 must be comma-separated SHA-256 digests (64 hex characters each)');
  }
  const hostedDomains = (e.OIDC_HOSTED_DOMAIN ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d !== '');
  for (const d of hostedDomains) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) problems.push('OIDC_HOSTED_DOMAIN must be comma-separated domains like college.edu,partner.co');
  }
  if (Boolean(e.APPLE_DEVICECHECK_KEY_ID) !== Boolean(e.APPLE_DEVICECHECK_KEY)) {
    problems.push('APPLE_DEVICECHECK_KEY_ID and APPLE_DEVICECHECK_KEY must be set together');
  }
  if (e.APPLE_DEVICECHECK_KEY_ID && !e.IOS_APP_ID) problems.push('APPLE_DEVICECHECK_KEY_ID needs IOS_APP_ID (for the team ID)');

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    env: e.ARGUS_ENV,
    databaseUrl: e.DATABASE_URL_UNPOOLED ?? e.DATABASE_URL,
    host: e.ARGUS_HOST,
    port: e.ARGUS_PORT,
    logLevel: e.ARGUS_LOG_LEVEL,
    masterKey: masterKey ?? randomBytes(32),
    masterKeyEphemeral: masterKey === null,
    attestationBypass: e.ARGUS_ATTESTATION_BYPASS,
    devLogin: e.ARGUS_DEV_LOGIN,
    trustProxy: e.ARGUS_TRUST_PROXY,
    webDir: e.ARGUS_WEB_DIR,
    publicUrl: (e.ARGUS_PUBLIC_URL ?? 'http://localhost:5173').replace(/\/+$/, ''),
    oidc: {
      issuer: e.OIDC_ISSUER,
      clientId: e.OIDC_CLIENT_ID,
      clientSecret: e.OIDC_CLIENT_SECRET,
      hostedDomains,
    },
    mobileRedirectUri: e.ARGUS_MOBILE_REDIRECT_URI,
    timeZone: e.ARGUS_TIMEZONE,
    attestation: {
      android: {
        packageName: e.ANDROID_PACKAGE_NAME,
        signingCertDigests,
        playIntegrityCredentialsPath: e.PLAY_INTEGRITY_CREDENTIALS,
        playIntegrityMode: e.PLAY_INTEGRITY_MODE,
      },
      ios: {
        appId: e.IOS_APP_ID,
        environment: e.IOS_APP_ATTEST_ENV,
        deviceCheckKeyId: e.APPLE_DEVICECHECK_KEY_ID,
        deviceCheckKeyPath: e.APPLE_DEVICECHECK_KEY,
      },
    },
    devices: {
      rebindCooldownMs: e.ARGUS_REBIND_COOLDOWN_HOURS * 3600_000,
      maxRebindsPerTerm: e.ARGUS_MAX_REBINDS_PER_TERM,
    },
    serverless: e.VERCEL === '1',
    cronSecret: e.CRON_SECRET,
    dbPoolMax: e.DATABASE_POOL_MAX ?? (e.VERCEL === '1' ? 5 : 20),
  };
}
