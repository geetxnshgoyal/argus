# ADR-0004: Display pairing from the teacher's side; round-scoped QR key

**Context.** Spec §6 has the teacher open `/display/{token}` on the classroom PC, and the display receives K_s. Two problems:
1. The classroom PC is usually projected, so typing the token shows it to the class; whoever exchanges it first wins.
2. K_s is the root secret. Anyone who extracts it from the display (DevTools, extension, shared-PC malware) can mint valid QR tags for every round of the session from anywhere, turning the accepted "live relay" risk into offline generation. In Phase 2, BLE tokens also derive from K_s.

**Decision.**
- **Pairing is initiated by the display.** `/display` generates an ephemeral secret in memory and shows only a pairing code/QR. The teacher approves it from their authenticated web session. The display then fetches session parameters using its in-memory secret. A photographed pairing code is useless without the teacher's session. If the teacher runs the web app on the projected laptop itself, it opens the display directly without a code.
- **The display receives only a QR key for the current round:** `K_qr,r = HKDF-SHA256(K_s, salt = session_id, info = "argus/v1/qr" ‖ u32be(round))`. A new round (recheck) requires fetching a new key; offline operation within a round still works. K_s and any future BLE key never leave the server.

**Consequences.** A display compromise leaks tags for one round only. The spec's `display_tokens` table becomes `display_pairings`; `POST /display/exchange {token}` becomes a pairing flow (exact endpoints in M4). Rechecks need the display online at round start.
