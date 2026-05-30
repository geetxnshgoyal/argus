# ADR-0007: Rebind keeps the old device active until the new one is eligible

**Context.** Spec §5 revokes the old device immediately and makes the new one wait 48 h. A student who simply changes phones cannot mark attendance for two days. And anyone who learns a student's SSO password can lock them out by binding a phone (a cheap griefing attack).

**Decision.**
- Binding a new device creates a rebind request with `eligible_at = now + 48 h` (configurable). **The old device stays active** until the new device becomes eligible (or Acad Ops approves early after an ID check), then it is revoked. Only one device can submit attendance at any moment.
- The old device receives a notification and can **cancel** the rebind ("This wasn't me").
- If the old device is lost, the student reports it (in-app from the new device or via Acad Ops); the old device is revoked immediately and the new one still waits for `eligible_at` or approval.
- Max 2 rebinds per semester (configurable) remains.

**Consequences.** No attendance gap for normal phone changes; account takeover can no longer silently lock out the owner. A stolen-phone case behaves like the spec.
