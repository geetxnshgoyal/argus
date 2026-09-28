# When something is down

## First: is it Argus or the network?

Open `https://<your-argus-address>/v1/health` in a browser.

| You see | Meaning | Do |
|---|---|---|
| `"status":"ok"` | Argus is fine | It's the network or one phone: see below |
| `"status":"degraded"` | Argus is up but can't reach its database | Developer: check the database (Neon console, or Postgres on the server) |
| An error page / nothing | Argus is down | Developer: see "Argus is down" |

The admin header's **System OK** badge shows the same thing.

## During a class

- **Classroom internet down:** the classroom screen keeps showing codes
  (it works offline). Students' scans wait on their phones and arrive as
  **pending** when they reconnect; the teacher confirms them.
- **Argus down:** the teacher takes a paper roll call. Afterwards Acad Ops
  enters it as corrections (each approved by a second person).
- **One student can't scan:** they use **Request support** in the app.
- **Google or Apple checks unavailable:** scans are flagged, never refused.
  Nothing to do; it clears by itself.

## Argus is down (developer)

**On Vercel:**
1. Vercel dashboard → the project → **Deployments**. If the latest one failed
   or broke things, open the previous good one → **⋯ → Promote to Production**
   (instant rollback).
2. **Logs** tab: look for `argus failed to start`. The usual cause is a missing
   or wrong setting (Settings → Environment Variables); the message names it.
3. Database: Vercel → Storage → Neon → check it's not paused or out of quota.

**On your own server:**
1. `sudo systemctl status argus` and `sudo journalctl -u argus -n 100`.
2. `sudo systemctl restart argus`.
3. Check Postgres: `sudo systemctl status postgresql`.

## After an outage

Note the start and end time and what was done. Classes during the outage may
need corrections: Attendance → the class → **Correct**.
