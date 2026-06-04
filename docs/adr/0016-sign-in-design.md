# ADR-0016: Sign-in design (web sessions, mobile code exchange, dev login)

**Context.** Spec §5 asks for OIDC auth code + PKCE, 15-min access / 30-day rotating refresh tokens, device-bound refresh for mobile, and 12 h staff web sessions. The college uses Google Workspace (`svyasa-sas.edu.in`).

**Decision.**
- **One OIDC client on the server** (`openid-client`), Google by default (`OIDC_ISSUER`), restricted to `OIDC_HOSTED_DOMAIN` via both the `hd` hint and the `hd` + email-domain claims check. PKCE + nonce + single-use state (10 min).
- **Provisioning first.** Acad Ops creates users; the first SSO sign-in links the account by *verified* email and stores `issuer#sub`; later sign-ins match the subject only. Role always comes from the DB, re-read on every request.
- **Web:** server-side sessions; the cookie holds a random value, the DB stores its SHA-256. `__Host-` cookie over https, `HttpOnly`, `SameSite=Lax`, 12 h absolute, 2 h idle. Every mutating cookie request needs the `x-argus-csrf` header (token from `GET /v1/me`). Sensitive actions (granting staff roles) need an IdP sign-in within 15 min (`reauth=1` forces `prompt=login`).
- **Mobile:** the app opens `/v1/auth/oidc/login?client=mobile&app_challenge=S256(verifier)` in the system browser. The server redirects back to `app.argus.argus:/auth/callback?code=…` (one-time, 2 min). The app redeems the code with its verifier **and a signature by its device session key**, so an intercepted callback is useless on another device. A failed redemption burns the code. Refreshes are signed by the session key; reuse of a rotated refresh token revokes the whole token family. Only students may use the app (ADR-0002).
- **Dev login** (`ARGUS_DEV_LOGIN`, refused outside `ARGUS_ENV=dev`): email picker for the web and `POST /v1/auth/dev/mobile-login` for the app, so the system can be tried before Google credentials exist. It looks users up by email and never links SSO identities.
- **Routine mobile API calls** use the 15-minute bearer token; proof-of-possession signatures are required on refresh (here) and on attempts, support requests and rebinds (M3–M6). This amends ADR-0008's "routine requests" wording.

**Consequences.** No passwords in Argus. Stolen refresh tokens or intercepted codes don't work without the phone's hardware key. Requires a Google OAuth client (Web application type) with redirect URI `https://<host>/v1/auth/oidc/callback`.
