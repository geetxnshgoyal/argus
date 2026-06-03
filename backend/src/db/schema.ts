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
}
