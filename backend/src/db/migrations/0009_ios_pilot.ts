import { sql, type Kysely } from 'kysely';

/** iPhone pilot mode (ADR-0024): phones registered without App Attest are recorded as 'unattested'. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table devices drop constraint devices_attestation_level_check;
    alter table devices add constraint devices_attestation_level_check
      check (attestation_level in ('strongbox','tee','app_attest','unattested','dev_bypass'));
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('0009 is not reversible; restore from backup instead');
}
