# ADR-0020: Hosting on Vercel; jobs without a daemon

**Context.** The college wants Argus hosted on Vercel rather than on a server of its own. ADR-0003 assumed one long-running Node process: pg-boss workers, in-memory Server-Sent Events fan-out, in-memory rate limits. Vercel runs code as Functions: instances are shared across requests, scale to zero, and never run in the background on their own.

**Decision.**
- **One function, static pages.** `pnpm build:vercel` writes `.vercel/output` (Build Output API): the web app and classroom display are static files on Vercel's CDN; every `/v1/*` request is rewritten to one bundled Node 24 function (`backend/src/vercel.ts`) that boots Fastify once per instance. Pages keep the CSP and security headers the server sends. Region `sin1` (Singapore), next to the database.
- **Database:** Neon Postgres from the Vercel Marketplace, Singapore region, **direct (unpooled) connection** with a small pool per instance (`DATABASE_POOL_MAX`, default 5 on Vercel). The connection pool is handed to `attachDatabasePool`. Migrations run when an instance boots; Kysely's migration lock serializes them.
- **Jobs without a daemon (replaces pg-boss everywhere).** `job_runs` has one row per job; `runDueJobs` claims a due job with an atomic `UPDATE … WHERE last_run_at < …`, so it runs exactly once globally. The long-running server calls it every 30 s. On Vercel, requests call it in the background (`waitUntil`, at most every 30 s per instance), and a daily Vercel Cron (`GET /v1/internal/cron` with `CRON_SECRET`) covers quiet days. During class, the display polls every few seconds, so housekeeping (auto-end, key wipe, phone activation, support expiry) runs about every minute.
- **Live panel:** the events endpoint returns 204 on Vercel, and the teacher page polls `/live` every 3 s. The long-running server keeps instant push.
- **Per-instance state is only a cache:** decrypted session keys (a wiped key in the database also clears the cache), risk settings (5 s), the attestation revocation list.
- **Rate limits are per instance** on Vercel, so they are looser than on one server. Nonces, one accepted attempt per round, and all authorization stay in Postgres.

**Consequences.** Nothing to install or patch; HTTPS, which Google sign-in needs, comes for free. The same code still runs as one server (`server.mjs`) for an on-premises install. The old `pgboss` schema, if present, is unused. Moving to Vercel Pro would let the cron run every minute; if rate limits must be exact, add Vercel WAF rate-limit rules.
