import { sql, type Kysely } from 'kysely';

/**
 * On-duty (OD) requests and student attendance issues (ADR-0027).
 *
 * - New role `community_manager`: first approver of OD requests.
 * - New record status `od` (basis `od`): the student was away on college duty;
 *   it counts as attended but is never shown as "present".
 * - od_requests: whole days or specific classes → community manager → Acad Ops.
 * - attendance_issues: a student disputes a past class → its teacher confirms
 *   (which files an ordinary correction) → Acad Ops approves the correction.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table users drop constraint users_role_check;
    alter table users add constraint users_role_check
      check (role in ('student','teacher','acadops','verifier','admin','community_manager'));

    alter table attendance_records drop constraint attendance_records_status_check;
    alter table attendance_records add constraint attendance_records_status_check
      check (status in ('present','late','absent','excused','pending','od'));
    alter table attendance_records drop constraint attendance_records_basis_check;
    alter table attendance_records add constraint attendance_records_basis_check
      check (basis in ('system','teacher','verifier','correction','od'));

    create table od_requests (
      id uuid primary key,
      student_id uuid not null references users(id),
      kind text not null check (kind in ('days','classes')),
      dates date[] not null default '{}',
      class_session_ids uuid[] not null default '{}',
      event text not null check (length(trim(event)) >= 3),
      reason text not null check (length(trim(reason)) >= 3),
      status text not null default 'pending_cm'
        check (status in ('pending_cm','pending_ops','approved','rejected','cancelled')),
      cm_id uuid references users(id),
      cm_decided_at timestamptz,
      cm_note text,
      ops_id uuid references users(id),
      ops_decided_at timestamptz,
      ops_note text,
      rejected_by_role text check (rejected_by_role in ('community_manager','acadops')),
      created_at timestamptz not null default now(),
      check ((kind = 'days') = (cardinality(dates) > 0)),
      check ((kind = 'classes') = (cardinality(class_session_ids) > 0))
    );
    create index od_requests_student_idx on od_requests (student_id, created_at desc);
    create index od_requests_status_idx on od_requests (status, created_at);
    create index od_requests_approved_idx on od_requests (student_id) where status = 'approved';

    create table attendance_issues (
      id uuid primary key,
      student_id uuid not null references users(id),
      class_session_id uuid not null references class_sessions(id),
      reason text not null check (reason in ('marked_absent_but_present','marked_late_but_on_time','wrong_record','other')),
      note text not null check (length(trim(note)) >= 3),
      status text not null default 'pending_teacher'
        check (status in ('pending_teacher','pending_ops','resolved','declined','cancelled')),
      teacher_id uuid references users(id),
      teacher_note text,
      teacher_decided_at timestamptz,
      correction_id uuid references attendance_corrections(id),
      created_at timestamptz not null default now(),
      resolved_at timestamptz
    );
    create unique index attendance_issues_one_open_uq on attendance_issues (student_id, class_session_id)
      where status in ('pending_teacher','pending_ops');
    create index attendance_issues_teacher_idx on attendance_issues (teacher_id) where status = 'pending_teacher';
    create index attendance_issues_correction_idx on attendance_issues (correction_id);
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('0014 is not reversible; restore from backup instead');
}
