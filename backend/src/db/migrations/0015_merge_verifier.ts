import { sql, type Kysely } from 'kysely';

/**
 * ADR-0028: the verifier role is merged into Academic Operations. Existing
 * verifier accounts become Acad Ops accounts; support requests are decided by
 * Acad Ops (the evidence rules of ADR-0006 are unchanged).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    update users set role = 'acadops' where role = 'verifier';
    alter table users drop constraint users_role_check;
    alter table users add constraint users_role_check
      check (role in ('student','teacher','acadops','admin','community_manager'));
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('0015 is not reversible; restore from backup instead');
}
