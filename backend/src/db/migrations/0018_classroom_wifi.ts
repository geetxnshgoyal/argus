import { sql, type Kysely } from 'kysely';

/**
 * ADR-0030: classroom Wi-Fi routers. rooms.wifi_routers holds each room's router
 * ids (first five octets of the BSSID); wifi_observations counts the strongest
 * college router seen in verified scans per room, so Acad Ops can accept them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table rooms add column wifi_routers text[] not null default '{}';
    create table wifi_observations (
      room_id uuid not null references rooms(id) on delete cascade,
      router_id text not null check (router_id ~ '^([0-9a-f]{2}:){4}[0-9a-f]{2}$'),
      seen int not null default 0,
      last_seen_at timestamptz not null default now(),
      primary key (room_id, router_id)
    );
    insert into app_settings (key, value) values ('campus_wifi_ssid_prefix', '"SVYASA"') on conflict do nothing;
    insert into risk_settings (key, kind, value, description) values
      ('wifi_other_room', 'scorer', 15, 'The phone saw only other classrooms'' Wi-Fi routers, not this room''s.'),
      ('wifi_not_campus', 'scorer', 25, 'The phone saw no college Wi-Fi at all.')
    on conflict (key) do nothing;
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('0018 is not reversible; restore from backup instead');
}
