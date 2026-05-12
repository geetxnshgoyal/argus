import { sql, type Kysely } from 'kysely';

/**
 * M0 foundations. btree_gist is needed for the timetable exclusion
 * constraints (no double-booked rooms/teachers/groups) added in M2.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create extension if not exists btree_gist`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Extensions may be shared with other schemas; never drop them automatically.
}
