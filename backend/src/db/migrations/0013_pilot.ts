import { sql, type Kysely } from 'kysely';

/**
 * Pilot support (spec §15 M8, ADR-0026). `app_settings` holds switches admins
 * flip at runtime; `shadow_mode` = attendance is computed as usual but is not
 * official. Each attendance session records the mode it was taken in, so
 * history stays right after the pilot ends.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table app_settings (
      key text primary key,
      value jsonb not null,
      updated_by uuid references users(id),
      updated_at timestamptz not null default now()
    );
    insert into app_settings (key, value) values ('shadow_mode', 'false');
    alter table attendance_sessions add column shadow boolean not null default false;
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('0013 is not reversible; restore from backup instead');
}
