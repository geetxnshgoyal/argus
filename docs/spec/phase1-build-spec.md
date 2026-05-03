# Argus — Build Prompt (Phase 1)

> **Status:** source of truth for Phase 1, **as amended by the ADRs in
> [`docs/adr/`](../adr/README.md)**. Where an ADR conflicts with this text, the
> ADR wins. Major amendments: Node.js/TypeScript backend instead of Go
> (ADR-0001), teachers web-only (ADR-0002), no Docker/Redis/Prometheus
> (ADR-0003), display pairing with a round-scoped QR key (ADR-0004), and the
> other security changes in ADR-0005 to ADR-0011.
>
> The text below is the original prompt, unchanged.

You are a senior software engineer and security engineer building Argus, a production college attendance system whose core goal is resisting proxy attendance. Build it milestone by milestone as specified below. Treat this document as the source of truth. Where it is ambiguous, stop and ask rather than guess. Where you make a design decision not covered here, record it as a short ADR in docs/adr/.

## How to work

- Work one milestone at a time. At the start of each milestone, restate its scope, list the files you plan to create or change, then implement.
- Every milestone ends with passing tests, updated docs, and a short summary of what was built and what's left.
- Security-critical code (signatures, HMAC, nonces, attestation, authz checks) must have unit tests including negative cases. No "TODO: add security later".
- Never log secrets, session keys, tokens, raw attestation blobs, or precise student locations.
- All authorization checks happen on the server. Never trust the client for role, enrollment, time, or location decisions beyond the signals it reports.
- Server time is authoritative everywhere.
- Prefer boring, well-maintained libraries. No unnecessary microservices.

## 1. Product summary

Three user groups plus verifiers:

- Students: log in, see timetable, scan the rotating QR to mark attendance, see attendance history, request support if marking fails.
- Teachers: see today's classes, start attendance only for classes assigned to them, watch live results, run targeted rechecks, do spot checks, confirm support requests, end attendance.
- Academic Operations (Acad Ops): manage timetable (defaults + date-specific overrides), subjects, rooms, sections, lab groups, teacher and student mappings; approve device rebinds and attendance corrections; view sessions and audit logs.
- Verifiers: review support requests with evidence; cannot approve low-evidence requests without teacher confirmation.

### Phase 1 anti-proxy layers (in scope)

- College SSO (OIDC). No Argus passwords.
- Device binding: hardware-backed, non-exportable signing key; one active device per student; rebind cooldown.
- App attestation: Play Integrity (Android), App Attest (iOS).
- Rotating QR: 3-second epochs derived from a per-session secret.
- Campus location check: fresh precise fix at scan time, geofence with accuracy radius, mock detection.
- Replay protection: signed payloads, nonces, one accepted attempt per student per round.
- Human layer: random + risk-based spot checks, headcount prompt, teacher confirmation for support requests.
- Soft flags: late-window scans, not from campus network, mock/poor location, recently rebound device.
- Published proxy penalty policy (organizational; the app shows the policy on first login).

### Out of scope for Phase 1 (but design hooks required)

BLE beacons/classroom nodes, Wi-Fi controller / RADIUS integration, Wi-Fi RTT, UWB, camera headcount, co-location analytics, face verification. See §12 for hooks.

### Known residual risks (accepted for Phase 1)

- Live relay from on campus (friend sends QR to someone in hostel/canteen): mitigated only by spot checks and location flags until BLE in Phase 2.
- Friend physically carrying the absent student's bound phone (or a spare bound phone): mitigated by spot checks; analytics in Phase 2.

## 2. Tech stack

| Part | Choice |
|---|---|
| Backend | Go 1.23+, chi router, pgx + sqlc, golang-migrate |
| DB | PostgreSQL 16 (with btree_gist), Redis 7 |
| Background jobs | River (Postgres-backed) |
| Realtime | WebSocket (teacher live dashboard) |
| Mobile | One Flutter app (student + teacher roles) with native Kotlin/Swift modules for key generation/signing, attestation, and location. Do not use third-party Flutter plugins for keys or attestation. |
| Web | Vite + React + TypeScript SPA, TanStack Query/Router/Table. Routes: /admin, /verify, /display/:token (display is a tiny separate bundle). |
| Auth | College Google Workspace or Microsoft Entra ID via OIDC (auth code + PKCE). Dev: mock-oauth2-server or Dex. |
| Push | Firebase Cloud Messaging (Android + iOS via APNs) |
| Ops | Docker Compose for dev; Docker images for prod; OpenTelemetry, Prometheus/Grafana, Sentry |

## 3. Repository layout

```
argus/
  backend/
    cmd/api/            # HTTP + WebSocket server
    cmd/worker/         # River jobs (materialization, retention, reports)
    internal/
      auth/             # OIDC, tokens, roles
      devices/          # binding, rebind, attestation verification
      timetable/        # entries, overrides, materialization, conflicts
      attendance/       # sessions, rounds, attempts, records, QR crypto
      risk/             # pluggable scorers + rules engine
      support/          # support requests, evidence, decisions
      spotcheck/
      audit/            # hash-chained append-only log
      geo/              # geofence checks
      notify/           # FCM
      platform/         # config, db, redis, logging, crypto helpers
    migrations/
    queries/            # sqlc
  app/                  # Flutter app + android/ + ios/ native modules
  web/                  # Vite React SPA
  deploy/               # docker-compose, Dockerfiles, env templates
  docs/
    protocol.md         # attendance protocol (keep in sync with code)
    threat-model.md
    adr/
```

## 4. Roles and authorization

Roles: student, teacher, acadops, verifier, admin. Role comes from the DB (mapped from SSO subject/email), never from the client.

Key rules:

- Teacher may start attendance only if class_session.teacher_id = me and now ∈ [start − 10 min, end] and session status is scheduled.
- Student attempts accepted only if enrolled in the class session's offering (and lab group if the session is group-specific).
- Verifier can view support requests and evidence, not modify timetables or records directly.
- Attendance records change only through the attempt pipeline, teacher/verifier decisions in the support flow, or attendance_corrections with two-person approval.

## 5. Authentication and device binding

### Login

- OIDC auth code + PKCE. Backend issues access tokens (15 min) and refresh tokens (rotating, 30 days).
- For mobile, refresh tokens are bound to the device key: refresh requests must be signed by the bound device key.
- Staff (teacher/acadops/verifier/admin) web sessions: httpOnly secure cookies, 12 h max, re-auth for sensitive actions.

### Device binding

- After first login, the app's native module generates an ECDSA P-256 key:
  - Android: Android Keystore, StrongBox if available, non-exportable, setUserAuthenticationRequired(true) with a short validity window (device unlock / biometric).
  - iOS: Secure Enclave key, .privateKeyUsage, access control requiring device passcode/biometry.
- App calls POST /v1/devices/bind with public key + attestation:
  - Android: Play Integrity standard token with requestHash = SHA256(bind_payload); also send Keystore key attestation certificate chain and verify it server-side.
  - iOS: App Attest attestation object for a key tied to this binding; set a DeviceCheck bit marking the physical device as bound.
- Server enforces one active device per student.
- Binding a new device creates a device_rebind_request: old device revoked immediately; new device cannot submit attendance until eligible_at (default 48 h) unless Acad Ops approves after an ID check. Max 2 rebinds per semester (configurable).
- Teachers also bind a device (for signed actions from mobile), but without cooldown.

### Dev mode

Attestation verification may be bypassed only when ARGUS_ENV=dev AND the build is a debug build. Production must refuse to start if the bypass flag is set.

## 6. Attendance protocol (implement exactly; document in docs/protocol.md)

### Session start

- Teacher calls POST /v1/teacher/class-sessions/{id}/attendance/start.
- Server validates authorization (§4), creates attendance_session + round 1 (mode=full), generates K_s = 32 random bytes.
- K_s stored encrypted (AES-256-GCM with master key from env/KMS) in the DB and in Redis for the hot path with TTL = session end + 15 min.
- Server returns a one-time display token (valid 5 min, single use). Teacher opens /display/{token} on the classroom PC.
- Display page exchanges the token for {session_id, round, t0, epoch_ms=3000, K_s, server_time} and computes its clock offset.

### QR generation (display page, client-side)

- epoch = floor((server_now − t0) / 3000)
- tag = HMAC-SHA256(K_s, "qr" || session_id || round || epoch) truncated to 12 bytes, base64url
- QR content: argus://a/{session_id}/{round}/{epoch}/{tag}
- Use WebCrypto for HMAC. Full-screen, high-contrast, large QR. Screen Wake Lock API. Keep working offline for brief outages. Wipe K_s when session ends. Never use localStorage.
- Show round number and a countdown ring; no student data on the display.

### Student attempt

- Student opens Scan. Native module requests a fresh precise location fix (reject cached fixes older than 30 s). If only approximate permission is granted, prompt for precise.
- App builds payload (canonical JSON, RFC 8785 JCS):

```json
{
  "v": 1,
  "session_id": "...",
  "round": 1,
  "epoch": 1234,
  "tag": "...",
  "device_id": "...",
  "nonce": "<16 random bytes b64url>",
  "device_time": "RFC3339",
  "location": {"lat": 0, "lon": 0, "accuracy_m": 0, "fix_age_ms": 0, "is_mock": false},
  "signals": {},
  "app_version": "x.y.z"
}
```

- Sign SHA256(canonical_payload) with the device key (ECDSA P-256).
- Attach attestation: Play Integrity standard token with requestHash = SHA256(canonical_payload), or App Attest assertion with clientDataHash = SHA256(canonical_payload).
- POST /v1/attendance/attempts.

### Server validation (hard checks → reject with reason code)

In this order, fail fast:

1. Device exists, bound to the authenticated student, not revoked, past eligible_at.
2. Signature valid over canonical payload.
3. Attestation valid and bound to this payload hash. (On attestation-provider outage: do not reject; mark attestation_unavailable flag.)
4. Session open; round open; student enrolled (and in lab group if applicable).
5. Epoch valid: equals the current server epoch, or equals current − 1 and the request arrived ≤ 2000 ms after the epoch boundary. Tag matches.
6. Nonce unused: Redis SET argus:nonce:{device_id}:{nonce} 1 NX EX 120.
7. No accepted attempt for this student in this round (DB unique partial index).
8. Location: reject if clearly off campus, i.e. distance_to_geofence − accuracy_m > 0 AND accuracy_m ≤ 100 AND not mock. Clear message to student.

### Soft signals (risk scorers, each with weight + kill switch in config)

| Signal | Default weight |
|---|---|
| location_mock | +50 |
| location_poor_accuracy (> 100 m) or no fix | +20 |
| not_campus_network (source IP not in campus CIDRs) | +15 |
| late_in_window (accepted via previous-epoch grace) | +10 |
| device_recently_rebound (< 7 days) | +15 |
| attestation_unavailable | +20 |
| recent_flag_history | +10 per flag in last 14 days, cap +30 |

Decision:

- score < 30 → verified
- 30 ≤ score < 70 → flagged (counted present, shown to teacher, prioritized for spot checks)
- score ≥ 70 → flagged_high (counted present pending teacher/spot-check resolution; shown at top)

Thresholds configurable. Soft signals never auto-reject.

### Storage

- Store the attempt with decision, reason codes, score, and a minimized signals record: location result (inside|outside|unknown), accuracy_m, distance to geofence rounded to 50 m, is_mock. Do not persist raw coordinates.
- Push update to the teacher's WebSocket channel.

### Rounds and rechecks

- mode=full: all enrolled students must scan.
- mode=targeted (default for rechecks): only unmarked + flagged + random sample; everyone else's app shows "You're verified, nothing to do."
- mode=end: optional end-of-class sweep.
- A new round uses the same K_s but a different round value in the HMAC input, so tags never collide across rounds.

### Spot checks

- Teacher taps "Spot check": server suggests all flagged_high + flagged students (up to 5) + k random verified students (default 3), random-weighted by risk.
- Teacher records confirmed | absent | no_response. absent → record becomes absent, risk_flag created, visible to Acad Ops.

### Headcount prompt

Teacher may enter an approximate headcount. If marked_present > headcount + tolerance (default 2), dashboard suggests additional spot checks.

### End

POST /v1/attendance/sessions/{id}/end: close open round, delete K_s from Redis and zero the encrypted copy, finalize attendance_records (unmarked → absent), keep support window open until class end.

### Offline behavior

- Display keeps generating QR offline.
- Student app may queue a signed attempt for up to 10 minutes if the network is down; server accepts late-arriving queued attempts only if the epoch was valid at device_time within tolerance AND marks them flagged with offline_queued, requiring teacher confirmation.

## 7. Support / verification workflow

- Student taps "Request Attendance Support" during class (only from bound device; only while class session is ongoing).
- App submits a signed request; server captures a fresh evidence snapshot: identity, session, all attempts this session with reason codes, device info + attestation result, location result, campus network result, risk flags, last 30 days of attendance and flags.
- Evidence score computed with the same scorers.
- Verifier actions:
  - Approve: only allowed if evidence score is below the approval threshold.
  - Ask teacher: sends FCM push to the teacher: "Is {name} ({USN}) in the room?" → Yes / No / Call out. Teacher answer is recorded and decides the request.
  - Reject with reason.
- After the class ends, changes go only through attendance_corrections: teacher attestation + Acad Ops approval (two different people).
- Everything is audited.

## 8. Timetable

- timetable_entries: weekly defaults per term (weekday, start, end, offering, group, room, teacher, valid_from/to).
- timetable_overrides: date-specific cancel | modify | add, referencing an entry for cancel/modify. Never mutate defaults for one-off changes.
- class_sessions: materialized instances for the next 14 days (River job nightly + on any entry/override change). Resolution: override > default.
- Postgres exclusion constraints (btree_gist) on class_sessions to prevent overlapping time_range for the same room, teacher, and section/group (excluding cancelled).
- Importer: CSV/XLSX upload with dry-run validation report (unknown subjects/rooms/teachers, conflicts) before commit.
- Conflicts endpoint lists violations and near-conflicts.
- If a class session already has an attendance session, overrides that change it require confirmation and are audited.

## 9. Database schema (Postgres)

Use UUID v7 primary keys, timestamptz everywhere, created_at/updated_at on mutable tables.

### Organisation

- users(id, role, name, email UNIQUE, sso_subject UNIQUE, status)
- students(user_id PK FK, usn UNIQUE, program_id, section_id, admission_year)
- teachers(user_id PK FK, faculty_id UNIQUE, department_id)
- departments, programs, terms(id, name, start_date, end_date)
- sections(id, program_id, term_id, name), section_groups(id, section_id, name)
- subjects(id, code UNIQUE, name, kind[lecture|lab|tutorial])
- rooms(id, code UNIQUE, building, floor, capacity, geofence_id, ble_rssi_threshold NULL)
- campus_geofences(id, name, center_lat, center_lon, radius_m, polygon JSONB NULL)
- campus_networks(id, cidr)

### Academic

- course_offerings(id, term_id, subject_id, section_id)
- enrollments(student_id, offering_id, group_id NULL) UNIQUE(student_id, offering_id)
- teaching_assignments(teacher_id, offering_id, group_id NULL, role[primary|assistant])

### Timetable

- timetable_entries(id, term_id, offering_id, group_id, weekday, start_time, end_time, room_id, teacher_id, valid_from, valid_to, version)
- timetable_overrides(id, date, entry_id NULL, action, new_room_id, new_teacher_id, new_start, new_end, reason, created_by)
- class_sessions(id, offering_id, group_id, date, time_range TSTZRANGE, room_id, teacher_id, source_entry_id, source_override_id, status[scheduled|in_progress|completed|cancelled]) + exclusion constraints

### Attendance

- attendance_sessions(id, class_session_id, started_by, started_at, ended_at, status, key_ciphertext, config JSONB) — partial unique: one active per class_session
- attendance_rounds(id, session_id, round_no, mode, started_at, ended_at, target_student_ids UUID[])
- attendance_attempts(id, round_id, student_id, device_id, received_at, epoch, decision[verified|flagged|flagged_high|rejected], reason_codes TEXT[], risk_score, signals JSONB, nonce) — partial unique (round_id, student_id) where decision <> 'rejected'
- attendance_records(student_id, class_session_id, status[present|absent|excused|late], basis[system|teacher|verifier|correction], final_attempt_id) PK(student_id, class_session_id)
- attendance_corrections(id, student_id, class_session_id, old_status, new_status, reason, requested_by, approved_by, status, created_at) — CHECK requested_by <> approved_by
- spot_checks(id, round_id, student_id, selected_reason, result, teacher_id, at)
- display_tokens(token_hash, session_id, expires_at, used_at)

### Security

- devices(id, user_id, public_key, platform, model, os_version, attestation_level, devicecheck_marked, bound_at, eligible_at, revoked_at, revoke_reason) — partial unique (user_id) where revoked_at IS NULL
- device_rebind_requests(id, user_id, new_device_id, status, eligible_at, approved_by)
- risk_flags(id, student_id, session_id, attempt_id, type, severity, details JSONB, resolved_by, resolution)
- support_requests(id, student_id, class_session_id, reason, evidence JSONB, evidence_score, status, verifier_id, teacher_confirmation, decision, decision_reason, second_approver_id, created_at, decided_at)
- presence_observations(id, session_id, student_id, source, observed_at, data JSONB) — unused in Phase 1, required for Phase 2

### Audit

- audit_log(id BIGSERIAL, actor_id, action, entity_type, entity_id, before JSONB, after JSONB, ip, at, prev_hash, hash)
- hash = SHA256(prev_hash || canonical(row without hash))
- Application DB role has INSERT/SELECT only on this table. Provide a verification command that walks the chain.

## 10. API (REST, /v1, JSON; errors as {code, message, details})

### Auth & devices

- GET /auth/oidc/login, POST /auth/oidc/callback, POST /auth/refresh, POST /auth/logout
- POST /devices/bind, GET /devices/me, POST /devices/rebind-request
- GET /time (server time for clock sync)

### Student

- GET /me/timetable?from&to, GET /me/attendance?offering_id, GET /me/sessions/active
- POST /attendance/attempts
- POST /support-requests, GET /support-requests/{id}

### Teacher

- GET /teacher/sessions/today, GET /teacher/class-sessions/{id}
- POST /teacher/class-sessions/{id}/attendance/start
- POST /attendance/sessions/{id}/rounds {mode}
- POST /attendance/sessions/{id}/end
- GET /attendance/sessions/{id}/live, WS /ws/attendance/{id}
- POST /attendance/sessions/{id}/spot-checks/suggest, POST /attendance/sessions/{id}/spot-checks
- POST /attendance/sessions/{id}/headcount
- POST /support-requests/{id}/teacher-confirmation
- POST /teacher/class-sessions/{id}/room-change

### Display

- POST /display/exchange {token} → session crypto params (single use)

### Acad Ops

- POST /admin/timetable/import?dry_run=true|false
- CRUD /admin/timetable/entries, /admin/timetable/overrides
- GET /admin/conflicts
- CRUD /admin/{subjects|rooms|sections|groups|offerings|enrollments|teaching-assignments|geofences|campus-networks}
- GET /admin/attendance/sessions, GET /admin/attendance/sessions/{id}
- POST /admin/attendance/corrections, POST /admin/attendance/corrections/{id}/approve
- GET /admin/rebind-requests, POST /admin/rebind-requests/{id}/approve|reject
- GET /admin/risk/flags, GET /admin/audit, POST /admin/audit/verify

### Verifier

- GET /verifier/support-requests?status, GET /verifier/support-requests/{id}
- POST /verifier/support-requests/{id}/decision {approve|ask_teacher|reject, reason}

Rate limits (Redis): per device on /attendance/attempts (e.g. 10/min), per user on auth endpoints. Provide an OpenAPI spec in backend/api/openapi.yaml kept in sync with handlers.

## 11. Frontends

### Student (Flutter)

- Today view: current/next class, room, teacher, override badge.
- Scan screen: camera QR scanner; parallel location fix; clear result states: Verified / Flagged ("marked, teacher may confirm") / Rejected with actionable fix ("Enable precise location", "You appear to be off campus", "This device is not yet active — rebind pending until …").
- Attendance history per subject with percentage.
- Support request button + status.
- Device screen: bound device, rebind request.
- First-login: policy + privacy notice acceptance (stored with version).

### Teacher (Flutter, and same screens in the web SPA)

- Current class card with expected count; Start / Recheck (targeted default, full optional) / End.
- Live panel: Present X/Y, Not marked list, Flagged list with plain-language reasons, Spot-check button, headcount input.
- Support confirmation inbox (push-driven).
- "Room changed" action.

### Acad Ops (web)

- Timetable grid (week view) with default vs override layers; import with dry-run report; conflicts page.
- Mapping screens; geofence and campus network config.
- Sessions browser; corrections queue (two-person); rebind approvals; risk flag reports; audit search + chain verification.

### Verifier (web)

- Queue; evidence card; decision buttons with enforced rules.

### Display (web, separate bundle)

- As specified in §6. Minimal JS, no student data.

## 12. Phase 2 hooks (build now, leave unused)

- signals{} object in attempt payload, accepted and stored.
- Risk engine: scorers implement an interface Score(ctx, attempt, observations) (points int, flags []Flag); registered by name with weight + enabled flag from config.
- presence_observations table and ingestion interface.
- Keys derived from K_s by label ("qr", future "ble"), so BLE tokens share epochs.
- rooms.ble_rssi_threshold column.
- Integration endpoints namespace /v1/integrations/* reserved (mTLS).

## 13. Privacy and retention

- Consent notice: location is read once per scan, only during an attendance round; no background tracking.
- Store only minimized location results (§6).
- Retention job: raw attempt signals purged after 90 days (keep decision + reason codes); attendance records per university policy.
- Evidence access is role-restricted and itself audited.
- Designed with India's DPDP Act 2023 in mind: purpose limitation, minimization, access logging.

## 14. Failure handling

| Failure | Required behavior |
|---|---|
| Classroom network down | Display continues offline; student offline queue (§6) |
| Backend down | Teacher can record manual roll call in app; uploaded later as correction requiring Acad Ops approval |
| Attestation provider outage | Flag, never mass-reject; alert |
| No/poor location indoors | Flag, don't reject |
| Student phone dead/lost | Support flow with teacher confirmation; rebind via Acad Ops |
| Wrong room in timetable | Teacher room-change action, audited, Acad Ops notified |
| Misbehaving signal | Disable scorer via config without redeploy |
| Clock skew | All epochs from server time; display syncs via /time |

## 15. Milestones (implement in order)

- **M0 — Foundations.** Monorepo, Docker Compose (Postgres, Redis, mock OIDC), CI (lint, test, build for all three projects), config loading, structured logging, migrations tooling, OpenAPI skeleton, docs/protocol.md and docs/threat-model.md drafted from this file. Done when: docker compose up gives a working API health check, web SPA shell, and Flutter app shell.
- **M1 — Auth, roles, org data, audit.** OIDC login for web and mobile, token issuance/refresh, role mapping, org + academic tables, admin CRUD for mappings, audit log with hash chain and verify command. Done when: users of each role can log in and see role-appropriate shells; every admin mutation is audited.
- **M2 — Timetable.** Entries, overrides, materialization job, exclusion constraints, importer with dry-run, conflicts endpoint, Acad Ops timetable UI, student/teacher timetable views. Done when: a real term imports, an override on one date changes only that session, and double-booking is rejected by the DB.
- **M3 — Device binding and attestation.** Native key modules (Android/iOS), bind endpoint, Play Integrity + App Attest + Android key attestation verification, DeviceCheck bit, rebind flow with cooldown and Acad Ops approval. Done when: a second device cannot mark attendance for 48 h without approval; tampered or emulator builds fail attestation in a staging test.
- **M4 — Attendance core.** Session start with authz, K_s handling, display token + display page, QR generation, signed attempts, full server validation (§6 hard checks), nonce store, location check, records finalization, end session. Done when: end-to-end scan works on a budget Android, a Samsung, and an iPhone; replayed/expired/forged attempts are rejected in tests.
- **M5 — Risk, live dashboard, rechecks, spot checks.** Scorer framework + Phase 1 scorers, decisions, WebSocket live panel, targeted/full/end rounds, spot-check suggestion and recording, headcount prompt. Done when: a teacher can run a whole class session including a targeted recheck and spot check from phone or web.
- **M6 — Support and corrections.** Support requests with evidence snapshot, verifier console with enforced rules, FCM teacher confirmation, corrections with two-person approval. Done when: a verifier cannot approve a low-evidence request without teacher confirmation, and all paths are audited.
- **M7 — Hardening.** Load test (simulate 100 concurrent classes × 60 students scanning within 60 s; target p95 attempt latency < 500 ms server-side), security review, adversarial test suite (§16), accessibility pass, retention job, runbooks, backup/restore drill. Done when: no open high-severity findings; restore drill succeeds.
- **M8 — Pilot support.** Shadow mode flag (attendance computed but not official), metrics dashboard: false-reject rate, time-to-mark, support-request rate, spot-check miss rate, flag distribution.

## 16. Adversarial test suite (automated where possible)

- Login as another student on an unbound device → attempt rejected.
- Two accounts on one device → second bind blocked or cooldown enforced.
- Replay a captured attempt → nonce rejection.
- Old QR (> grace) → epoch rejection.
- Tag from another round/session → rejection.
- Modified payload after signing → signature rejection.
- Debug/emulator/rooted build in staging → attestation failure.
- Mock location → flagged; off-campus with good accuracy → rejected.
- Teacher starting a class not assigned to them / outside time window → 403.
- Verifier approving a high-risk request directly → blocked.
- Correction approved by its requester → blocked.
- Audit row tampered in DB → chain verification fails.

## 17. Acceptance criteria for Phase 1 pilot

- False rejects < 2% of genuine attempts.
- Median time from scan to marked < 10 s.
- Support requests < 3% of students per session.
- Teacher time on attendance < 2 min per class.
- All adversarial tests pass.
