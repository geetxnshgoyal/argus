# ADR-0009: Keyed hash of ANDROID_ID for same-device detection

**Context.** Spec test "two accounts on one device → second bind blocked or cooldown" needs a stable physical-device identifier. iOS has the DeviceCheck bit (spec §5). On Android nothing in the spec identifies the device: each binding generates a fresh key, and key attestation does not expose device IDs to normal apps.

**Decision.** At binding, the Android app sends `ANDROID_ID` (stable per app-signing key, user and device; survives reinstall, resets on factory reset). The server stores only `HMAC-SHA256(server_secret, android_id)`. Policy:
- device actively bound to another student → bind **blocked**;
- device previously bound to another student within 180 days → bind allowed only with Acad Ops approval (legitimate hand-me-down/resale).

Play Integrity "device recall" (beta) can be added as a second signal if enabled for the app.

**Consequences.** Adversarial test #2 becomes enforceable on Android. A factory reset evades it; that is logged as a new device and still subject to the student's own rebind limits.
