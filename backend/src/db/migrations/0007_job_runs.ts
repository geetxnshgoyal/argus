import { sql, type Kysely } from 'kysely';

/**
 * Background jobs without a job-queue daemon (ADR-0020). A job is claimed by an
 * atomic UPDATE on its row, so exactly one process or serverless instance runs
 * it when it is due, whether it was started by a timer, a request or a cron.
 * Replaces pg-boss; its old `pgboss` schema, if present, is left untouched.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table job_runs (
      name text primary key,
      last_run_at timestamptz not null default 'epoch',
      last_finished_at timestamptz,
      last_result jsonb,
      last_error text
    );
    insert into job_runs (name) values ('housekeeping'), ('materialize');
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('0007 is not reversible; restore from backup instead');
}
