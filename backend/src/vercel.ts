import type { IncomingMessage, ServerResponse } from 'node:http';
import { attachDatabasePool, waitUntil } from '@vercel/functions';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createContext, type AppContext } from './context.ts';
import { createDb } from './db/index.ts';
import { migrateToLatest } from './db/migrate.ts';
import { runDueJobs } from './jobs.ts';
import { bootstrapAdmins } from './admin/bootstrap.ts';
import { createLogger } from './logger.ts';

/**
 * Argus as one Vercel Function (ADR-0020). Every /v1 request is rewritten here;
 * the web app and classroom display are static files on Vercel's CDN.
 *
 * An instance boots once (config, database pool, migrations, Fastify) and then
 * serves many requests. Background jobs run after the response via waitUntil,
 * at most every 30 s per instance; `job_runs` makes sure each job runs once globally.
 */

declare const __ARGUS_VERSION__: string | undefined;

interface Booted {
  app: FastifyInstance;
  ctx: AppContext;
  lastJobCheck: number;
}

let booting: Promise<Booted> | undefined;

async function boot(): Promise<Booted> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const db = createDb(config.databaseUrl, { max: config.dbPoolMax, onPool: (pool) => attachDatabasePool(pool) });
  const migrated = await migrateToLatest(db);
  for (const r of migrated.results ?? []) logger.info({ migration: r.migrationName, status: r.status }, 'migration');
  if (migrated.error) throw migrated.error;
  const version = typeof __ARGUS_VERSION__ !== 'undefined' ? __ARGUS_VERSION__ : 'dev';
  const ctx = createContext({ config, db, logger, version });
  await bootstrapAdmins(ctx);
  const { app } = await buildApp(ctx, { webDir: undefined });
  logger.info({ env: config.env, version }, 'argus function started');
  return { app, ctx, lastJobCheck: 0 };
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let b: Booted;
  try {
    b = await (booting ??= boot().catch((err: unknown) => {
      booting = undefined; // retry the boot on the next request
      throw err;
    }));
  } catch (err) {
    console.error('argus failed to start', err instanceof Error ? err.message : err);
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 'starting_failed', message: 'Argus could not start. Check the server settings.' }));
    return;
  }
  if (Date.now() - b.lastJobCheck > 30_000) {
    b.lastJobCheck = Date.now();
    waitUntil(runDueJobs(b.ctx).catch((err: unknown) => b.ctx.logger.error({ err }, 'background jobs failed')));
  }
  b.app.server.emit('request', req, res);
}
