import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { ApiError } from '../errors.ts';
import { runDueJobs } from '../jobs.ts';
import { safeEqualStr } from '../platform/crypto.ts';

/**
 * GET /v1/internal/cron: Vercel Cron's daily nudge to run due background jobs
 * (ADR-0020). Requests also trigger them, so this only guarantees a run on
 * quiet days. Refused unless CRON_SECRET is configured and presented.
 */
export function registerCronRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/internal/cron', async (req) => {
    const secret = ctx.config.cronSecret;
    const header = req.headers.authorization ?? '';
    if (!secret || !safeEqualStr(header, `Bearer ${secret}`)) throw new ApiError(404, 'not_found', 'Not found');
    return runDueJobs(ctx);
  });
}
