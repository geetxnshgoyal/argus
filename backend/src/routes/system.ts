import type { FastifyInstance } from 'fastify';
import type { components } from '../generated/api.ts';

type Health = components['schemas']['Health'];
type ServerTime = components['schemas']['ServerTime'];

const DB_CHECK_TIMEOUT_MS = 2_000;

export interface SystemDeps {
  version: string;
  checkDb: () => Promise<void>;
  now: () => number;
}

async function dbHealthy(check: () => Promise<void>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('db check timed out')), DB_CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([check(), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function registerSystemRoutes(app: FastifyInstance, deps: SystemDeps): void {
  app.get('/v1/health', async (_req, reply) => {
    const ok = await dbHealthy(deps.checkDb);
    const body: Health = { status: ok ? 'ok' : 'degraded', version: deps.version, db: ok ? 'ok' : 'unavailable' };
    return reply.status(ok ? 200 : 503).send(body);
  });

  app.get('/v1/time', async () => {
    const ms = deps.now();
    const body: ServerTime = { server_time_ms: ms, server_time: new Date(ms).toISOString() };
    return body;
  });
}
