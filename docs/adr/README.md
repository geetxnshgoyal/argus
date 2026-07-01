# Architecture Decision Records

Short records of decisions not covered by, or changing, the
[Phase 1 build spec](../spec/phase1-build-spec.md). Where an ADR conflicts with
the spec, the ADR wins. Status is `Accepted` unless marked otherwise.

| # | Decision | Milestone |
|---|---|---|
| [0001](0001-node-typescript-backend.md) | Node.js + TypeScript backend instead of Go | M0 |
| [0002](0002-teachers-web-only.md) | Teachers use the web app; the Flutter app is student-only | M0 |
| [0003](0003-simple-operations.md) | One server process + Postgres; no Docker, Redis or monitoring stack | M0 |
| [0004](0004-display-pairing-and-round-keys.md) | Display pairing from the teacher's side; display gets a round-scoped QR key, never K_s | M4 |
| [0005](0005-attempt-validation-order.md) | Cheap checks (nonce, epoch, tag) before attestation | M4 |
| [0006](0006-verifier-approval-needs-qr-evidence.md) | Verifier "Approve" also needs a valid QR tag from the session | M6 |
| [0007](0007-rebind-keeps-old-device-until-eligible.md) | Rebind keeps the old device active until the new one is eligible | M3 |
| [0008](0008-two-device-keys.md) | Two device keys: session key (no user auth) + attempt key (user auth) | M3 |
| [0009](0009-android-same-device-detection.md) | Keyed hash of ANDROID_ID for same-device detection | M3 |
| [0010](0010-attendance-semantics-defaults.md) | Rounds, lateness, spot-check and offline outcomes; mock-location weight 70 | M4–M5 |
| [0011](0011-protocol-encoding.md) | Protocol encoding: exact-bytes signatures, binary HMAC inputs, in-app QR only, key retention | M4 |
| [0012](0012-term-calendar.md) | Term calendar for holidays and day-order swaps | M2 |
| [0013](0013-audit-chain-anchoring.md) | Audit chain serialization and daily head-hash export | M1 |
| [0014](0014-runtime-risk-config.md) | Scorer weights and kill switches stored in the DB, editable by admins | M5 |
| [0015](0015-openapi-spec-first.md) | OpenAPI spec-first with generated types and a route-sync test | M0 |
| [0016](0016-sign-in-design.md) | Sign-in: Google OIDC, server sessions + CSRF, mobile code exchange bound to the device key, dev login | M1 |
| [0017](0017-roster-import-minimization.md) | Roster import sends only five fields; the rest stays in the browser | M1 |
| [0018](0018-ui-theme.md) | UI follows the Heimdall dark theme | M1 |
| [0019](0019-timetable-model-and-import.md) | Timetable resolution, DB-enforced double-booking, grid importer with exact dry run | M2 |

New ADRs: copy the format of any existing one (Context / Decision / Consequences), keep it under a page.
