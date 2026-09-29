import { sql, type Kysely } from 'kysely';

/**
 * Proof for OD requests (ADR-0027 amendment): a photo or PDF of the event
 * letter. Stored in Postgres (no extra service, ADR-0003); small and few.
 * Deleted by the retention job 180 days after the request is decided.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table od_attachments (
      id uuid primary key,
      od_request_id uuid not null references od_requests(id) on delete cascade,
      filename text not null check (length(filename) between 1 and 120),
      content_type text not null check (content_type in ('image/jpeg','image/png','application/pdf')),
      size int not null check (size between 1 and 3145728),
      sha256 text not null,
      data bytea not null,
      created_at timestamptz not null default now()
    );
    create index od_attachments_request_idx on od_attachments (od_request_id);
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('0019 is not reversible; restore from backup instead');
}
