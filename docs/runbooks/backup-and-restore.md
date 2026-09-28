# Backup and restore

**Who:** the developer, once a month (15 minutes), and after any data loss.

## What must be kept safe

1. **The database** (all records).
2. **`ARGUS_MASTER_KEY`** (in Vercel settings or `argus.env`). Keep a copy in
   the college's password manager. Without it, sign-in tokens and running
   classes reset, and phones reused by another student can't be recognised;
   records themselves are not lost.

## Automatic backups

- **Vercel + Neon:** Neon keeps a restorable history (point-in-time restore).
  Check the history length on your Neon plan (Neon console → Settings); the
  free plan keeps only a short window, so also do the monthly copy below.
- **Own server:** use your server's backup tool, or schedule the monthly
  copy below with cron.

## Monthly copy and drill

On a computer with PostgreSQL client tools and this repository:

```bash
pnpm backup "<DATABASE_URL_UNPOOLED from Vercel>"
pnpm restore:check backups/argus-….dump
```

`restore:check` restores the file into a throwaway database on your
computer, brings the schema up to date, **re-checks every audit log entry's
hash**, prints row counts and deletes the throwaway database. It must end
with **"Backup is good."** Keep the file somewhere safe (not in git; the
`backups/` folder is ignored) and delete copies older than a year.

Last drill: 2026-09-28 on the development database: restored, 2 newer
migrations applied, 132 audit entries verified. A truncated file was
correctly reported as "NOT usable".

## Restoring after data loss

**Neon (preferred):** Neon console → **Branches** → create a branch from a
time just before the problem → copy its connection string → Vercel → Settings
→ Environment Variables → set `DATABASE_URL_UNPOOLED` to it → **Redeploy**.
Check `/v1/health`, then Admin → Audit log → **Check integrity**.

**From a backup file:**
1. Create an empty database (Neon: a new branch or database; own server:
   `createdb argus_restored`).
2. `pg_restore --no-owner --no-privileges --dbname "<new database URL>" backups/argus-….dump`
3. Point Argus at it (Vercel setting or `argus.env`) and restart / redeploy.
4. Admin → Audit log → **Check integrity** must say the chain is intact.

Anything done after the backup was taken is lost; announce a notice and
re-enter it with corrections.
