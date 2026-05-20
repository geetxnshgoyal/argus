import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../src/app.ts';
import { createLogger } from '../src/logger.ts';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
});

function logSink() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _e, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { logger: createLogger('info', stream), text: () => lines.join('') };
}

async function make(overrides: Partial<AppDeps> = {}) {
  const { logger, text } = logSink();
  const built = await buildApp({
    logger,
    version: '9.9.9-test',
    trustProxy: false,
    checkDb: async () => {},
    ...overrides,
  });
  apps.push(built.app);
  return { ...built, logs: text };
}

describe('GET /v1/health', () => {
  it('reports ok when the database answers', async () => {
    const { app } = await make();
    const res = await app.inject('/v1/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', version: '9.9.9-test', db: 'ok' });
  });

  it('reports 503 degraded when the database is down', async () => {
    const { app } = await make({
      checkDb: async () => {
        throw new Error('connection refused');
      },
    });
    const res = await app.inject('/v1/health');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'degraded', db: 'unavailable' });
  });
});

describe('GET /v1/time', () => {
  it('returns the server clock', async () => {
    const { app } = await make({ now: () => 1_790_000_000_123 });
    const res = await app.inject('/v1/time');
    expect(res.json()).toEqual({ server_time_ms: 1_790_000_000_123, server_time: '2026-09-21T14:13:20.123Z' });
  });
});

describe('errors and headers', () => {
  it('returns the standard error shape for unknown API routes', async () => {
    const { app } = await make();
    const res = await app.inject('/v1/does-not-exist');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ code: 'not_found', message: 'Not found' });
  });

  it('sets security headers and a request id', async () => {
    const { app } = await make();
    const res = await app.inject('/v1/time');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not log query strings (which may carry tokens or codes)', async () => {
    const { app, logs } = await make();
    await app.inject('/v1/time?code=SECRET-QUERY-VALUE');
    expect(logs()).toContain('"url":"/v1/time"');
    expect(logs()).not.toContain('SECRET-QUERY-VALUE');
  });
});

describe('web app serving', () => {
  function webDir() {
    const dir = mkdtempSync(join(tmpdir(), 'argus-web-'));
    writeFileSync(join(dir, 'index.html'), '<html>MAIN</html>');
    writeFileSync(join(dir, 'display.html'), '<html>DISPLAY</html>');
    return dir;
  }

  it('serves the main SPA for app routes, with CSP and frame protection', async () => {
    const { app } = await make({ webDir: webDir() });
    const res = await app.inject('/teacher/today');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('MAIN');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('serves the separate display bundle under /display', async () => {
    const { app } = await make({ webDir: webDir() });
    expect((await app.inject('/display')).body).toContain('DISPLAY');
    expect((await app.inject('/display/pair')).body).toContain('DISPLAY');
  });

  it('never falls back to HTML for API paths', async () => {
    const { app } = await make({ webDir: webDir() });
    const res = await app.inject('/v1/unknown');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found' });
  });
});
