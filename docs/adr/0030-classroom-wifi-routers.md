# ADR-0030: Classroom Wi-Fi routers as presence evidence

**Context.** GPS can't tell one classroom from the next, and a friend on campus can relay the QR code. Each classroom has its own Wi-Fi routers (a survey on 2026-09-29 found one in Lab L2 and two each in Classrooms 8 and 9). Every router broadcasts all college networks (SVYASA_STUDENTS, _STAFF, _FACULTY, _GUEST…) on two bands, so their BSSIDs differ only in the last octet.

**Decision.**
- A router is identified by the **first five octets** of its BSSID (`e0:c2:50:78:0e`). Rooms list their routers (`rooms.wifi_routers`, edited on the Rooms page).
- At each scan the app adds the Wi-Fi it sees to the **signed** payload: Android the connected router plus nearby scan results (30 strongest); iPhone the connected router only.
- The server's verdict: `room` (one of this room's routers), `other_room` (only other rooms' routers), `campus` (college Wi-Fi from an unassigned router), `not_campus` (no college Wi-Fi), `unknown` (no data). Only the verdict is stored; the router list is never kept with the attempt.
- Soft signals, never refusals: `wifi_other_room` (15) and `wifi_not_campus` (25), adjustable on Anti-proxy checks. Phones stay connected to the router they joined (an iPhone walking from C8 to C9 still reports C8's router), so a mismatch must not reject.
- **Learning:** for verified scans (inside the campus area), the strongest college router is counted per room (`wifi_observations`). Admin → Wi-Fi routers lists these so Acad Ops can add them to rooms with one click. The college network name prefix is `app_settings.campus_wifi_ssid_prefix` (`SVYASA`).
- **iPhone:** reading Wi-Fi needs Apple's Access Wi-Fi Information entitlement, which free (personal) developer accounts can't use. Until the paid Apple Developer Program is used, iPhones report nothing and get `unknown` (no penalty). The Swift code is in place; add `com.apple.developer.networking.wifi-info` to a `Runner.entitlements` then.

**Consequences.** On Android, a relayed QR scanned from another room or off campus is flagged for spot checks. Surveying rooms is optional: routers are learned from normal use.
