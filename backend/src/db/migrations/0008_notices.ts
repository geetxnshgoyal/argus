import { sql, type Kysely } from 'kysely';

/**
 * Notices from Academic Operations (ADR-0023): announcements, and class changes
 * posted automatically when a timetable override is saved.
 *
 *  notices            what was said, to whom (as chosen), and whether it was withdrawn
 *  notice_recipients  who it reached, fixed when posted; read_at is the read receipt
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table notices (
      id uuid primary key,
      kind text not null check (kind in ('announcement','class_change')),
      title text not null check (length(trim(title)) between 1 and 120),
      body text not null default '' check (length(body) <= 2000),
      -- The audience as chosen, e.g. {"kind":"section","section_id":"…","group_id":null}.
      audience jsonb not null,
      audience_label text not null,
      override_id uuid references timetable_overrides(id),
      class_date date,
      created_by uuid references users(id),
      created_at timestamptz not null default now(),
      withdrawn_at timestamptz,
      withdrawn_by uuid references users(id)
    );
    create index notices_created_idx on notices (created_at desc);
    create index notices_override_idx on notices (override_id) where override_id is not null;

    create table notice_recipients (
      notice_id uuid not null references notices(id) on delete cascade,
      user_id uuid not null references users(id),
      read_at timestamptz,
      primary key (notice_id, user_id)
    );
    create index notice_recipients_user_idx on notice_recipients (user_id, notice_id);
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('0008 is not reversible; restore from backup instead');
}
