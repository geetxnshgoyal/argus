# ADR-0005: Cheap checks before attestation

**Context.** Spec §6 checks attestation (step 3) before session, epoch/tag and nonce (steps 4–6). Verifying a Play Integrity token costs a Google API call and counts against a daily quota (default 10,000/day). A student replaying their own signed attempt would burn a call before the nonce check rejects it, a cheap way to exhaust quota and flag everyone as `attestation_unavailable`.

**Decision.** Validation order:
1. Device exists, bound to the authenticated student, not revoked, past `eligible_at`.
2. Signature valid over the exact payload bytes.
3. Nonce unused (then consumed).
4. Session open; round open; student enrolled (and in lab group if applicable).
5. Epoch valid and tag matches.
6. No accepted attempt for this student in this round.
7. Attestation valid and bound to the payload hash (outage → `attestation_unavailable` flag, not rejection).
8. Location hard check.

Signature comes before the nonce so nobody can burn another device's nonces.

**Consequences.** Replays and expired QR codes never reach Google. Reason codes are unchanged; only the order differs.
