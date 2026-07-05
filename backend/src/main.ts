import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createContext } from './context.ts';
import { createDb } from './db/index.ts';
import { migrateToLatest } from './db/migrate.ts';
import { startJobs } from './jobs.ts';
import { createLogger } from './logger.ts';

/**
 * Argus server entry point.
 *   serve    (default) apply pending migrations, then start the API + web server
 *   migrate  apply pending migrations and exit
 */

declare const __ARGUS_VERSION__: string | undefined;

function version(): string {
  if (typeof __ARGUS_VERSION__ !== 'undefined') return __ARGUS_VERSION__;
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return `${pkg.version}-dev`;
}

/** In the bundled build, web assets sit next to server.mjs in ./web. */
function defaultWebDir(): string | undefined {
  const candidate = join(dirname(fileURLToPath(import.meta.url)), 'web');
  return existsSync(join(candidate, 'index.html')) ? candidate : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'serve';
  if (command !== 'serve' && command !== 'migrate') {
    console.error(`Unknown command "${command}". Use: serve | migrate`);
    process.exit(2);
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.logLevel);
  if (config.attestationBypass) logger.warn('ATTESTATION BYPASS ENABLED (dev only)');
  if (config.devLogin) logger.warn('DEV LOGIN ENABLED (dev only)');
  if (config.masterKeyEphemeral) logger.warn('no ARGUS_MASTER_KEY set: using a random key for this run (dev/test only)');

  const db = createDb(config.databaseUrl);

  const { results, error } = await migrateToLatest(db);
  for (const r of results ?? []) logger.info({ migration: r.migrationName, status: r.status }, 'migration');
  if (error) {
    logger.fatal({ err: error }, 'migration failed');
    await db.destroy();
    process.exit(1);
  }
  if (command === 'migrate') {
    await db.destroy();
    return;
  }

  const ctx = createContext({ config, db, logger, version: version() });
  if (!ctx.oidc && !config.devLogin) logger.warn('SSO not configured (OIDC_CLIENT_ID/SECRET) and dev login off: nobody can sign in');
  const { app } = await buildApp(ctx, { webDir: config.webDir ?? defaultWebDir() });

  const jobs = await startJobs(ctx);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await jobs.stop();
    await app.close();
    await db.destroy();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  logger.info({ env: config.env, version: version() }, 'argus started');
}

await main();
