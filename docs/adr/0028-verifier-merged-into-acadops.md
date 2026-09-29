# ADR-0028: Verifier role merged into Academic Operations

**Context.** The spec had a separate verifier role for "I couldn't scan" support requests, so the people judging them were not the people editing records. The college has one Academic Operations office and no separate verifiers.

**Decision.**
- The `verifier` role is removed. Migration 0015 turns existing verifier accounts into Acad Ops accounts.
- Acad Ops (and admins) decide support requests on **Admin → Support requests** (`/admin/support`; `/verify` redirects there). The API paths stay `/v1/verifier/…` so installed apps keep working.
- The evidence rules are unchanged (ADR-0006): approval needs a valid classroom scan from the student's phone and a low evidence score; otherwise the class's teacher is asked. Records decided this way keep the basis `verifier`, shown as "support request".

**Consequences.** One office runs the whole support desk. The separation between judging support requests and editing records is gone, so the evidence rules above and the audit log (every view of evidence is logged) are the safeguards. Corrections and OD still need two different people.
