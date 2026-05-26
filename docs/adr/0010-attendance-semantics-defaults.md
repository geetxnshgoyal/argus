# ADR-0010: Attendance semantics defaults

**Context.** The spec leaves several record outcomes undefined. These defaults were agreed; all are configurable.

**Decision.**
- **Missed recheck:** a student verified earlier who does not scan in a later targeted/full/end round gets a `missed_recheck` flag at `flagged_high`; the teacher decides. The record is not changed automatically.
- **Late:** a student whose first accepted attempt is in a round opened more than 10 minutes after class start is recorded `late`.
- **Spot check `no_response`:** creates a risk flag; the record is unchanged until the teacher resolves it (confirmed or absent).
- **Offline-queued attempts:** not counted as present until the teacher confirms.
- **Mock location:** default weight raised from 50 to **70**, so it alone yields `flagged_high`. Android mock location needs no root and passes Play Integrity.
- **Spot-check suggestion:** all `flagged_high` + up to 5 `flagged` (weighted by score) + 3 random `verified` (weighted by score + 1).
- **Support approval second approver:** off by default in Phase 1 (column kept); corrections always need two people.

**Consequences.** Records can include a pending state for offline-queued attempts until confirmation; the M4 schema adds it.
