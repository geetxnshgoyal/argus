import { sql } from 'kysely';
import { createDb, type Db } from '../../src/db/index.ts';
import { migrateToLatest } from '../../src/db/migrate.ts';

/**
 * Integration-test database. Uses TEST_DATABASE_URL (locally the argus_test
 * database from `pnpm db:start`). Tests that need it use `describe.skipIf(!hasDb)`.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const hasDb = Boolean(TEST_DATABASE_URL);

let shared: Db | undefined;

export async function testDb(): Promise<Db> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL not set');
  if (!shared) {
    shared = createDb(TEST_DATABASE_URL);
    const { error } = await migrateToLatest(shared);
    if (error) throw error;
  }
  return shared;
}

/**
 * Empties every application table. audit_log is append-only by design, so
 * its protection triggers are disabled only for the duration of the reset
 * (tests run as the database owner).
 */
export async function resetDb(db: Db): Promise<void> {
  const { rows } = await sql<{ tablename: string }>`
    select tablename from pg_tables
    where schemaname = 'public' and tablename not like 'kysely_%' and tablename not like 'pgboss%'`.execute(db);
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  await sql`
    alter table audit_log disable trigger audit_log_no_truncate;
    ${sql.raw(`truncate ${list} restart identity cascade`)};
    alter table audit_log enable trigger audit_log_no_truncate;
  `.execute(db);
}

export async function closeTestDb(): Promise<void> {
  await shared?.destroy();
  shared = undefined;
}
