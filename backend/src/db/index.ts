import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.ts';

export type Db = Kysely<Database>;

// DATE columns stay 'YYYY-MM-DD' strings; converting them to JS Dates would
// shift them across time zones. (OID 1082 = date.)
pg.types.setTypeParser(1082, (v: string) => v);

export function createDb(databaseUrl: string): Db {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 20,
    // Fail fast instead of hanging requests when the database is unreachable.
    connectionTimeoutMillis: 5_000,
    // Server time is authoritative; keep every session in UTC.
    options: '-c timezone=UTC',
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** Cheap liveness probe used by the health endpoint. */
export async function pingDb(db: Db): Promise<void> {
  await sql`select 1`.execute(db);
}

export type Tx = Transaction<Database>;

/** Either the root handle or a transaction; most data functions accept both. */
export type DbOrTx = Db | Tx;
