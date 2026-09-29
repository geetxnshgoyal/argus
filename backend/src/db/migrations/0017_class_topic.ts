import { sql, type Kysely } from 'kysely';

/** What a class covers today (e.g. "Dijkstra's algorithm"), set by its teacher; shown to students. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table class_sessions add column topic text check (topic is null or length(topic) <= 200)`.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('0017 is not reversible; restore from backup instead');
}
