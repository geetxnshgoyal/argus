import { sql, type Kysely } from 'kysely';

/**
 * M4/M5: attendance (spec §6, protocol §5, ADR-0004/0005/0010/0011/0014).
 *
 *  attendance_sessions   one per "Start attendance"; holds the encrypted K_s (wiped 10 min after end)
 *  attendance_rounds     full | targeted | end; exactly one open round while active
 *  attendance_attempts   every authenticated attempt, accepted or rejected, with minimized signals
 *  attendance_records    the official result per student per class
 *  used_nonces           replay protection per device (replaces Redis, ADR-0003)
 *  display_pairings      classroom screen ↔ attendance session (ADR-0004)
 *  risk_settings         scorer weights, kill switches, thresholds (ADR-0014)
 *  risk_flags            things a teacher or Acad Ops should look at
 *  spot_checks           teacher's in-room checks and their results
 *  presence_observations Phase 2 hook (BLE etc.), unused in Phase 1
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table attendance_sessions (
      id uuid primary key,
      class_session_id uuid not null references class_sessions(id),
      started_by uuid not null references users(id),
      status text not null default 'active' check (status in ('active','ended')),
      -- Epoch origin (Unix ms, server clock) and epoch length.
      t0_ms bigint not null,
      epoch_ms int not null default 3000 check (epoch_ms between 1000 and 60000),
      -- AES-256-GCM(K_s): nonce(12) ‖ ciphertext(32) ‖ tag(16). Null once wiped.
      ks_ciphertext bytea,
      key_wipe_at timestamptz,
      headcount int check (headcount is null or headcount >= 0),
      started_at timestamptz not null,
      ended_at timestamptz,
      ended_by uuid references users(id),      -- null when ended automatically
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check ((status = 'ended') = (ended_at is not null))
    );
    create unique index attendance_sessions_one_active_uq on attendance_sessions (class_session_id) where status = 'active';
    create index attendance_sessions_class_idx on attendance_sessions (class_session_id);
    create index attendance_sessions_active_idx on attendance_sessions (status) where status = 'active';
    create trigger attendance_sessions_touch before update on attendance_sessions
      for each row execute function argus_touch_updated_at();

    create table attendance_rounds (
      id uuid primary key,
      session_id uuid not null references attendance_sessions(id) on delete cascade,
      round_no int not null check (round_no >= 1),
      mode text not null check (mode in ('full','targeted','end')),
      opened_at timestamptz not null,
      closed_at timestamptz,
      opened_by uuid references users(id),
      -- Targeted rounds: the students who must scan again. Null = everyone.
      target_student_ids uuid[],
      unique (session_id, round_no)
    );
    create unique index attendance_rounds_one_open_uq on attendance_rounds (session_id) where closed_at is null;

    create table attendance_attempts (
      id uuid primary key,
      session_id uuid not null references attendance_sessions(id),
      round_id uuid references attendance_rounds(id),   -- null if the claimed round doesn't exist
      student_id uuid not null references users(id),
      device_id uuid not null references devices(id),
      received_at timestamptz not null,
      device_time timestamptz,
      qr_round int not null,
      qr_epoch bigint not null,
      nonce text not null,
      -- The QR tag was cryptographically valid for this session and round (ADR-0006),
      -- even if the attempt was rejected for another reason (e.g. grace window).
      tag_valid boolean not null default false,
      offline_queued boolean not null default false,
      decision text not null check (decision in ('verified','flagged','flagged_high','rejected')),
      reason_codes text[] not null default '{}',
      risk_score int not null default 0,
      -- Minimized signals only; raw coordinates are never stored. Purged after 90 days.
      signals jsonb,
      payload_sha256 text not null,
      created_at timestamptz not null default now()
    );
    -- One accepted attempt per student per round (spec §6 step 7).
    create unique index attendance_attempts_one_accepted_uq on attendance_attempts (round_id, student_id) where decision <> 'rejected';
    create index attendance_attempts_session_idx on attendance_attempts (session_id, student_id);
    create index attendance_attempts_student_idx on attendance_attempts (student_id, received_at);

    create table attendance_records (
      student_id uuid not null references users(id),
      class_session_id uuid not null references class_sessions(id),
      attendance_session_id uuid references attendance_sessions(id),
      -- pending: offline-queued attempt awaiting teacher confirmation (ADR-0010)
      status text not null check (status in ('present','late','absent','excused','pending')),
      basis text not null check (basis in ('system','teacher','verifier','correction')),
      final_attempt_id uuid references attendance_attempts(id),
      updated_by uuid references users(id),
      note text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (student_id, class_session_id)
    );
    create index attendance_records_class_idx on attendance_records (class_session_id);
    create trigger attendance_records_touch before update on attendance_records
      for each row execute function argus_touch_updated_at();

    create table used_nonces (
      device_id uuid not null,
      nonce text not null,
      expires_at timestamptz not null,
      primary key (device_id, nonce)
    );
    create index used_nonces_expires_idx on used_nonces (expires_at);

    create table display_pairings (
      id uuid primary key,
      -- SHA-256 of the display's in-memory secret; the secret never leaves the display page.
      secret_hash text not null,
      code text not null,
      expires_at timestamptz not null,
      session_id uuid references attendance_sessions(id),
      linked_by uuid references users(id),
      linked_at timestamptz,
      created_at timestamptz not null default now(),
      check ((session_id is null) = (linked_at is null))
    );
    create unique index display_pairings_open_code_uq on display_pairings (code) where session_id is null;

    -- ─── Risk (ADR-0014) ─────────────────────────────────────────────────────
    create table risk_settings (
      key text primary key,
      kind text not null check (kind in ('scorer','threshold','setting')),
      value int not null,
      enabled boolean not null default true,
      description text not null default '',
      updated_by uuid references users(id),
      updated_at timestamptz not null default now()
    );
    insert into risk_settings (key, kind, value, description) values
      ('location_mock',            'scorer',    70, 'The phone reported a fake (mock) location.'),
      ('location_poor_accuracy',   'scorer',    20, 'Location accuracy worse than 100 m, or no location fix.'),
      ('not_campus_network',       'scorer',    15, 'The scan did not come from a campus network.'),
      ('late_in_window',           'scorer',    10, 'The QR code used was from the previous 3-second step.'),
      ('device_recently_rebound',  'scorer',    15, 'The phone was registered in the last 7 days.'),
      ('attestation_unavailable',  'scorer',    20, 'Google/Apple could not be reached to check the app.'),
      ('attestation_missing',      'scorer',    35, 'The app could not produce an integrity token.'),
      ('recent_flag_history',      'scorer',    10, 'Points per unresolved flag in the last 14 days.'),
      ('recent_flag_history_cap',  'setting',   30, 'Maximum points from recent flags.'),
      ('threshold_flagged',        'threshold', 30, 'Score at which an attempt is flagged.'),
      ('threshold_flagged_high',   'threshold', 70, 'Score at which an attempt is flagged high.'),
      ('recheck_random_sample',    'setting',    3, 'Random verified students added to a targeted recheck.'),
      ('spot_check_flagged_max',   'setting',    5, 'Flagged students suggested per spot check.'),
      ('spot_check_random',        'setting',    3, 'Random verified students suggested per spot check.'),
      ('headcount_tolerance',      'setting',    2, 'Extra present students allowed over the headcount.'),
      ('late_after_minutes',       'setting',   10, 'A recheck opened this long after class start marks new scans late.');

    create table risk_flags (
      id uuid primary key,
      student_id uuid not null references users(id),
      session_id uuid references attendance_sessions(id),
      attempt_id uuid references attendance_attempts(id),
      type text not null,
      severity text not null check (severity in ('low','medium','high')),
      details jsonb,
      created_at timestamptz not null default now(),
      resolved_by uuid references users(id),
      resolved_at timestamptz,
      resolution text,
      check ((resolved_at is null) = (resolution is null))
    );
    create index risk_flags_student_idx on risk_flags (student_id, created_at);
    create index risk_flags_session_idx on risk_flags (session_id);
    create index risk_flags_open_idx on risk_flags (created_at) where resolved_at is null;

    create table spot_checks (
      id uuid primary key,
      session_id uuid not null references attendance_sessions(id),
      round_id uuid references attendance_rounds(id),
      student_id uuid not null references users(id),
      selected_reason text not null check (selected_reason in ('flagged_high','flagged','random','teacher')),
      result text check (result in ('confirmed','absent','no_response')),
      teacher_id uuid not null references users(id),
      suggested_at timestamptz not null,
      recorded_at timestamptz,
      check ((result is null) = (recorded_at is null))
    );
    create index spot_checks_session_idx on spot_checks (session_id);

    -- Phase 2 hook (spec §12): BLE and other presence evidence. Unused in Phase 1.
    create table presence_observations (
      id uuid primary key,
      session_id uuid not null references attendance_sessions(id),
      student_id uuid not null references users(id),
      source text not null,
      observed_at timestamptz not null,
      data jsonb
    );
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('0005 is not reversible; restore from backup instead');
}
