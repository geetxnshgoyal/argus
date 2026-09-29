# ADR-0029: Attempt keys bound to the phone's current fingerprints and faces

**Context.** Every scan is signed by the phone's attempt key, which needs the phone's owner to confirm (ADR-0008). With a PIN fallback, and with keys that survive new enrollments, a student could add a friend's fingerprint or face (or share the PIN) and let the friend scan for them.

**Decision.**
- When the phone has a fingerprint or face set up, the attempt key accepts **only** those, and the operating system voids it when a fingerprint or face is added or removed: Android `AUTH_BIOMETRIC_STRONG` + `setInvalidatedByBiometricEnrollment(true)`; iOS `.biometryCurrentSet`, plus a saved `evaluatedPolicyDomainState` so the app can tell the student why.
- A voided key shows "Register this phone again" in the app. The registration carries `reason: biometrics_changed`, and the server makes it wait for **Acad Ops approval** (ID check), like a phone that belonged to someone else.
- Phones with no fingerprint or face keep using the screen lock. The device is stored with `biometric_only = false` and each scan gets the soft signal `no_biometric_lock` (10 points, adjustable on Anti-proxy checks).
- On Android the server trusts the key's **attested** authenticators (`userAuthType = 2`), not the app's claim. iPhones can't prove it without App Attest, so their claim is trusted in pilot mode.

**Consequences.** A student who legitimately adds a fingerprint must visit Acad Ops once. Existing phones keep their old keys (PIN allowed) until they register again.
