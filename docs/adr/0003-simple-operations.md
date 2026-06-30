# ADR-0003: One server process + Postgres; no Docker, Redis or monitoring stack

**Context.** The people who will run Argus are not technical. Spec §2 listed Docker Compose, Redis 7, OpenTelemetry, Prometheus/Grafana and Sentry.

**Decision.**
- Production is **one Node program (`server.mjs`) plus Postgres 16+**. It serves the API, both web bundles and the display page, and applies migrations at startup. Install = copy a folder + one settings file, run as a service (systemd unit in `deploy/`; Windows service instructions later).
- **No Redis.** Its spec responsibilities move to Postgres or process memory:
  - nonces → table `used_nonces (device_id, nonce, expires_at)` with a primary key (`INSERT … ON CONFLICT DO NOTHING`), purged periodically;
  - rate limits → in process memory (`@fastify/rate-limit`), correct because Argus runs as one process; move to a Postgres store if a second process is ever added;
  - K_s hot cache → in-process LRU of decrypted keys (ciphertext stays only in the DB);
  - WebSocket fan-out → in-process; Postgres `LISTEN/NOTIFY` if a second process is ever added.
- **No Docker for development.** `pnpm dev` starts a local Postgres folder (`scripts/dev-db.sh`), the API with auto-restart, and the web dev server.
- **No Prometheus/Grafana/OTel.** Structured JSON logs (journald/files) and, in a later milestone, a "System health" page in the admin app (DB, job queue, attestation provider status, last backup, recent errors). Sentry is optional (DSN only).
- Nightly database backups run inside the server (later milestone) with a documented restore command.

**Consequences.** Fewer moving parts to install, update or break. Load (spec M7: 100 classes × 60 students in 60 s) is well within one Node process + Postgres; M7's load test will confirm. Scaling beyond one process would need `LISTEN/NOTIFY` fan-out and shared rate limits, both already Postgres-based.
