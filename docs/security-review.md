# Security review (M7)

Date: 2026-09-27. Scope: the backend API, web headers, sign-in, device binding
and attestation, attendance, support/corrections, background jobs. Method: read
every route and its guard, then the areas below; findings were fixed with a
regression test. Done-when for M7: no open high-severity findings.

## Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | Medium | `ARGUS_TRUST_PROXY=true` trusted every `X-Forwarded-For` hop, so a client could choose the left-most address: dodge per-IP rate limits on sign-in and phone registration, and forge the IP in the audit log. On Vercel, leaving the variable unset made every student share one IP (and one rate-limit bucket). | Fixed: trust exactly one hop, always on Vercel. Test: `app.test.ts` "client IP behind a proxy". |
| 2 | Medium | Attestation verifiers (Android key attestation, Play Integrity, App Attest) had no tests; spec §16 #7 was not covered. | Fixed: `attestation.test.ts` (15 cases: emulator, rooted, re-signed, other app, replayed challenge, swapped key, foreign root, revoked, expired, assertion replay). No verifier bug found. |
| 3 | Medium | Retention (spec §13) was documented but not implemented: raw attempt signals were kept forever. | Fixed: daily `retention` job (`src/retention.ts`), tested. |
| 4 | Low | Removing a one-day change whose class already had attendance reported success but kept the class. Not exploitable; misleading for Acad Ops. | Fixed: 409 `session_has_attendance`. |
| 5 | Low | The timetable `.xlsx` upload (Acad Ops only, 8 MB limit) is decompressed by exceljs; a crafted file could use a lot of memory. | Accepted: only trusted staff can upload; the body limit bounds it. |

## Checked, no issue

- **Authorization.** Every `/v1` route has a role guard except the intended public
  ones (health, time, policy, sign-in, display pairing with its in-memory secret,
  cron with `CRON_SECRET`). Teachers only reach their own attendance sessions
  (`started_by` / `teacher_id` checks, including the display key endpoint);
  students only their own records, devices and support requests.
- **Dev shortcuts.** `ARGUS_DEV_LOGIN` and `ARGUS_ATTESTATION_BYPASS` refuse to
  start outside `ARGUS_ENV=dev`.
- **CSRF.** Cookie sessions need the `x-argus-csrf` header on every unsafe method;
  mobile uses bearer tokens signed by the device key.
- **Redirects.** `safeNextPath` allows only same-site relative paths.
- **SQL.** All queries go through Kysely parameters; the only `sql.raw` is a
  trigger name in a migration.
- **Secrets.** Cron secret and CSRF tokens compared in constant time; tokens and
  keys are redacted from logs; session cookies are stored only as hashes.
- **Headers.** API: `no-store`, `nosniff`, `no-referrer`. Pages (server and
  Vercel): strict CSP (`default-src 'self'`, no inline script),
  `frame-ancestors 'none'`, `X-Frame-Options: DENY`. HSTS comes from Vercel or
  the college's HTTPS proxy.
- **Adversarial suite (spec §16).** All 12 items have automated tests
  (`attendance.test.ts`, `support.test.ts`, `audit.test.ts`, `attestation.test.ts`).

## Load test

`pnpm --filter backend loadtest` (see the script header). 100 classes × 60
students scanning within 60 s on a MacBook with local Postgres: all 6000
verified, server-side p95 6 ms (target < 500 ms); the same 6000 in 10 s: p95
30 ms. Repeat against staging on Vercel + Neon before the pilot, where each
database round trip is slower.
