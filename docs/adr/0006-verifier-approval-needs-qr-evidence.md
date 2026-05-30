# ADR-0006: Verifier approval also needs a valid QR tag from the session

**Context.** Spec §7 lets a verifier approve a support request if its evidence (risk) score is low. In Phase 1 the evidence can show "on campus" but never "in this room": a student in the hostel or canteen during class has clean device, attestation, location and network signals, so their request scores low and could be approved with no in-room evidence at all.

**Decision.** "Approve" is allowed only when **both**:
- the evidence score is below the approval threshold, and
- the student's bound device submitted at least one attempt in this attendance session with a **cryptographically valid tag for this session** (it may have been rejected for other reasons, e.g. expired grace or poor location).

Otherwise the verifier can only "Ask teacher" or "Reject". The server enforces this; the UI only reflects it.

**Consequences.** Requests from students who never saw the live QR (camera broken, phone dead, "couldn't scan") always go to the teacher, who is the only one who can see the room. Relayed QRs still produce valid tags; that residual risk is covered by spot checks as the spec accepts.
