# ADR-0017: Student roster import minimizes data in the browser

**Context.** The college's existing student export (Firestore JSON) contains phone numbers, birthdays, blood groups, ABC IDs, personal emails and photos. Argus needs only USN, name, college email, batch and status (DPDP purpose limitation and minimization).

**Decision.** The web app parses the uploaded CSV/JSON **in the browser** (`web/src/lib/importParse.ts`) and sends only those five fields to `POST /v1/admin/students/import`. The page tells the user which columns stayed on their computer. The server re-validates everything, reports a dry run first (create / update / unchanged / needs fixing, batches to create, students who left → disabled), and refuses to commit while any row has errors. The import is one transaction with per-user audit rows plus a summary row.

**Consequences.** Sensitive data never reaches Argus's server, logs or backups. Photos are not imported; if photo-assisted spot checks are wanted later, that needs a separate, explicit decision (consent and retention).
