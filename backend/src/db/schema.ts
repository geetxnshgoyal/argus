import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely table types. Keep in sync with src/db/migrations/.
 * Conventions: ids are UUIDv7 strings supplied by the app; `Timestamps`
 * columns default in the database.
 */

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type DateOnly = ColumnType<string, string, string>; // 'YYYY-MM-DD'
type Json<T = unknown> = ColumnType<T, string | undefined | null, string | null>;

interface Timestamps {
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export type Role = 'student' | 'teacher' | 'acadops' | 'verifier' | 'admin';
export const ROLES: readonly Role[] = ['student', 'teacher', 'acadops', 'verifier', 'admin'];

export interface UsersTable extends Timestamps {
  id: string;
  role: Role;
  name: string;
  email: string;
  sso_subject: string | null;
  status: ColumnType<'active' | 'disabled', 'active' | 'disabled' | undefined, 'active' | 'disabled'>;
}

export interface DepartmentsTable extends Timestamps {
  id: string;
  code: string;
  name: string;
}

export interface ProgramsTable extends Timestamps {
  id: string;
  code: string;
  name: string;
  department_id: string;
}

export interface TermsTable extends Timestamps {
  id: string;
  name: string;
  start_date: DateOnly;
  end_date: DateOnly;
}

export interface SectionsTable extends Timestamps {
  id: string;
  program_id: string;
  term_id: string;
  name: string;
}

export interface SectionGroupsTable extends Timestamps {
  id: string;
  section_id: string;
  name: string;
}

export interface StudentsTable extends Timestamps {
  user_id: string;
  usn: string;
  program_id: string;
  section_id: string | null;
  group_id: string | null;
  admission_year: number;
}

export interface TeachersTable extends Timestamps {
  user_id: string;
  faculty_id: string;
  department_id: string;
}

export interface SubjectsTable extends Timestamps {
  id: string;
  code: string;
  name: string;
  kind: 'lecture' | 'lab' | 'tutorial';
}

export interface CampusGeofencesTable extends Timestamps {
  id: string;
  name: string;
  center_lat: number;
  center_lon: number;
  radius_m: number;
  polygon: Json<[number, number][] | null>;
}

export interface RoomsTable extends Timestamps {
  id: string;
  code: string;
  building: ColumnType<string, string | undefined, string>;
  floor: number | null;
  capacity: number | null;
  geofence_id: string | null;
  ble_rssi_threshold: number | null;
}

export interface CampusNetworksTable extends Timestamps {
  id: string;
  cidr: string;
  label: ColumnType<string, string | undefined, string>;
}

export interface CourseOfferingsTable extends Timestamps {
  id: string;
  term_id: string;
  subject_id: string;
  section_id: string;
}

export interface EnrollmentsTable extends Timestamps {
  id: string;
  student_id: string;
  offering_id: string;
  group_id: string | null;
  source: ColumnType<'section' | 'manual', 'section' | 'manual' | undefined, 'section' | 'manual'>;
}

export interface TeachingAssignmentsTable extends Timestamps {
  id: string;
  teacher_id: string;
  offering_id: string;
  group_id: string | null;
  role: ColumnType<'primary' | 'assistant', 'primary' | 'assistant' | undefined, 'primary' | 'assistant'>;
}

export interface WebSessionsTable {
  id_hash: string;
  user_id: string;
  csrf_token: string;
  auth_at: Timestamp;
  created_at: CreatedAt;
  expires_at: Timestamp;
  last_seen_at: Timestamp;
  revoked_at: Timestamp | null;
  ip: string | null;
  user_agent: string | null;
}

export interface OidcLoginStatesTable {
  state: string;
  nonce: string;
  code_verifier: string;
  client: 'web' | 'mobile';
  next_path: string | null;
  app_code_challenge: string | null;
  reauth: ColumnType<boolean, boolean | undefined, boolean>;
  expires_at: Timestamp;
}

export interface MobileAuthCodesTable {
  code_hash: string;
  user_id: string;
  app_code_challenge: string;
  expires_at: Timestamp;
  used_at: Timestamp | null;
}

export interface RefreshTokensTable {
  id: string;
  family_id: string;
  user_id: string;
  token_hash: string;
  session_key_spki: string;
  created_at: CreatedAt;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  revoked_at: Timestamp | null;
}

export interface PolicyAcceptancesTable {
  user_id: string;
  policy_version: string;
  accepted_at: CreatedAt;
}

export interface AuditLogTable {
  id: Generated<string>; // bigserial → string via pg
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: Json;
  after: Json;
  ip: string | null;
  at: Timestamp;
  prev_hash: string;
  hash: string;
}

export interface AuditCheckpointsTable {
  id: Generated<string>;
  last_audit_id: string;
  last_hash: string;
  created_at: CreatedAt;
}

export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
type TimeOfDay = string; // 'HH:MM:SS'

export interface TimetableEntriesTable extends Timestamps {
  id: string;
  term_id: string;
  offering_id: string;
  group_id: string | null;
  weekday: number;
  start_time: TimeOfDay;
  end_time: TimeOfDay;
  room_id: string | null;
  teacher_id: string | null;
  valid_from: string | null;
  valid_to: string | null;
  version: ColumnType<number, number | undefined, number>;
  note: string | null;
}

export interface TimetableOverridesTable {
  id: string;
  term_id: string;
  date: DateOnly;
  entry_id: string | null;
  action: 'cancel' | 'modify' | 'add';
  new_offering_id: string | null;
  new_group_id: string | null;
  new_room_id: string | null;
  new_teacher_id: string | null;
  new_start: TimeOfDay | null;
  new_end: TimeOfDay | null;
  reason: string;
  applies_to_locked: ColumnType<boolean, boolean | undefined, boolean>;
  created_by: string | null;
  created_at: CreatedAt;
  revoked_at: Timestamp | null;
  revoked_by: string | null;
}

export interface TermCalendarDaysTable {
  term_id: string;
  date: DateOnly;
  kind: 'holiday' | 'exam' | 'no_classes' | 'working';
  follows_weekday: number | null;
  note: ColumnType<string, string | undefined, string>;
  created_at: CreatedAt;
}

export type ClassSessionStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled';

export interface ClassSessionsTable extends Timestamps {
  id: string;
  term_id: string;
  offering_id: string;
  group_id: string | null;
  date: DateOnly;
  /** Postgres tstzrange literal, e.g. '["2026-09-21 04:00:00+00","2026-09-21 05:00:00+00")' */
  time_range: string;
  room_id: string | null;
  teacher_id: string | null;
  source_entry_id: string | null;
  source_override_id: string | null;
  status: ColumnType<ClassSessionStatus, ClassSessionStatus | undefined, ClassSessionStatus>;
  attendance_locked: ColumnType<boolean, boolean | undefined, boolean>;
}

export interface ClassSessionAudiencesTable {
  class_session_id: string;
  audience_id: string;
  time_range: string;
  active: ColumnType<boolean, boolean | undefined, boolean>;
}

// ── Devices (M3) ────────────────────────────────────────────────────────────

export type DeviceState = 'active' | 'pending' | 'revoked';
export type AttestationLevel = 'strongbox' | 'tee' | 'app_attest' | 'dev_bypass';

export interface DevicesTable extends Timestamps {
  id: string;
  user_id: string;
  state: DeviceState;
  platform: 'android' | 'ios';
  model: ColumnType<string, string | undefined, string>;
  os_version: ColumnType<string, string | undefined, string>;
  app_version: ColumnType<string, string | undefined, string>;
  session_key_spki: string;
  attempt_key_spki: string;
  attestation_level: AttestationLevel;
  hardware_id_hash: string | null;
  app_attest_key_id: string | null;
  app_attest_public_key: string | null;
  app_attest_counter: ColumnType<string, number | string | undefined, number | string>;
  devicecheck_marked: ColumnType<boolean, boolean | undefined, boolean>;
  bound_at: Timestamp;
  activated_at: Timestamp | null;
  revoked_at: Timestamp | null;
  revoke_reason: string | null;
}

export type RebindStatus = 'pending' | 'completed' | 'approved' | 'rejected' | 'cancelled';

export interface DeviceRebindRequestsTable {
  id: string;
  user_id: string;
  old_device_id: string | null;
  new_device_id: string;
  status: ColumnType<RebindStatus, RebindStatus | undefined, RebindStatus>;
  eligible_at: Timestamp | null;
  needs_approval: ColumnType<boolean, boolean | undefined, boolean>;
  approval_reason: string | null;
  decided_by: string | null;
  decided_at: Timestamp | null;
  decision_note: string | null;
  created_at: CreatedAt;
}

export interface DeviceBindChallengesTable {
  challenge_hash: string;
  user_id: string;
  expires_at: Timestamp;
  used_at: Timestamp | null;
}

// ── Attendance (M4/M5) ──────────────────────────────────────────────────────

export type AttendanceSessionStatus = 'active' | 'ended';

export interface AttendanceSessionsTable extends Timestamps {
  id: string;
  class_session_id: string;
  started_by: string;
  status: ColumnType<AttendanceSessionStatus, AttendanceSessionStatus | undefined, AttendanceSessionStatus>;
  /** bigint → string from pg; Number() it. */
  t0_ms: ColumnType<string, number | string, number | string>;
  epoch_ms: ColumnType<number, number | undefined, number>;
  ks_ciphertext: Buffer | null;
  key_wipe_at: Timestamp | null;
  headcount: number | null;
  started_at: Timestamp;
  ended_at: Timestamp | null;
  ended_by: string | null;
}

export type RoundMode = 'full' | 'targeted' | 'end';

export interface AttendanceRoundsTable {
  id: string;
  session_id: string;
  round_no: number;
  mode: RoundMode;
  opened_at: Timestamp;
  closed_at: Timestamp | null;
  opened_by: string | null;
  target_student_ids: string[] | null;
}

export type AttemptDecision = 'verified' | 'flagged' | 'flagged_high' | 'rejected';

export interface AttemptSignals {
  location: 'inside' | 'outside' | 'unknown';
  accuracy_m: number | null;
  /** Distance outside the geofence, rounded to 50 m (0 = inside). */
  distance_m: number | null;
  is_mock: boolean;
  campus_network: boolean | null;
  /** bypass: dev build; not_required: pilot mode without Play Integrity (ADR-0021). */
  attestation: 'ok' | 'unavailable' | 'missing' | 'bypass' | 'not_required';
  app_version: string;
  extra?: Record<string, unknown>;
}

export interface AttendanceAttemptsTable {
  id: string;
  session_id: string;
  round_id: string | null;
  student_id: string;
  device_id: string;
  received_at: Timestamp;
  device_time: Timestamp | null;
  qr_round: number;
  qr_epoch: ColumnType<string, number | string, number | string>;
  nonce: string;
  tag_valid: ColumnType<boolean, boolean | undefined, boolean>;
  offline_queued: ColumnType<boolean, boolean | undefined, boolean>;
  decision: AttemptDecision;
  reason_codes: ColumnType<string[], string[] | undefined, string[]>;
  risk_score: ColumnType<number, number | undefined, number>;
  signals: Json<AttemptSignals | null>;
  payload_sha256: string;
  created_at: CreatedAt;
}

export type RecordStatus = 'present' | 'late' | 'absent' | 'excused' | 'pending';
export type RecordBasis = 'system' | 'teacher' | 'verifier' | 'correction';

export interface AttendanceRecordsTable extends Timestamps {
  student_id: string;
  class_session_id: string;
  attendance_session_id: string | null;
  status: RecordStatus;
  basis: RecordBasis;
  final_attempt_id: string | null;
  updated_by: string | null;
  note: string | null;
}

export interface UsedNoncesTable {
  device_id: string;
  nonce: string;
  expires_at: Timestamp;
}

export interface DisplayPairingsTable {
  id: string;
  secret_hash: string;
  code: string;
  expires_at: Timestamp;
  session_id: string | null;
  linked_by: string | null;
  linked_at: Timestamp | null;
  created_at: CreatedAt;
}

export interface RiskSettingsTable {
  key: string;
  kind: 'scorer' | 'threshold' | 'setting';
  value: number;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  description: ColumnType<string, string | undefined, string>;
  updated_by: ColumnType<string | null, string | null | undefined, string | null>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export type FlagSeverity = 'low' | 'medium' | 'high';

export interface RiskFlagsTable {
  id: string;
  student_id: string;
  session_id: string | null;
  attempt_id: string | null;
  type: string;
  severity: FlagSeverity;
  details: Json;
  created_at: CreatedAt;
  resolved_by: string | null;
  resolved_at: Timestamp | null;
  resolution: string | null;
}

export type SpotCheckResult = 'confirmed' | 'absent' | 'no_response';

export interface SpotChecksTable {
  id: string;
  session_id: string;
  round_id: string | null;
  student_id: string;
  selected_reason: 'flagged_high' | 'flagged' | 'random' | 'teacher';
  result: SpotCheckResult | null;
  teacher_id: string;
  suggested_at: Timestamp;
  recorded_at: Timestamp | null;
}

export interface PresenceObservationsTable {
  id: string;
  session_id: string;
  student_id: string;
  source: string;
  observed_at: Timestamp;
  data: Json;
}

// ── Support and corrections (M6) ────────────────────────────────────────────

export type SupportReason = 'cant_scan' | 'camera_broken' | 'phone_problem' | 'app_error' | 'other';
export type SupportStatus = 'pending' | 'asked_teacher' | 'approved' | 'rejected' | 'expired';
export type TeacherAnswer = 'present' | 'absent' | 'not_sure';

export interface SupportRequestsTable {
  id: string;
  student_id: string;
  class_session_id: string;
  attendance_session_id: string;
  device_id: string;
  reason: SupportReason;
  note: string | null;
  evidence: Json<Record<string, unknown>>;
  evidence_score: number;
  valid_tag_seen: boolean;
  status: ColumnType<SupportStatus, SupportStatus | undefined, SupportStatus>;
  verifier_id: string | null;
  teacher_id: string | null;
  teacher_answer: TeacherAnswer | null;
  teacher_answered_at: Timestamp | null;
  decided_by: string | null;
  decided_role: 'verifier' | 'teacher' | 'system' | null;
  decision_reason: string | null;
  second_approver_id: string | null;
  created_at: CreatedAt;
  decided_at: Timestamp | null;
}

export type CorrectionStatus = 'pending' | 'approved' | 'rejected';

export interface AttendanceCorrectionsTable {
  id: string;
  student_id: string;
  class_session_id: string;
  old_status: string | null;
  new_status: 'present' | 'late' | 'absent' | 'excused';
  reason: string;
  requested_by: string;
  approved_by: string | null;
  status: ColumnType<CorrectionStatus, CorrectionStatus | undefined, CorrectionStatus>;
  decision_note: string | null;
  created_at: CreatedAt;
  decided_at: Timestamp | null;
}

export interface JobRunsTable {
  name: string;
  last_run_at: ColumnType<Date, Date | string | undefined, Date | string>;
  last_finished_at: Timestamp | null;
  last_result: Json;
  last_error: string | null;
}

// ── Notices (ADR-0023) ─────────────────────────────────────────────────────

export type NoticeKind = 'announcement' | 'class_change';

export type NoticeAudience =
  | { kind: 'everyone' }
  | { kind: 'students' }
  | { kind: 'teachers' }
  | { kind: 'section'; section_id: string; group_id: string | null }
  | { kind: 'offering'; offering_id: string; group_id: string | null };

export interface NoticesTable {
  id: string;
  kind: NoticeKind;
  title: string;
  body: ColumnType<string, string | undefined, string>;
  audience: Json<NoticeAudience>;
  audience_label: string;
  override_id: string | null;
  class_date: DateOnly | null;
  created_by: string | null;
  created_at: CreatedAt;
  withdrawn_at: Timestamp | null;
  withdrawn_by: string | null;
}

export interface NoticeRecipientsTable {
  notice_id: string;
  user_id: string;
  read_at: Timestamp | null;
}

export interface Database {
  users: UsersTable;
  departments: DepartmentsTable;
  programs: ProgramsTable;
  terms: TermsTable;
  sections: SectionsTable;
  section_groups: SectionGroupsTable;
  students: StudentsTable;
  teachers: TeachersTable;
  subjects: SubjectsTable;
  campus_geofences: CampusGeofencesTable;
  rooms: RoomsTable;
  campus_networks: CampusNetworksTable;
  course_offerings: CourseOfferingsTable;
  enrollments: EnrollmentsTable;
  teaching_assignments: TeachingAssignmentsTable;
  web_sessions: WebSessionsTable;
  oidc_login_states: OidcLoginStatesTable;
  mobile_auth_codes: MobileAuthCodesTable;
  refresh_tokens: RefreshTokensTable;
  policy_acceptances: PolicyAcceptancesTable;
  audit_log: AuditLogTable;
  audit_checkpoints: AuditCheckpointsTable;
  timetable_entries: TimetableEntriesTable;
  timetable_overrides: TimetableOverridesTable;
  term_calendar_days: TermCalendarDaysTable;
  class_sessions: ClassSessionsTable;
  class_session_audiences: ClassSessionAudiencesTable;
  devices: DevicesTable;
  device_rebind_requests: DeviceRebindRequestsTable;
  device_bind_challenges: DeviceBindChallengesTable;
  attendance_sessions: AttendanceSessionsTable;
  attendance_rounds: AttendanceRoundsTable;
  attendance_attempts: AttendanceAttemptsTable;
  attendance_records: AttendanceRecordsTable;
  used_nonces: UsedNoncesTable;
  display_pairings: DisplayPairingsTable;
  risk_settings: RiskSettingsTable;
  risk_flags: RiskFlagsTable;
  spot_checks: SpotChecksTable;
  presence_observations: PresenceObservationsTable;
  support_requests: SupportRequestsTable;
  attendance_corrections: AttendanceCorrectionsTable;
  job_runs: JobRunsTable;
  notices: NoticesTable;
  notice_recipients: NoticeRecipientsTable;
  course_offerings_labeled: CourseOfferingsTable & { subject_code: string; subject_name: string; subject_kind: string; section_name: string; term_name: string };
  teaching_assignments_labeled: TeachingAssignmentsTable & { teacher_name: string; subject_code: string; subject_name: string; section_name: string; group_name: string | null };
}
