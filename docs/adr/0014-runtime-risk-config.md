# ADR-0014: Scorer weights and kill switches in the database

**Context.** Spec §14 requires disabling a misbehaving scorer "without redeploy". Environment variables require a restart and shell access, which the ops team shouldn't need.

**Decision.** Scorer weights, enabled flags and decision thresholds live in a `risk_settings` table, editable by the `admin` role in the web app, audited, cached in memory for a few seconds.

**Consequences.** Admins can react to a bad signal in minutes from a browser. Defaults ship in a migration.
