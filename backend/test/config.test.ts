import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');
const base = { DATABASE_URL: 'postgres://argus:hunter2@db/argus' };

function problemsOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
}

describe('loadConfig', () => {
  it('accepts a minimal dev config with defaults', () => {
    const c = loadConfig({ ...base, ARGUS_ENV: 'dev' });
    expect(c.env).toBe('dev');
    expect(c.port).toBe(8080);
    expect(c.host).toBe('127.0.0.1');
    expect(c.masterKey).toBeNull();
    expect(c.attestationBypass).toBe(false);
  });

  it('requires ARGUS_ENV (no silent default)', () => {
    expect(problemsOf(base).join()).toMatch(/ARGUS_ENV/);
  });

  it('allows dev-only switches in dev', () => {
    const c = loadConfig({ ...base, ARGUS_ENV: 'dev', ARGUS_ATTESTATION_BYPASS: 'true', ARGUS_DEV_LOGIN: '1' });
    expect(c.attestationBypass).toBe(true);
    expect(c.devLogin).toBe(true);
  });

  it.each(['test', 'staging', 'production'])('refuses attestation bypass in %s', (env) => {
    const p = problemsOf({ ...base, ARGUS_ENV: env, ARGUS_MASTER_KEY: KEY, ARGUS_ATTESTATION_BYPASS: 'true' });
    expect(p.join()).toMatch(/ARGUS_ATTESTATION_BYPASS is only allowed when ARGUS_ENV=dev/);
  });

  it.each(['test', 'staging', 'production'])('refuses dev login in %s', (env) => {
    const p = problemsOf({ ...base, ARGUS_ENV: env, ARGUS_MASTER_KEY: KEY, ARGUS_DEV_LOGIN: 'true' });
    expect(p.join()).toMatch(/ARGUS_DEV_LOGIN is only allowed when ARGUS_ENV=dev/);
  });

  it('treats an explicit "false" bypass as off in production', () => {
    const c = loadConfig({ ...base, ARGUS_ENV: 'production', ARGUS_MASTER_KEY: KEY, ARGUS_ATTESTATION_BYPASS: 'false' });
    expect(c.attestationBypass).toBe(false);
  });

  it('rejects ambiguous boolean values rather than guessing', () => {
    expect(problemsOf({ ...base, ARGUS_ENV: 'dev', ARGUS_ATTESTATION_BYPASS: 'yes' }).join()).toMatch(
      /ARGUS_ATTESTATION_BYPASS/,
    );
  });

  it.each(['staging', 'production'])('requires a master key in %s', (env) => {
    expect(problemsOf({ ...base, ARGUS_ENV: env }).join()).toMatch(/ARGUS_MASTER_KEY is required/);
  });

  it('rejects a master key that is not 32 bytes', () => {
    const short = Buffer.alloc(16).toString('base64');
    expect(problemsOf({ ...base, ARGUS_ENV: 'production', ARGUS_MASTER_KEY: short }).join()).toMatch(/32 bytes/);
  });

  it('decodes a valid master key', () => {
    const c = loadConfig({ ...base, ARGUS_ENV: 'production', ARGUS_MASTER_KEY: KEY });
    expect(c.masterKey?.length).toBe(32);
  });

  it('never echoes secret values in error messages', () => {
    const secretKey = Buffer.alloc(20, 9).toString('base64');
    const p = problemsOf({ ...base, ARGUS_ENV: 'production', ARGUS_MASTER_KEY: secretKey, ARGUS_PORT: 'abc' }).join();
    expect(p).not.toContain(secretKey);
    expect(p).not.toContain('hunter2');
  });
});
