import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, pingDb } from '../src/db/index.ts';
import { migrateToLatest } from '../src/db/migrate.ts';

// Integration test: needs a real Postgres. Locally `pnpm db:start` provides
// argus_test; CI provides a Postgres service. Skipped when unset.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('migrations (integration)', () => {
  const db = createDb(url as string);
  afterAll(() => db.destroy());

  it('apply cleanly and are idempotent', async () => {
    const first = await migrateToLatest(db);
    expect(first.error).toBeUndefined();
    const second = await migrateToLatest(db);
    expect(second.error).toBeUndefined();
    expect(second.results).toEqual([]);
  });

  it('enable btree_gist for timetable exclusion constraints', async () => {
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from pg_extension where extname = 'btree_gist'`.execute(db);
    expect(rows[0]?.n).toBe(1);
  });

  it('run database sessions in UTC', async () => {
    await pingDb(db);
    const { rows } = await sql<{ tz: string }>`select current_setting('timezone') as tz`.execute(db);
    expect(rows[0]?.tz).toBe('UTC');
  });
});
