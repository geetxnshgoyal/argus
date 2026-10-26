# Publishing the app (Google Play and the App Store)

**When to use it:** first publishing of the student app, and each release after.
Every release (`pnpm release <version>`) builds `argus.apk` (install directly) and
`argus.aab` (upload to Google Play) and attaches both to the GitHub release.

## Google Play

### Once: create the app

1. [Play Console](https://play.google.com/console) → **Create app**. Name
   *Argus*, default language English, **App**, **Free**. Accept the
   declarations.
2. **App signing: keep the existing key.** Test and release → App integrity →
   **App signing** → *Use a different key* → **Export and upload a key from Java
   keystore**. Follow the steps shown: download `pepk.jar` and the encryption key,
   then on the Mac that holds `~/.argus-release-signing/`:

   ```bash
   java -jar pepk.jar --keystore=$HOME/.argus-release-signing/argus-release.jks --alias=<keyAlias from key.properties> --output=argus-signing.zip --include-cert --rsa-aes-encryption --encryption-key-path=encryption_public_key.pem
   ```

   Upload `argus-signing.zip`. Why: Google then signs the app with the same key
   as the APKs, so (a) phones that installed the APK update from Play without
   re-registering, and (b) the server's `ANDROID_SIGNING_CERT_SHA256` stays right.
   If Google generates a new key instead, add its SHA-256 (App signing page) to
   `ANDROID_SIGNING_CERT_SHA256` with a comma, and APK users must uninstall and
   register their phone again.
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
The version code goes up automatically with each build.

### After the first Play release

- **Play Integrity** (stronger than key attestation alone): App integrity → Play
  Integrity API → link a Google Cloud project, create a service account with
  access, and set `PLAY_INTEGRITY_MODE` and `PLAY_INTEGRITY_CREDENTIALS` on the
  server (`deploy/README.md`). Until then `PLAY_INTEGRITY_MODE=off` is fine.

## App Store (iPhone)

Once the Apple Developer Program membership shows **Active**:

1. [developer.apple.com](https://developer.apple.com/account) → Identifiers → new
   App ID `app.argus.argus` with **App Attest** and **Access Wi-Fi Information**
   (and **Push Notifications** for notices later). Note the 10-character Team ID.
2. In Xcode: Runner → Signing & Capabilities → choose the paid team, bundle id
   `app.argus.argus`, add *App Attest* and *Access WiFi Information*. (A developer
   then removes the personal-team bundle id `app.argus.argus.geetansh`.)
3. Server: `IOS_APP_ID=<TEAMID>.app.argus.argus`, `IOS_APP_ATTEST_ENV=production`
   for TestFlight and App Store builds, and `IOS_ATTESTATION_MODE=required` (turns
   off the unverified-iPhone pilot mode, ADR-0024).
4. [App Store Connect](https://appstoreconnect.apple.com) → My Apps → **+** → new
   app with that bundle id. Xcode → Product → **Archive** → Distribute → App Store
   Connect, then add testers in **TestFlight** (up to 10,000; no 7-day expiry).
5. For the public App Store: screenshots, the privacy URL, App Privacy answers
   (same as the Data safety table above), and a reviewer account as for Google.
