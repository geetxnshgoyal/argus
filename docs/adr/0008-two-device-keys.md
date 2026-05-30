# ADR-0008: Two device keys

**Context.** Spec §5 uses one hardware key with `setUserAuthenticationRequired(true)` (short validity) and also requires refresh-token requests to be signed by it. Background or delayed token refreshes would then prompt for unlock or fail.

**Decision.** Each student device holds two non-exportable P-256 keys, both hardware-backed and attested at binding:
- **Session key**: no user-authentication requirement. Signs token refresh and routine API requests (proof of possession).
- **Attempt key**: requires user authentication (device credential or biometric, short validity window). Signs attendance attempts, support requests and rebind confirmations.

**Consequences.** Refresh works silently; the unlock requirement applies where it matters (marking attendance). Key attestation lets the server verify that the attempt key really requires user authentication (Android). Both public keys are stored on the device record.
