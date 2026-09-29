import { sql, type Kysely } from 'kysely';

/**
 * ADR-0029: attempt keys bound to the phone's current fingerprints/faces.
 * devices.biometric_only = the attempt key accepts only a fingerprint/face and
 * is void once one is added (verified from key attestation on Android).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table devices add column biometric_only boolean not null default false;
    insert into risk_settings (key, kind, value, description) values
      ('no_biometric_lock', 'scorer', 10, 'The phone has no fingerprint or face set up, so its screen lock (PIN) confirms scans.')
    on conflict (key) do nothing;
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('0016 is not reversible; restore from backup instead');
}
