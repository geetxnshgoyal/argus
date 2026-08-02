import { sql, type Kysely } from 'kysely';

/**
 * M3: device binding (spec §5, protocol §4, ADR-0007/0008/0009).
 *
 *  devices                 a student's phone: two hardware keys + attestation results.
 *                          At most one active and one pending device per student.
 *  device_rebind_requests  a new phone waiting for its cooldown or Acad Ops approval;
 *                          the old phone stays active until then (ADR-0007)
 *  device_bind_challenges  single-use, 5-minute challenges for key attestation
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table devices (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      state text not null check (state in ('active','pending','revoked')),
      platform text not null check (platform in ('android','ios')),
      model text not null default '',
      os_version text not null default '',
      app_version text not null default '',
      -- P-256 public keys, SPKI DER base64url (ADR-0008)
      session_key_spki text not null,
      attempt_key_spki text not null,
      -- What vouched for the keys: 'strongbox' | 'tee' (Android key attestation),
      -- 'app_attest' (iOS), 'dev_bypass' (ARGUS_ATTESTATION_BYPASS, dev only)
      attestation_level text not null check (attestation_level in ('strongbox','tee','app_attest','dev_bypass')),
      -- Android: HMAC(server key, ANDROID_ID), never the raw value (ADR-0009)
      hardware_id_hash text,
      -- iOS App Attest key and its assertion counter (must strictly increase)
      app_attest_key_id text,
      app_attest_public_key text,
      app_attest_counter bigint not null default 0,
      devicecheck_marked boolean not null default false,
      bound_at timestamptz not null default now(),
      activated_at timestamptz,
      revoked_at timestamptz,
      revoke_reason text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check ((state = 'revoked') = (revoked_at is not null)),
      check ((state = 'active') <= (activated_at is not null))
    );
    create unique index devices_one_active_uq on devices (user_id) where state = 'active';
    create unique index devices_one_pending_uq on devices (user_id) where state = 'pending';
    create unique index devices_attempt_key_uq on devices (attempt_key_spki);
    create unique index devices_app_attest_key_uq on devices (app_attest_key_id) where app_attest_key_id is not null;
    create index devices_hardware_idx on devices (hardware_id_hash) where hardware_id_hash is not null;
    create trigger devices_touch before update on devices
      for each row execute function argus_touch_updated_at();

    create table device_rebind_requests (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      old_device_id uuid references devices(id),   -- null for a first binding that needs approval
      new_device_id uuid not null references devices(id),
      -- pending → completed (cooldown passed) | approved (Acad Ops, early) | rejected | cancelled
      status text not null default 'pending' check (status in ('pending','completed','approved','rejected','cancelled')),
      -- Cooldown end; null when only Acad Ops can activate the device (needs_approval).
      eligible_at timestamptz,
      needs_approval boolean not null default false,
      approval_reason text,
      decided_by uuid references users(id),
      decided_at timestamptz,
      decision_note text,
      created_at timestamptz not null default now(),
      check (needs_approval or eligible_at is not null)
    );
    create unique index device_rebind_one_pending_uq on device_rebind_requests (user_id) where status = 'pending';
    create index device_rebind_status_idx on device_rebind_requests (status, created_at);

    create table device_bind_challenges (
      challenge_hash text primary key,
      user_id uuid not null references users(id) on delete cascade,
      expires_at timestamptz not null,
      used_at timestamptz
    );
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('0004 is not reversible; restore from backup instead');
}
