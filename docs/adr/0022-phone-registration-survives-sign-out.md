# ADR-0022: Signing out keeps the phone's registration; the session key identifies the install

**Context.** Signing out used to delete the phone's session key (M1). Since M3 that key, together with the attempt key, *is* the phone's registration (ADR-0008). A student who signed out and back in on the same phone was treated as having a new phone: a 48-hour phone change (ADR-0007). This happened in the first real test, together with a refresh-token race that logged students out.

**Decision.**
- Signing out revokes the sign-in (its refresh-token family) but keeps both hardware keys. Signing in again on the same phone finds its registration.
- The session key is non-exportable hardware, so the same session key means the same phone and app install. Re-registering with it replaces the old binding at once. Another student registering with it is refused (`device_in_use`), which covers "two accounts on one phone" on iPhones even without DeviceCheck.
- The app shares one token refresh between concurrent requests. A network error at startup keeps the student signed in (offline screen); only a revoked or invalid refresh token ends the sign-in.

**Consequences.** No phone-change wait for normal sign-out and sign-in. A student who hands the phone to someone else must still have that person register their own phone. Deleting the app on Android deletes the keys (Keystore); on iOS, Keychain items can survive reinstalling.
