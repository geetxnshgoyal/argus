# ADR-0013: Audit chain serialization and daily head-hash export

**Context.** Spec §9 hash-chains `audit_log`. Two gaps: concurrent inserts can read the same `prev_hash` and fork the chain; and anyone with database superuser access could rewrite the whole chain consistently.

**Decision.**
- Inserts take a transaction-scoped advisory lock (`pg_advisory_xact_lock`) before reading the previous hash, so the chain is strictly linear.
- `canonical(row)` is the RFC 8785 JCS serialization of the row without `hash`.
- A daily job exports the latest `(id, hash)` to a place outside the database (a file in the backup location plus the application log). The verify command checks the chain and compares with exported checkpoints.

**Consequences.** Audit writes are serialized (fine at Argus volumes). Rewriting history now also requires altering the external checkpoints.
