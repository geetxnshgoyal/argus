# ADR-0026: Pilot shadow mode and metrics

**Context.** Spec §15 M8: during the pilot, attendance must be computed but not official, and the team needs the §17 acceptance numbers (false rejects < 2%, median scan-to-marked < 10 s, support requests < 3% of students, teacher time < 2 min) to decide when to switch Argus on for real.

**Decision.**
- **Shadow mode** is one switch in `app_settings` (`shadow_mode`), changed only by admins on the Pilot page and audited. Nothing about scanning, scoring or records changes; it's a label.
- Each attendance session stores the mode it was **started** in (`attendance_sessions.shadow`). Flipping the switch later never rewrites history: pilot classes stay "not official", later classes are official.
- The flag is shown wherever attendance is read: the teacher's live page, the student's app (active class and history), and the admin attendance list ("Pilot · not official").
- **Metrics** (`GET /v1/admin/pilot/metrics?from&to[&section_id]`, Acad Ops and admins) are computed from stored data only; no extra tracking:
  - *False rejects:* rejected scans from students whose final record for that class is present, late or excused, over all their scans. Duplicates (`already_marked`, `not_targeted`, `replayed_nonce`) don't count.
  - *Scan to marked:* server receipt minus the phone's clock at scan, for accepted, non-offline scans; values outside 0–5 min are ignored as clock errors. Approximate.
  - *Teacher time:* from starting attendance until 90% of accepted first-round scans are in (median over classes).
  - *Support requests:* requests over expected students. Plus spot-check results, refusal reasons, warning signs and a per-day table.

**Consequences.** One place to run the pilot and judge it. The phone-clock caveat is shown next to the timing number. Turning shadow mode off is the "go live" step.
