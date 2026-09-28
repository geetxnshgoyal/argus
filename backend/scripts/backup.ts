/**
 * Database backup: one file with everything (pg_dump custom format).
 *
 *   pnpm backup                         # uses DATABASE_URL_UNPOOLED or DATABASE_URL
 *   pnpm backup -- postgres://…         # or an explicit database
 *
 * Writes backups/argus-<database>-<date>-<time>.dump in the repository root
 * (git-ignored). Needs `pg_dump` (installed with PostgreSQL). Check a backup
 * with `pnpm restore:check <file>`; see docs/runbooks/backup-and-restore.md.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.argv[2] ?? process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error('No database: pass a postgres:// URL or set DATABASE_URL.');
  process.exit(2);
}
const dbName = new URL(url).pathname.slice(1) || 'argus';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(root, 'backups');
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
const file = join(dir, `argus-${dbName}-${stamp}.dump`);

console.log(`Backing up database "${dbName}"…`);
const r = spawnSync('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', file, url], { stdio: ['ignore', 'inherit', 'inherit'] });
if (r.error || r.status !== 0) {
  console.error(r.error ? `Could not run pg_dump: ${r.error.message}. Install PostgreSQL client tools.` : 'pg_dump failed (see above).');
  process.exit(1);
}
const mb = (statSync(file).size / 1024 / 1024).toFixed(2);
console.log(`Saved ${relative(process.cwd(), file)} (${mb} MB).`);
console.log(`Next: check it with  pnpm restore:check ${relative(root, file)}`);
