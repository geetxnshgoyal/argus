# ADR-0024: iPhone pilot mode: iPhones without App Attest, for pilots only

**Context.** iPhones prove the genuine Argus app with App Attest (ADR-0008). Apple offers App Attest only to paid developer accounts: a build signed with a free personal team is refused ("Personal development teams do not support the App Attest capability"). The pilot runs from a free account, so production refused every iPhone, including the developer's own.

**Decision.**
- `IOS_ATTESTATION_MODE=off` (default `required`) lets iPhones register without App Attest. The app sends `ios_unattested` when App Attest is unavailable, and the server accepts it only in this mode. The phone is recorded with level `unattested`, and the Phones page shows "iPhone, not verified (pilot)".
- Everything else is unchanged. The session and attempt keys are still Secure Enclave keys, the attempt key still needs Face ID or the passcode, and every scan is still signed, checked for a fresh QR tag and located.
- Scans from these phones aren't flagged for the missing App Attest assertion, just as Android pilot scans aren't flagged for Play Integrity (ADR-0021). If the mode is turned off, these phones stop working until they register again with App Attest.
- If App Attest does work, the app sends it and it's verified as usual against `IOS_APP_ID` and `IOS_APP_ATTEST_ENV`.

**Consequences.** The server can't tell a genuine Argus app on a real iPhone from a modified app or a simulator for these phones. The other checks remain: signed attempts, rotating QR, location and teacher spot checks. Use it for the pilot only. Joining the Apple Developer Program brings App Attest and TestFlight, after which the mode should be turned off. Free-account builds also expire after 7 days and install only on devices connected to the developer's Mac.
