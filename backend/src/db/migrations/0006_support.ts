import { sql, type Kysely } from 'kysely';

/**
 * M6: support requests and corrections (spec §7, ADR-0006, ADR-0010).
 *
 *  support_requests        a student who couldn't mark attendance asks for help during class;
 *                          evidence is snapshotted at request time; a verifier approves (only with
 *                          low risk AND a valid QR tag from this session), asks the teacher, or rejects
 *  attendance_corrections  after class: changes need a requester (teacher or Acad Ops) and a
 *                          different Acad Ops/admin approver (two-person rule, enforced by the DB)
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table support_requests (
      id uuid primary key,
      student_id uuid not null references users(id),
      class_session_id uuid not null references class_sessions(id),
      attendance_session_id uuid not null references attendance_sessions(id),
      device_id uuid not null references devices(id),
      reason text not null check (reason in ('cant_scan','camera_broken','phone_problem','app_error','other')),
      note text,
      -- Snapshot at request time (spec §7): identity, session, attempts, device, location/network results, flags, 30-day history.
      evidence jsonb not null,
      evidence_score int not null,
      -- ADR-0006: the student's bound phone submitted a cryptographically valid tag for this session.
      valid_tag_seen boolean not null,
      status text not null default 'pending' check (status in ('pending','asked_teacher','approved','rejected','expired')),
      verifier_id uuid references users(id),
      teacher_id uuid references users(id),
      teacher_answer text check (teacher_answer in ('present','absent','not_sure')),
      teacher_answered_at timestamptz,
      decided_by uuid references users(id),
      decided_role text check (decided_role in ('verifier','teacher','system')),
      decision_reason text,
      -- Phase 1 keeps the second approver off (ADR-0010); the column is here for when it is switched on.
      second_approver_id uuid references users(id),
      created_at timestamptz not null default now(),
      decided_at timestamptz,
      check ((status in ('approved','rejected','expired')) = (decided_at is not null))
    );
    -- One open request per student per class.
    create unique index support_requests_one_open_uq on support_requests (student_id, class_session_id) where status in ('pending','asked_teacher');
    create index support_requests_status_idx on support_requests (status, created_at);
    create index support_requests_teacher_idx on support_requests (teacher_id) where status = 'asked_teacher';

    create table attendance_corrections (
      id uuid primary key,
      student_id uuid not null references users(id),
      class_session_id uuid not null references class_sessions(id),
      old_status text,
      new_status text not null check (new_status in ('present','late','absent','excused')),
      reason text not null check (length(trim(reason)) >= 3),
      requested_by uuid not null references users(id),
      approved_by uuid references users(id),
      status text not null default 'pending' check (status in ('pending','approved','rejected')),
      decision_note text,
      created_at timestamptz not null default now(),
      decided_at timestamptz,
      -- Two different people (spec §9, §16 #11).
      constraint attendance_corrections_two_person check (approved_by is null or approved_by <> requested_by),
      check ((status = 'pending') = (decided_at is null))
    );
    create unique index attendance_corrections_one_pending_uq on attendance_corrections (student_id, class_session_id) where status = 'pending';
    create index attendance_corrections_status_idx on attendance_corrections (status, created_at);

    insert into risk_settings (key, kind, value, description) values
      ('support_approval_threshold', 'threshold', 30, 'Verifiers can approve a support request only below this evidence score (and with a valid QR scan).');
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('0006 is not reversible; restore from backup instead');
}
