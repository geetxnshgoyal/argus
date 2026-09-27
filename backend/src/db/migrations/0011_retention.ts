import { sql, type Kysely } from 'kysely';

/** Daily retention job (spec §13): see src/retention.ts. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`insert into job_runs (name) values ('retention') on conflict do nothing`.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('0011 is not reversible; restore from backup instead');
}
