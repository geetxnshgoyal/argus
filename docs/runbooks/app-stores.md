# Publishing the app (Google Play and the App Store)

**When to use it:** first publishing of the student app, and each release after.
Every release (`pnpm release <version>`) builds `argus.apk` (install directly) and
`argus.aab` (upload to Google Play) and attaches both to the GitHub release.

## Google Play

### Once: create the app

The app id (package name / bundle id) is **`app.argus`** on Android and iPhone.
Google Play fixes it with the first uploaded bundle, so never change it after that.
It replaced `app.argus.argus` (0.0.10 and earlier), so:

- Phones with an older APK see the new build as a separate app: uninstall the old
  one, install the new one, register again.
- Firebase: add an Android app with package `app.argus`, download its
  `google-services.json`, and update the `GOOGLE_SERVICES_JSON_B64` secret.
- Server: if `ANDROID_PACKAGE_NAME` or `ARGUS_MOBILE_REDIRECT_URI` are set on
  Vercel, change them to `app.argus` and `app.argus:/auth/callback` (or remove
  them to use those defaults), then redeploy.

1. [Play Console](https://play.google.com/console) → **Create app**. Name
   *Argus*, default language English, **App**, **Free**. Accept the
   declarations.
2. **App signing: let Google create the key.** Google Play accepts only RSA
   keys, and the APK key (`~/.argus-release-signing/argus-release.jks`) is EC, so
   Play bundles are signed with a separate RSA **upload key**
   (`argus-upload.jks` in the same folder, password in `upload.properties`).
   Google re-signs the app with its own key. Afterwards:
   - App integrity → **App signing** → copy the *App signing key certificate*
     SHA-256 and add it to the server's `ANDROID_SIGNING_CERT_SHA256`, after a
     comma (keep the APK one too), then redeploy. Without it, phones that install
     from Play are refused when they register.
   - A phone that installed the APK must uninstall it before installing from
     Play (different signatures), then register again; Acad Ops can approve the
     change at once with **Activate now**.
   - Lost upload key: Google can reset it (App signing → Request upload key
     reset); the app signing key stays with Google.
3. **Store listing:** short description ("Proxy-resistant attendance for your
   college"), full description, app icon (`brand/argus-icon-1024.png`, resized to
   512×512), two or more phone screenshots, category *Education*.
4. **App content** (Policy → App content):
   - Privacy policy: `https://<your Argus address>/privacy`
   - Ads: no ads.
   - **App access:** "All or some functionality is restricted". Reviewers need a
     sign-in: make a Google account for them (e.g. a Gmail), add it to
     `OIDC_ALLOWED_EMAILS`, create it as a student in Argus, and give the email
     and password here, with: "Sign in with Google. Attendance scanning needs a
     classroom QR code; the Home, Timetable, Attendance and Requests tabs work
     without one."
   - Content rating questionnaire: utility/productivity, no objectionable content.
   - Target audience: the age of your students (18+ if all are adults).
   - **Data safety** (what the app actually does):

     | Data | Collected | Why | Notes |
     |---|---|---|---|
     | Precise location | Yes | Fraud prevention, app functionality | Only at the moment of a scan; processed ephemerally (only "on campus / not", accuracy and distance are kept) |
     | Name, email | Yes | Account management | From the college's Google account |
     | Device or other IDs | Yes | Fraud prevention, security | The phone's registration key and a hashed device id |
     | Photos, files and docs | Yes, optional | App functionality | Only proof files a student attaches to an OD request |
     | App interactions | Yes | App functionality | Attendance scans and requests |

     Nothing is shared with third parties or sold; all data is encrypted in
     transit; students ask Academic Operations to delete their data.

### Testing before production (new personal developer accounts)

Google requires a **closed test with at least 12 testers for 14 days in a row**
before a new personal account can publish to everyone.

1. Test and release → Testing → **Closed testing** → create a track, add testers
   by email list or Google Group (pilot students and teachers are ideal).
2. Upload `argus.aab` from the latest GitHub release, roll it out, share the
   opt-in link with the testers. They install from the Play Store.
3. After 14 days with 12+ opted-in testers: Dashboard → **Apply for production**.

### Each release

Upload the new `argus.aab` (Test and release → your track → Create new release).
The version code goes up automatically with each build. CI signs it with the
upload key from the `ANDROID_UPLOAD_*` repository secrets; without them a
release has only the APK.

### After the first Play release

- **Play Integrity** (stronger than key attestation alone): App integrity → Play
  Integrity API → link a Google Cloud project, create a service account with
  access, and set `PLAY_INTEGRITY_MODE` and `PLAY_INTEGRITY_CREDENTIALS` on the
  server (`deploy/README.md`). Until then `PLAY_INTEGRITY_MODE=off` is fine.

## App Store (iPhone)

Once the Apple Developer Program membership shows **Active**:

1. [developer.apple.com](https://developer.apple.com/account) → Identifiers → new
   App ID `app.argus` with **App Attest** and **Access Wi-Fi Information**
   (and **Push Notifications** for notices later). Note the 10-character Team ID.
2. In Xcode: Runner → Signing & Capabilities → choose the paid team, bundle id
   `app.argus`, add *App Attest* and *Access WiFi Information*. (A developer
   then removes the personal-team bundle id `app.argus.geetansh`.)
3. Server: `IOS_APP_ID=<TEAMID>.app.argus`, `IOS_APP_ATTEST_ENV=production`
   for TestFlight and App Store builds, and `IOS_ATTESTATION_MODE=required` (turns
   off the unverified-iPhone pilot mode, ADR-0024).
4. [App Store Connect](https://appstoreconnect.apple.com) → My Apps → **+** → new
   app with that bundle id. Xcode → Product → **Archive** → Distribute → App Store
   Connect, then add testers in **TestFlight** (up to 10,000; no 7-day expiry).
5. For the public App Store: screenshots, the privacy URL, App Privacy answers
   (same as the Data safety table above), and a reviewer account as for Google.
