# argus_security

Argus's native security module, kept in-repo as a local Flutter plugin
(Kotlin in `android/`, Swift in `ios/`). The build spec forbids third-party
Flutter plugins for keys and attestation, so all of that lives here.

| Milestone | Adds |
|---|---|
| M0 | `platformInfo` (OS, model, StrongBox / Secure Enclave availability) |
| M3 | Session + attempt keys, signing, Android key attestation, Play Integrity, App Attest, DeviceCheck |
| M4 | Fresh precise location fix with mock detection |
