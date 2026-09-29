import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.ts';

export type Db = Kysely<Database>;

// DATE columns stay 'YYYY-MM-DD' strings; converting them to JS Dates would
// shift them across time zones. (OID 1082 = date.)
pg.types.setTypeParser(1082, (v: string) => v);
// date[] (OID 1182), e.g. od_requests.dates: '{2026-10-03,2026-10-04}' → ['2026-10-03', '2026-10-04'].
pg.types.setTypeParser(1182 as Parameters<typeof pg.types.setTypeParser>[0], (v: string) => (v === '{}' ? [] : v.slice(1, -1).split(',')));

export function createDb(databaseUrl: string, opts: { max?: number; onPool?: (pool: pg.Pool) => void } = {}): Db {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: opts.max ?? 20,
    // Fail fast instead of hanging requests when the database is unreachable.
    connectionTimeoutMillis: 5_000,
    // Server time is authoritative; keep every session in UTC.
    options: '-c timezone=UTC',
  });
  opts.onPool?.(pool);
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** Cheap liveness probe used by the health endpoint. */
export async function pingDb(db: Db): Promise<void> {
  await sql`select 1`.execute(db);
}

export type Tx = Transaction<Database>;

/** Either the root handle or a transaction; most data functions accept both. */
export type DbOrTx = Db | Tx;
