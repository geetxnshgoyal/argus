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
  ARGUS_HOST: z.string().default('127.0.0.1'),
  ARGUS_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  ARGUS_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ARGUS_MASTER_KEY: z.string().optional(),
  ARGUS_ATTESTATION_BYPASS: bool,
  ARGUS_DEV_LOGIN: bool,
  ARGUS_TRUST_PROXY: bool,
  ARGUS_WEB_DIR: z.string().optional(),
});

export interface Config {
  env: ArgusEnv;
  databaseUrl: string;
  host: string;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  /** 32-byte key used to encrypt per-session secrets at rest. Null only in dev/test. */
  masterKey: Buffer | null;
  attestationBypass: boolean;
  devLogin: boolean;
  trustProxy: boolean;
  webDir: string | undefined;
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

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    env: e.ARGUS_ENV,
    databaseUrl: e.DATABASE_URL,
    host: e.ARGUS_HOST,
    port: e.ARGUS_PORT,
    logLevel: e.ARGUS_LOG_LEVEL,
    masterKey,
    attestationBypass: e.ARGUS_ATTESTATION_BYPASS,
    devLogin: e.ARGUS_DEV_LOGIN,
    trustProxy: e.ARGUS_TRUST_PROXY,
    webDir: e.ARGUS_WEB_DIR,
  };
}
