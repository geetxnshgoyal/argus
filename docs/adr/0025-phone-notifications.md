# ADR-0025: Phone notifications through Firebase Cloud Messaging (Android)

**Context.** Notices (ADR-0023) appeared only inside the app. Students asked for a sound and an entry in the notification panel, especially for class changes and for "attendance is open".

**Decision.**
- The Android app registers its FCM token with `POST /v1/me/push-token` each time it opens, after asking for Android 13+'s notification permission once. Signing out removes the token. Tokens are stored per install in `push_tokens`, and a token moves to whoever signed in last.
- The server sends through the FCM HTTP v1 API with a service account (`FCM_SERVICE_ACCOUNT`, stored only on the server). It sends after the change is committed, in the background (`waitUntil` on Vercel), and never fails the request. Tokens FCM reports as dead are deleted.
- What is sent: every notice (announcements, class changes, "back to normal"), and "Attendance is open · SUBJ" to the expected students when a teacher starts attendance.
- The notification code lives in our own Android plugin: the Firebase messaging library, a high-importance `argus_notices` channel, and a service that shows notifications while the app is open. It's initialised from the standard Firebase resource values. We don't use the FlutterFire packages, so the iPhone build is unchanged.

**Consequences.** iPhones get no push: Apple's push service needs a paid developer account. iPhone users see notices when they open the app. Without Firebase settings in the build or on the server, nothing is sent and nothing breaks.
