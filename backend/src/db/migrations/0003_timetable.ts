import { sql, type Kysely } from 'kysely';

/**
 * M2: timetable (spec §8, ADR-0012).
 *
 *  timetable_entries     weekly defaults per term (never mutated for one-off changes)
 *  timetable_overrides   date-specific cancel | modify | add
 *  term_calendar_days    holidays / exams / "Saturday follows Monday"
 *  class_sessions        materialized instances (next 14 days); attendance points here
 *  class_session_audiences  one row per batch a session occupies, so the DB can
 *                        reject a batch being in two places at once (exclusion constraint)
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- 'section': created by enrollment sync for students of the offering's section;
    -- 'manual': added by Acad Ops (e.g. electives across sections). Sync touches only 'section'.
    alter table enrollments add column source text not null default 'manual' check (source in ('section','manual'));

    create table timetable_entries (
      id uuid primary key,
      term_id uuid not null references terms(id),
      offering_id uuid not null references course_offerings(id),
      group_id uuid references section_groups(id),     -- null = whole section
      weekday smallint not null check (weekday between 1 and 7),  -- ISO: 1 = Monday
      start_time time not null,
      end_time time not null,
      room_id uuid references rooms(id),
      teacher_id uuid references teachers(user_id),    -- null = use the teaching assignment
      valid_from date,
      valid_to date,
      version int not null default 1,
      note text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check (end_time > start_time),
      check (valid_to is null or valid_from is null or valid_to >= valid_from)
    );
    create index timetable_entries_term_idx on timetable_entries (term_id, weekday);
    create trigger timetable_entries_touch before update on timetable_entries
      for each row execute function argus_touch_updated_at();

    create table timetable_overrides (
      id uuid primary key,
      term_id uuid not null references terms(id),
      date date not null,
      entry_id uuid references timetable_entries(id),
      action text not null check (action in ('cancel','modify','add')),
      new_offering_id uuid references course_offerings(id),
      new_group_id uuid references section_groups(id),
      new_room_id uuid references rooms(id),
      new_teacher_id uuid references teachers(user_id),
      new_start time,
      new_end time,
      reason text not null check (length(trim(reason)) > 0),
      -- Confirmed by Acad Ops even though the class already has attendance (spec §8).
      applies_to_locked boolean not null default false,
      created_by uuid references users(id),
      created_at timestamptz not null default now(),
      revoked_at timestamptz,
      revoked_by uuid references users(id),
      check ((action = 'add') = (entry_id is null)),
      check (action <> 'add' or (new_offering_id is not null and new_start is not null and new_end is not null)),
      check (new_end is null or new_start is null or new_end > new_start)
    );
    create index timetable_overrides_date_idx on timetable_overrides (term_id, date) where revoked_at is null;
    -- At most one active cancel/modify per entry per date.
    create unique index timetable_overrides_entry_date_uq on timetable_overrides (entry_id, date)
      where revoked_at is null and entry_id is not null;

    create table term_calendar_days (
      term_id uuid not null references terms(id) on delete cascade,
      date date not null,
      kind text not null check (kind in ('holiday','exam','no_classes','working')),
      follows_weekday smallint check (follows_weekday between 1 and 7),
      note text not null default '',
      created_at timestamptz not null default now(),
      primary key (term_id, date),
      check (follows_weekday is null or kind = 'working')
    );

    create table class_sessions (
      id uuid primary key,
      term_id uuid not null references terms(id),
      offering_id uuid not null references course_offerings(id),
      group_id uuid references section_groups(id),
      date date not null,
      time_range tstzrange not null,
      room_id uuid references rooms(id),
      teacher_id uuid references teachers(user_id),
      source_entry_id uuid references timetable_entries(id),
      source_override_id uuid references timetable_overrides(id),
      status text not null default 'scheduled' check (status in ('scheduled','in_progress','completed','cancelled')),
      -- Set once attendance exists; locked sessions are never rewritten by the materializer.
      attendance_locked boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check (not isempty(time_range)),
      constraint class_sessions_room_overlap exclude using gist (room_id with =, time_range with &&)
        where (status <> 'cancelled' and room_id is not null) deferrable initially immediate,
      constraint class_sessions_teacher_overlap exclude using gist (teacher_id with =, time_range with &&)
        where (status <> 'cancelled' and teacher_id is not null) deferrable initially immediate
    );
    -- One session per weekly entry per date (a "modify" override edits that same session).
    create unique index class_sessions_entry_date_uq on class_sessions (source_entry_id, date) where source_entry_id is not null;
    create unique index class_sessions_add_uq on class_sessions (source_override_id) where source_entry_id is null;
    create index class_sessions_date_idx on class_sessions (date);
    create index class_sessions_teacher_idx on class_sessions (teacher_id, date);
    create index class_sessions_offering_idx on class_sessions (offering_id, date);
    create trigger class_sessions_touch before update on class_sessions
      for each row execute function argus_touch_updated_at();

    create table class_session_audiences (
      class_session_id uuid not null references class_sessions(id) on delete cascade,
      audience_id uuid not null,        -- a batch id, or the section id for "whole section"
      time_range tstzrange not null,
      active boolean not null default true,
      primary key (class_session_id, audience_id),
      constraint class_session_audience_overlap exclude using gist (audience_id with =, time_range with &&)
        where (active) deferrable initially immediate
    );

    -- Readable views for admin lists (labels instead of bare ids).
    create view course_offerings_labeled as
      select o.*, s.code as subject_code, s.name as subject_name, s.kind as subject_kind,
             sec.name as section_name, t.name as term_name
      from course_offerings o
      join subjects s on s.id = o.subject_id
      join sections sec on sec.id = o.section_id
      join terms t on t.id = o.term_id;

    create view teaching_assignments_labeled as
      select ta.*, u.name as teacher_name, s.code as subject_code, s.name as subject_name,
             sec.name as section_name, g.name as group_name
      from teaching_assignments ta
      join users u on u.id = ta.teacher_id
      join course_offerings o on o.id = ta.offering_id
      join subjects s on s.id = o.subject_id
      join sections sec on sec.id = o.section_id
      left join section_groups g on g.id = ta.group_id;
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('0003 is not reversible; restore from backup instead');
}
