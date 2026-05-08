# ADR-0002: Teachers use the web app; the Flutter app is student-only

**Context.** Spec §2/§11 put the teacher role in both the Flutter app and the web SPA. The mobile app exists because students need hardware-bound keys, attestation and mock-location detection, which browsers cannot provide. Teachers need none of these in Phase 1.

**Decision.** Teacher screens live only in the web app (`/teacher`), usable on a laptop or a phone browser. The Flutter app is student-only. Teachers do not bind a device in Phase 1. Support confirmations ("Is X in the room?") reach teachers via web push and an in-app inbox. FCM is still used for student notifications.

**Consequences.** Smaller app, fewer store-review surfaces, nothing for teachers to install. Teacher actions are authenticated by the staff web session (httpOnly cookie, re-auth for sensitive actions) rather than device signatures. Display pairing (ADR-0004) is approved from the teacher's web session, e.g. on their phone's browser, by scanning or typing the pairing code shown on the projector. Web push on iPhone requires the teacher to add the site to the home screen (iOS 16.4+); the inbox is the fallback. If Phase 2 needs a teacher-phone BLE anchor, revisit this.
