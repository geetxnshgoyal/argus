import { sql, type Kysely } from 'kysely';

/** Phone notification addresses (FCM registration tokens), one row per app install (ADR-0025). */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table push_tokens (
      token text primary key,
      user_id uuid not null references users(id) on delete cascade,
      platform text not null check (platform in ('android','ios')),
      created_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now()
    );
    create index push_tokens_user_idx on push_tokens (user_id);
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('0010 is not reversible; restore from backup instead');
}
