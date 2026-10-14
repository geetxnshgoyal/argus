# Argus

Attendance for colleges that resists proxy attendance. Students mark attendance
with a rotating classroom QR code from a phone bound to them; teachers,
Academic Operations and community managers work in the web app.

- **Live:** https://argus-attendance.vercel.app (Vercel + Neon Postgres)
- **Android app:** [latest APK](https://github.com/geetxnshgoyal/argus/releases/latest/download/argus.apk) ([all releases](https://github.com/geetxnshgoyal/argus/releases))
- **iPhone:** built from source for now (see [below](#flutter-app)); App Store/TestFlight needs a paid Apple developer account

## What it does

- **Scanning:** the classroom display shows a QR code that changes every 3
  seconds. The phone signs each scan with a hardware key bound to the student
  and unlocked by their own face or fingerprint, and adds a fresh location fix
  and the classroom Wi-Fi it can hear.
- **Anti-proxy checks:** hard checks reject replays, other phones and clearly
  off-campus scans; soft signals (fake GPS, another room's Wi-Fi, no college
  Wi-Fi, a new phone, an unverified iPhone…) only flag a scan for a spot check.
  Admins tune the weights on **Anti-proxy checks** without a redeploy.
- **Classroom Wi-Fi:** rooms list their routers. On Android, Home shows
  "You're in Classroom 6" from the loudest router (worked out on the phone,
  never tracked), and teachers see which room a flagged scan came from
  ([ADR-0030](docs/adr/0030-classroom-wifi-routers.md)).
- **Student app:** Home (class now/next with topic, room and teacher, scan,
  room card), Timetable, Attendance history, Requests (OD with proof files,
  issues with a record) and Profile.
- **Staff web app:** teachers run live attendance, spot checks and
  corrections; Acad Ops manage students, timetable, rooms, phones, notices,
  support requests and final approvals; community managers confirm OD first.
  Corrections and OD always need two different people.
- **Pilot mode:** run alongside paper attendance and compare
  ([ADR-0026](docs/adr/0026-pilot-shadow-mode-and-metrics.md)).

Roles in detail: [docs/runbooks/README.md](docs/runbooks/README.md).

## Docs

- **Build spec (source of truth):** [docs/spec/phase1-build-spec.md](docs/spec/phase1-build-spec.md), amended by the [ADRs](docs/adr/README.md)
- **Protocol:** [docs/protocol.md](docs/protocol.md)
- **Threat model:** [docs/threat-model.md](docs/threat-model.md), **security review:** [docs/security-review.md](docs/security-review.md)
- **Runbooks (ops staff):** [docs/runbooks](docs/runbooks/README.md)

## Repository layout

```
backend/   Node.js + TypeScript API (Fastify, Kysely, Postgres); bundles to one server.mjs
  api/openapi.yaml   API contract (source of truth for types)
  src/               server code; src/db/migrations/ for schema changes
web/       React SPA: /teacher, /admin, /community; separate tiny bundle for /display
app/       Flutter student app (native Kotlin/Swift for keys, attestation, location, Wi-Fi)
deploy/    settings template, systemd unit, install guide
docs/      spec, protocol, threat model, ADRs, runbooks, security review
scripts/   dev database, dev runner, release
tools/     wifi-survey: Mac scanner for finding a room's Wi-Fi routers
```

## Development

Prerequisites: Node.js 24, pnpm, PostgreSQL 16+ binaries on PATH
(`brew install postgresql@18`), Flutter (for `app/`). No Docker needed.

```bash
pnpm install
pnpm dev
```

Then `pnpm seed:dev` (once) adds test accounts: `admin@`, `acadops@`, `acadops2@`, `community@`,
`student@` and `dev.teacher@example.edu`. Set `OIDC_HOSTED_DOMAIN` (e.g. `college.edu` or
`college.edu,partner.co`, teachers on the second) before seeding to use your college's domains. Pass a roster export to load real
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
| `pnpm release 0.0.9` | One version for app, server and web; commits, tags and pushes (GitHub builds the signed APK into the release, Vercel deploys) |
| `sh tools/wifi-survey/survey.sh "Classroom 1"` | Survey a room's routers on a Mac: sit next to each router, the loudest is the one you're next to ([runbook](docs/runbooks/start-of-term.md#classroom-wi-fi-routers)) |
| `pnpm backup [url]` / `pnpm restore:check <file>` | Database backup, and the restore drill ([runbook](docs/runbooks/backup-and-restore.md)) |
| `pnpm --filter backend loadtest` | Load test: 100 classes × 60 students (see the script header) |

### Flutter app

`cd app && flutter run` with the dev API running. The Android emulator reaches
your machine at `10.0.2.2:8080`; the iOS simulator uses `localhost:8080`.
`cd app && flutter test` runs the app tests.

Official builds point at the live server and have no developer sign-in:

```bash
flutter build ios --release --dart-define=ARGUS_API=https://argus-attendance.vercel.app --dart-define=ARGUS_APP_VERSION=0.0.8 --build-name=0.0.8 --build-number=8
```

Install on a connected iPhone with `xcrun devicectl device install app --device <id> build/ios/iphoneos/Runner.app`
(college Wi-Fi blocks wireless installs: use a cable or the phone's hotspot).
Builds signed with a free Apple account stop opening after 7 days, and iPhones
can't read Wi-Fi without a paid account, so the room card is Android-only.

## Deployment

One Node program plus Postgres, set up per college: its Google Workspace
domain(s) (`OIDC_HOSTED_DOMAIN`), name (`ARGUS_INSTITUTION_NAME`), time zone
(`ARGUS_TIMEZONE`), and, in the admin pages, its campus area, rooms, Wi-Fi
routers and college Wi-Fi name. See [deploy/README.md](deploy/README.md).
