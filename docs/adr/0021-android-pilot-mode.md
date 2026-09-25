# ADR-0021: Android pilot mode without Play Integrity

**Context.** Spec §5 requires Google Play Integrity for Android phones. Play Integrity recognizes an app only when it is installed from Google Play. For the pilot, students install an APK built on GitHub, so every phone would fail, or be flagged on every scan.

**Decision.** `PLAY_INTEGRITY_MODE=off` (default `required`) is allowed in any environment for the pilot. With it:
- Registration still requires **Android key attestation**: a hardware-backed attempt key that needs the user to unlock, a verified boot with a locked bootloader, our package name, and **our signing certificate** (`ANDROID_SIGNING_CERT_SHA256` is mandatory outside dev/test).
- Scans carry no Play Integrity token and are recorded with attestation `not_required`. They are not flagged, because every pilot phone would be.
- What is lost: Play's app-integrity verdict on each scan (e.g. a repackaged app driving the genuine hardware key on a rooted-but-attestation-passing phone). Spot checks and device binding still apply.

**Consequences.** The GitHub APK works on real phones. Before the full rollout, publish the app on Google Play (the internal testing track is enough) and switch back to `required`.
