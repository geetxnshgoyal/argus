# Deploying Argus

Argus is **one Node.js program plus a Postgres database**. No Docker, no Redis,
no other services. It runs either on **Vercel** (below) or on **your own server**
(further down). ADR-0020 explains the differences.

## On Vercel

1. **Project.** Import the GitHub repository in Vercel. `vercel.json` sets the
   build (`pnpm build:vercel`); leave the framework as "Other".
2. **Database.** In the project, go to Storage, then Connect Database, and pick
   **Neon** in the **Singapore** region (next to the Argus function). Argus reads
   `DATABASE_URL`: set it to Neon's **unpooled** connection string (Neon also
   adds `DATABASE_URL_UNPOOLED`; copy that value into `DATABASE_URL`).
3. **Settings** (Settings, then Environment Variables, for Production):

   | Variable | Value |
   |---|---|
   | `ARGUS_ENV` | `production` |
   | `ARGUS_PUBLIC_URL` | `https://<your-project>.vercel.app` (or your domain) |
   | `ARGUS_MASTER_KEY` | `openssl rand -base64 32`. Keep a copy somewhere safe. |
   | `ARGUS_TRUST_PROXY` | `true` |
   | `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | from Google (step 4) |
   | `OIDC_HOSTED_DOMAIN` | `svyasa-sas.edu.in,newtonschool.co` |
   | `CRON_SECRET` | any random string of 16+ characters |
   | `PLAY_INTEGRITY_MODE` | `off` for the pilot APK (ADR-0021) |
   | `ANDROID_SIGNING_CERT_SHA256` | SHA-256 of the APK signing certificate (the GitHub release workflow prints it) |
   | `IOS_APP_ID`, `IOS_APP_ATTEST_ENV` | `<TEAMID>.<bundle id>`, `development` for Xcode-installed builds |

4. **Google sign-in.** In Google Cloud Console, open APIs & Services:
   - OAuth consent screen: user type **External** (students and teachers are on
     two different Workspace domains), app name "Argus", scopes `openid`,
     `email`, `profile`. Publish it (it needs no Google verification for these scopes).
   - Credentials, then Create OAuth client ID, type **Web application**.
     Authorized redirect URI: `https://<your-project>.vercel.app/v1/auth/oidc/callback`.
     Add `http://localhost:5173/v1/auth/oidc/callback` too for local development.
   - Copy the client ID and secret into the Vercel settings, then redeploy.
5. Open `https://<your-project>.vercel.app/v1/health`. It should show
   `"status":"ok"`. The first request creates the tables.

A daily Vercel Cron calls `/v1/internal/cron`. Background jobs also run in the
background of normal requests, so nothing else needs scheduling.

## On your own server

### What you need

- A server (Linux recommended; Windows also works) with **Node.js 24 LTS** installed.
- **PostgreSQL 16 or newer** (on the same server or a managed database).
- An HTTPS front end (the college's existing reverse proxy, or a load balancer).

### Install (Linux)

1. Build a release on a developer machine: `pnpm install && pnpm build`.
   This produces `backend/dist/` containing `server.mjs` and the `web/` folder.
2. Copy the contents of `backend/dist/` to `/opt/argus/` on the server.
3. Copy `deploy/argus.env.example` to `/opt/argus/argus.env` and fill it in.
4. Create the database and user in Postgres:
   `createuser -P argus && createdb -O argus argus`
5. Install the service: see the comments at the top of `argus.service`.

The server applies database migrations automatically at startup.

### Upgrade

Replace the files in `/opt/argus/` with the new `backend/dist/` contents and run
`sudo systemctl restart argus`. Keep `argus.env`.

### Check it is working

Open `https://<your-host>/v1/health`. It should show `"status":"ok"`.

Backups, the health page for Acad Ops, and Windows service instructions are
added in later milestones (see docs/adr/0003-simple-operations.md).
