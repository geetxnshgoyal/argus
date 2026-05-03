# Argus threat model (Phase 1)

> **Status: draft (M0).** Derived from the [build spec](spec/phase1-build-spec.md)
> and ADRs. Revisit at every milestone and in M7's security review.

## 1. What we protect

| Asset | Why it matters |
|---|---|
| Attendance records | Exam eligibility depends on them; the whole point of Argus |
| Session secrets (K_s, K_qr,r) | Anyone holding them can mint valid QR tags |
| Device binding (hardware keys) | Ties an account to one physical phone |
| Staff accounts and sessions | Teachers confirm presence; Acad Ops and verifiers change records |
| Audit log | Evidence for disputes and disciplinary cases |
| Student personal data (identity, location results, device info) | DPDP Act 2023: purpose limitation, minimization |

## 2. Adversaries

| Tier | Who | Capabilities |
|---|---|---|
| T0 Casual | Most students attempting proxy | Share passwords, hand over phones, forward screenshots |
| T1 Coordinated | Friend groups | Live video relay of the QR, two phones, WhatsApp coordination, mock-location apps (no root needed on Android) |
| T2 Technical | A few engineering students | Rooted phones, emulators, app modification (Frida), scripted API calls, reverse engineering |
| T3 Tool builder | One T2 who packages a tool | Turns a T2 technique into a one-tap tool that T0 students use (e.g. a relay bot) |
| Insider | Teacher, verifier, Acad Ops, admin | Legitimate access; could approve proxies or edit records |

Design goal: T0/T1 attacks fail or are detected with high probability; T2 needs real effort and leaves traces; T3 tools don't scale (attestation, server-side checks, per-session secrets); insider actions are always attributable (audit, two-person rules).

## 3. Trust boundaries

- **Student phone:** untrusted, but its hardware keystore and platform attestation (Play Integrity, App Attest, Android key attestation) are trusted to the extent Google/Apple vouch for them.
- **Classroom display (PC browser):** untrusted rendering surface. Holds only the current round's QR key (ADR-0004).
- **Teacher web session:** trusted human, accountable via audit; authenticated by SSO + httpOnly session, re-auth for sensitive actions.
- **Server + Postgres:** trusted. Master key stays outside the DB.
- **Google/Apple attestation services, college IdP:** trusted third parties; outages degrade to flags, never mass rejection.

## 4. Key insight

Every location or proximity signal answers "**is a device here?**". The spec's hardest question is "**is the right person here?**". Phase 1 answers it with device binding (one phone per student, non-exportable keys), a user-auth-gated attempt key, and a **human layer** (spot checks, teacher confirmation). Deterrence = detection probability × consequence, so the published penalty policy and random spot checks are core controls, not extras.

## 5. Attacks and Phase 1 defenses

| # | Attack | Phase 1 defense | Residual risk | Test |
|---|---|---|---|---|
| A1 | Friend logs into the absent student's account on the friend's own phone | Account works only on the bound device; a new device needs a 48 h rebind (old device notified, can cancel; ADR-0007); same-device check blocks a phone already bound to someone else (ADR-0009) | Needs the absent student's cooperation for a rebind, which is visible and rate-limited | §16 #1, #2 |
| A2 | Screenshot of the QR forwarded later | 3 s epochs, 2 s grace, tags bound to session + round + epoch | None for delayed forwarding | §16 #4, #5 |
| A3 | Live video relay of the QR to someone elsewhere on campus | Location must be on campus (hostel/canteen pass); soft flags; spot checks | **Accepted (spec §1)** until BLE in Phase 2 | — |
| A4 | Relay to someone off campus | Hard reject when clearly off campus (good-accuracy fix, not mock); mock → flagged_high (ADR-0010) | Mock location with relay → flagged_high, caught by spot check or teacher | §16 #8 |
| A5 | Friend carries the absent student's bound phone (or a spare bound phone) | Attempt key needs unlock/biometric; spot checks (risk-weighted + random) | **Accepted (spec §1)**; analytics in Phase 2 | — |
| A6 | Sharing SSO password | SSO + device binding: the password alone cannot mark attendance; misuse triggers visible rebind | Rebind with owner's cooperation | §16 #1 |
| A7 | Several accounts on one phone | One active binding per physical device (ANDROID_ID hash / DeviceCheck bit) | Factory reset between binds (logged, rate-limited) | §16 #2 |
| A8 | Replay a captured attempt | Nonce table (single use), signature over exact bytes, epoch window, one accepted attempt per round | None known | §16 #3 |
| A9 | Forge or modify an attempt | ECDSA over exact bytes with a non-exportable key; attestation bound to payload hash | Key extraction from hardware (out of scope) | §16 #6 |
| A10 | Modified app / emulator / rooted phone / scripted API | Play Integrity (device + app integrity), App Attest, key attestation at bind time | Leaked keybox / sophisticated root hiding (T2+) | §16 #7 |
| A11 | Extract the QR key from the classroom PC | Display gets only the current round's key; pairing never shows a secret (ADR-0004) | Leak valid for one round only | M4 tests |
| A12 | Deep-link forwarding (`argus://…` shared in chat) | App accepts QR only from its own camera (ADR-0011) | — | M4 tests |
| A13 | Support request from outside the room to get approved | Verifier approval needs a valid session tag from the device; otherwise teacher decides (ADR-0006) | Relayed QR + support (spot checks) | §16 #10 |
| A14 | Burn Play Integrity quota with replays (DoS) | Cheap checks before attestation (ADR-0005); per-device rate limit | Many devices colluding (alerting in M7) | M4 tests |
| A15 | Mark and leave | Targeted/end rechecks → `missed_recheck` flag (ADR-0010) | Teacher must run a recheck | M5 tests |
| A16 | Teacher starts attendance for someone else's class | Server-side authorization: own class, time window, status | — | §16 #9 |
| A17 | Insider: verifier or Acad Ops edits records / self-approves | Verifiers can't edit records; corrections need two different people; everything audited | Collusion of two insiders (visible in audit) | §16 #10, #11 |
| A18 | Tamper with audit history | Hash chain, linear via advisory lock, daily external checkpoint (ADR-0013); app DB role has INSERT/SELECT only | DB superuser + checkpoint store both compromised | §16 #12 |
| A19 | Steal staff session on a shared classroom PC | Teachers don't need to log in on the classroom PC (pairing); short idle timeout and re-auth for sensitive actions | Teacher leaves a session open on a shared PC | M1 tests |
| A20 | Rebind to lock out a victim (account takeover griefing) | Old device stays active and can cancel (ADR-0007); SSO MFA | — | M3 tests |

## 6. Privacy threats (DPDP Act 2023)

- **Over-collection of location:** location is read once per scan during an open round; only derived results are stored; raw coordinates never persisted or logged (enforced in code and by log redaction tests).
- **Evidence misuse:** evidence access is role-restricted and itself audited.
- **Retention:** raw attempt signals purged after 90 days.
- **Minors:** some first-year students may be under 18. The DPDP Rules 2025 exempt educational institutions from the verifiable-parental-consent and tracking/monitoring restrictions only for educational activities or student safety, and only for the minimum necessary data. Legal review before pilot.

## 7. Why not other approaches (for the record)

- **Web app for students:** browsers cannot hold attested, non-exportable keys, cannot prove app integrity, and let anyone set a fake location in DevTools. The student app must be native (ADR-0002 keeps teachers on web).
- **Rotating QR alone:** stops delayed sharing, not live relay.
- **Wi-Fi RTT:** no iOS API; many budget Android phones unsupported; about 1–2 m accuracy in ideal conditions, worse in a full room; cannot separate the back row from the corridor; FTM is unauthenticated unless 802.11az secure ranging is deployed carefully. Phase 2+ bonus signal at most.
- **UWB:** too few student phones support it for a college-wide baseline.
- **BLE (Phase 2):** works on nearly all phones; gives room-ish proximity, not wall-accurate; tokens must rotate (derived from K_s, never given to the display).

## 8. Open items

- Decide how the proxy penalty policy text is versioned and shown (M1).
- Play Integrity quota increase request before pilot (default 10,000 calls/day; one per attempt exceeds it).
- Legal review of the privacy notice (M7).
