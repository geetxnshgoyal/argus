/**
 * Backup drill: proves a backup file can be restored and is intact.
 *
 *   pnpm restore:check backups/argus-….dump
 *
 * 1. creates a scratch database next to RESTORE_ADMIN_URL
 *    (default: the local dev Postgres, postgres://argus@localhost:55432/postgres);
 * 2. restores the file into it with pg_restore;
 * 3. applies any newer migrations (the app does this at startup anyway);
 * 4. recomputes the whole audit hash chain (any edited or missing row fails);
 * 5. prints row counts of the main tables, then drops the scratch database.
 *
 * Nothing touches the live database. Exit code 0 = the backup is good.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { sql } from 'kysely';
import { verifyAuditChain } from '../src/audit/audit.ts';
import { createDb } from '../src/db/index.ts';
import { migrateToLatest } from '../src/db/migrate.ts';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error('Usage: pnpm restore:check <backup file>');
  process.exit(2);
}
const adminUrl = process.env.RESTORE_ADMIN_URL ?? 'postgres://argus@localhost:55432/postgres';
const scratch = `argus_restore_check_${Date.now()}`;
const scratchUrl = (() => {
  const u = new URL(adminUrl);
  u.pathname = `/${scratch}`;
  return u.toString();
})();

const admin = createDb(adminUrl);
let ok = false;
try {
  await sql`create database ${sql.id(scratch)}`.execute(admin);
  console.log(`1. Scratch database ${scratch} created.`);

  const r = spawnSync('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', scratchUrl, file], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.error || r.status !== 0) throw new Error(r.error ? `could not run pg_restore: ${r.error.message}` : 'pg_restore failed (see above)');
  console.log('2. Backup restored.');

  const db = createDb(scratchUrl);
  try {
    const m = await migrateToLatest(db);
    if (m.error) throw m.error;
    const applied = (m.results ?? []).filter((x) => x.status === 'Success').map((x) => x.migrationName);
    console.log(`3. Schema up to date${applied.length ? ` (applied newer migrations: ${applied.join(', ')})` : ''}.`);

    const chain = await verifyAuditChain(db);
    if (!chain.ok) throw new Error(`audit chain broken at ${chain.problem?.id}: ${chain.problem?.reason}`);
    console.log(`4. Audit chain intact: ${chain.checked} entries, last hash ${chain.lastHash.slice(0, 16)}…`);

    const tables = ['users', 'students', 'devices', 'class_sessions', 'attendance_sessions', 'attendance_records', 'support_requests', 'audit_log'];
    const counts: string[] = [];
    for (const t of tables) {
      const { rows } = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(t)}`.execute(db);
      counts.push(`${t} ${rows[0]?.n ?? 0}`);
    }
    console.log(`5. Rows: ${counts.join(', ')}.`);
    ok = true;
  } finally {
    await db.destroy();
  }
} catch (err) {
  console.error(`Backup check FAILED: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await sql`drop database if exists ${sql.id(scratch)} with (force)`.execute(admin).catch(() => undefined);
  await admin.destroy();
}
console.log(ok ? '\nBackup is good.' : '\nBackup is NOT usable. Keep the previous one and investigate.');
process.exit(ok ? 0 : 1);
