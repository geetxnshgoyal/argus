import { PgBoss } from 'pg-boss';
import type { AppContext } from './context.ts';
import { materializeAll } from './timetable/service.ts';

/**
 * Background jobs on pg-boss (Postgres-backed; no extra service, ADR-0003).
 *
 *  materialize  nightly at 00:15 college time, and once at startup: keeps the
 *               next 14 days of class sessions generated.
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

  return { stop: () => boss.stop({ graceful: true }) };
}
