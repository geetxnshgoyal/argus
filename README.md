# Argus

College attendance that resists proxy attendance. Students mark attendance
with a rotating classroom QR code from a phone bound to them; teachers,
Academic Operations and verifiers work in the web app.

- **Build spec (source of truth):** [docs/spec/phase1-build-spec.md](docs/spec/phase1-build-spec.md), amended by the [ADRs](docs/adr/README.md)
- **Protocol:** [docs/protocol.md](docs/protocol.md)
- **Threat model:** [docs/threat-model.md](docs/threat-model.md)

## Repository layout

```
backend/   Node.js + TypeScript API (Fastify, Kysely, Postgres); bundles to one server.mjs
  api/openapi.yaml   API contract (source of truth for types)
  src/               server code; src/db/migrations/ for schema changes
web/       React SPA: /teacher, /admin, /verify; separate tiny bundle for /display
app/       Flutter student app (native Kotlin/Swift for keys, attestation, location)
deploy/    settings template, systemd unit, install guide
docs/      spec, protocol, threat model, ADRs
scripts/   dev database and dev runner
```

## Development

Prerequisites: Node.js 24, pnpm, PostgreSQL 16+ binaries on PATH
(`brew install postgresql@18`), Flutter (for `app/`). No Docker needed.

```bash
pnpm install
pnpm dev
```

Then `pnpm seed:dev` (once) adds test accounts: `admin@`, `acadops@`, `verifier@`,
`teacher@` and `student@svyasa-sas.edu.in`. Pass a roster export to load real
students locally, e.g. `pnpm seed:dev /path/to/students.json`; only USN, name,
college email, batch and status are read.

In development, sign in with the **Developer sign-in** list on the login page
(web) or the dev sign-in card (debug app builds). Real Google sign-in needs
`OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` (see `deploy/argus.env.example`).

`pnpm dev` starts a local Postgres in `.devdb/` (port 55432), the API on
http://localhost:8080 (restarts on change) and the web app on
http://localhost:5173 (the display is at `/display`). Ctrl-C stops the API and
web; `pnpm db:stop` stops Postgres, `pnpm db:reset` wipes it.

| Command | What it does |
|---|---|
| `pnpm test` | Backend and web tests (set `TEST_DATABASE_URL=postgres://argus@localhost:55432/argus_test` to include DB tests) |
| `pnpm lint` / `pnpm typecheck` | ESLint / TypeScript across backend and web |
| `pnpm gen:api` | Regenerate API types from `backend/api/openapi.yaml` (commit the result) |
| `pnpm build` | Build the web app, then bundle the server into `backend/dist/` |

Flutter app: `cd app && flutter run` with the dev API running. The Android
emulator reaches your machine at `10.0.2.2:8080`; the iOS simulator uses
`localhost:8080`.

## Deployment

One Node program plus Postgres. See [deploy/README.md](deploy/README.md).
