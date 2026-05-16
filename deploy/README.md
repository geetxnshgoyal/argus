# Deploying Argus

Argus is **one Node.js program plus a Postgres database**. No Docker, no Redis,
no other services.

## What you need

- A server (Linux recommended; Windows also works) with **Node.js 24 LTS** installed.
- **PostgreSQL 16 or newer** (on the same server or a managed database).
- An HTTPS front end (the college's existing reverse proxy, or a load balancer).

## Install (Linux)

1. Build a release on a developer machine: `pnpm install && pnpm build`.
   This produces `backend/dist/` containing `server.mjs` and the `web/` folder.
2. Copy the contents of `backend/dist/` to `/opt/argus/` on the server.
3. Copy `deploy/argus.env.example` to `/opt/argus/argus.env` and fill it in.
4. Create the database and user in Postgres:
   `createuser -P argus && createdb -O argus argus`
5. Install the service: see the comments at the top of `argus.service`.

The server applies database migrations automatically at startup.

## Upgrade

Replace the files in `/opt/argus/` with the new `backend/dist/` contents and run
`sudo systemctl restart argus`. Keep `argus.env`.

## Check it is working

Open `https://<your-host>/v1/health`. It should show `"status":"ok"`.

Backups, the health page for Acad Ops, and Windows service instructions are
added in later milestones (see docs/adr/0003-simple-operations.md).
