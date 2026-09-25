import { sql } from 'kysely';
import type { AppContext } from './context.ts';
import { housekeeping } from './attendance/service.ts';
import { promoteDueDevices } from './devices/service.ts';
import { expireSupportRequests } from './support/service.ts';
import { localDate } from './timetable/dates.ts';
import { materializeAll } from './timetable/service.ts';

/**
 * Background jobs (ADR-0020). No job-queue daemon: `runDueJobs` claims each due
 * job with one atomic UPDATE on `job_runs`, so it runs exactly once however
 * many processes or serverless instances call it. Callers:
 *  - the long-running server: a 30-second timer (`startJobs`);
 *  - Vercel: normal requests (in the background, via waitUntil) and a daily cron.
 *
 *  housekeeping  about every minute: auto-ends attendance 15 min after class end,
 *                wipes session keys 10 min after end (ADR-0011), activates phones
 *                whose rebind cooldown passed, purges used nonces, expires support
 *                requests 15 min after class end.
 *  materialize   once per college day (from 00:15 local): keeps the next 14 days
 *                of class sessions generated (ADR-0019).
 */

export const HOUSEKEEPING_EVERY_MS = 55_000;

async function claimHousekeeping(ctx: AppContext): Promise<boolean> {
  const r = await ctx.db
    .updateTable('job_runs')
    .set({ last_run_at: new Date(ctx.now()) })
    .where('name', '=', 'housekeeping')
    .where('last_run_at', '<', new Date(ctx.now() - HOUSEKEEPING_EVERY_MS))
    .returning('name')
    .executeTakeFirst();
  return Boolean(r);
}

/** Due once per college-local day, from 00:15. */
async function claimMaterialize(ctx: AppContext): Promise<boolean> {
  const tz = ctx.config.timeZone;
  const now = new Date(ctx.now());
  const r = await sql<{ name: string }>`
    update job_runs set last_run_at = ${now}
    where name = 'materialize'
      and (last_run_at at time zone ${tz})::date < ${localDate(ctx.now(), tz)}::date
      and (${now}::timestamptz at time zone ${tz})::time >= '00:15'
    returning name`.execute(ctx.db);
  return r.rows.length > 0;
}

async function finish(ctx: AppContext, name: string, result: unknown, error: unknown): Promise<void> {
  await ctx.db
    .updateTable('job_runs')
    .set({
      last_finished_at: new Date(ctx.now()),
      last_result: error ? null : JSON.stringify(result ?? null),
      last_error: error ? (error instanceof Error ? error.message : String(error)) : null,
    })
    .where('name', '=', name)
    .execute();
}

export async function runDueJobs(ctx: AppContext): Promise<{ ran: string[] }> {
  const ran: string[] = [];
  if (await claimHousekeeping(ctx)) {
    ran.push('housekeeping');
    try {
      const r = await housekeeping(ctx);
      const devicesActivated = await promoteDueDevices(ctx);
      const supportExpired = await expireSupportRequests(ctx);
      const result = { ...r, devicesActivated, supportExpired };
      if (r.autoEnded || r.keysWiped || devicesActivated || supportExpired) ctx.logger.info(result, 'housekeeping');
      await finish(ctx, 'housekeeping', result, null);
    } catch (err) {
      ctx.logger.error({ err }, 'housekeeping failed');
      await finish(ctx, 'housekeeping', null, err);
    }
  }
  if (await claimMaterialize(ctx)) {
    ran.push('materialize');
    try {
      const r = await materializeAll(ctx);
      ctx.logger.info({ sections: r.sections, failed: r.failed.length }, 'timetable materialized');
      await finish(ctx, 'materialize', r, null);
    } catch (err) {
      ctx.logger.error({ err }, 'materialization failed');
      await finish(ctx, 'materialize', null, err);
    }
  }
  return { ran };
}

/** Long-running server: check every 30 s (and once at startup). */
export async function startJobs(ctx: AppContext): Promise<{ stop: () => Promise<void> }> {
  let running: Promise<unknown> = Promise.resolve();
  const tick = () => {
    running = runDueJobs(ctx).catch((err: unknown) => ctx.logger.error({ err }, 'background jobs failed'));
  };
  tick();
  const timer = setInterval(tick, 30_000);
  return {
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
