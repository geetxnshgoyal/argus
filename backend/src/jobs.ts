import { PgBoss } from 'pg-boss';
import type { AppContext } from './context.ts';
import { housekeeping } from './attendance/service.ts';
import { promoteDueDevices } from './devices/service.ts';
import { expireSupportRequests } from './support/service.ts';
import { materializeAll } from './timetable/service.ts';

/**
 * Background jobs on pg-boss (Postgres-backed; no extra service, ADR-0003).
 *
 *  materialize  nightly at 00:15 college time, and once at startup: keeps the
 *               next 14 days of class sessions generated.
 *  housekeeping every minute: auto-ends attendance 15 min after class end,
 *               wipes session keys 10 min after end (ADR-0011), activates
 *               phones whose rebind cooldown passed, purges used nonces, and
 *               expires support requests 15 min after class end.
 */
export async function startJobs(ctx: AppContext): Promise<{ stop: () => Promise<void> }> {
  const boss = new PgBoss({ connectionString: ctx.config.databaseUrl, schema: 'pgboss' });
  boss.on('error', (err: unknown) => ctx.logger.error({ err }, 'job queue error'));
  await boss.start();

  await boss.createQueue('materialize');
  await boss.work('materialize', async () => {
    const r = await materializeAll(ctx);
    ctx.logger.info({ sections: r.sections, failed: r.failed.length }, 'timetable materialized');
    return r;
  });
  await boss.schedule('materialize', '15 0 * * *', null, { tz: ctx.config.timeZone });
  await boss.send('materialize', {});

  await boss.createQueue('housekeeping');
  await boss.work('housekeeping', async () => {
    const r = await housekeeping(ctx);
    const promoted = await promoteDueDevices(ctx);
    const expired = await expireSupportRequests(ctx);
    if (r.autoEnded || r.keysWiped || promoted || expired) ctx.logger.info({ ...r, devicesActivated: promoted, supportExpired: expired }, 'housekeeping');
    return r;
  });
  await boss.schedule('housekeeping', '* * * * *', null, { tz: ctx.config.timeZone });

  return { stop: () => boss.stop({ graceful: true }) };
}
