import { sql, type Kysely } from 'kysely';

/** Risk signal for iPhones registered without App Attest (ADR-0024, amended). */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    insert into risk_settings (key, kind, value, description) values
      ('phone_unverified', 'scorer', 30, 'iPhone registered in pilot mode: Apple could not confirm the genuine app on a real iPhone.')
    on conflict (key) do nothing`.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('0012 is not reversible; restore from backup instead');
}
