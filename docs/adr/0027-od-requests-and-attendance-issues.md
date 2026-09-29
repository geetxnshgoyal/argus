# ADR-0027: On-duty (OD) requests and student attendance issues

**Context.** Students miss classes on college duty (events, sports, NSS) and need that recorded as attended. Students also need a way to dispute a wrong record after class; until now only teachers and Acad Ops could start a correction.

**Decision.**
- **New role `community_manager`** (created by an admin on the Staff page). Its only screen is `/community`: the OD requests waiting for them.
- **OD request** (student app): whole days (up to 14) or specific classes (up to 30), from 30 days back, with the event and details. Flow: community manager confirms the duty → **a different person** in Acad Ops gives final approval (the two-person rule, like corrections). Either can reject with a note; the student can withdraw while it's waiting.
- **New record status `od`** (basis `od`): counts as attended in percentages, but is shown as "On duty", never "present", so records stay honest about who was physically in class. Approval turns past absent/offline records into `od`; for later classes, attendance end records `od` instead of absent and the live panel shows "On duty". A real scan (present/late) is never overwritten.
- **Attendance issue** (student app): a past class (last 30 days) with a reason and a note → the class's teacher confirms (this files an ordinary correction as the teacher's attestation) or declines with a reason → Acad Ops approves the correction on the new **Requests** page. Classes without a teacher go straight to Acad Ops. One open issue per student and class.
- The Acad Ops **Requests** page also gives corrections their missing approval screen.
- Everything is audited (`od.*`, `issue.*`, `correction.*`).

**Consequences.** Students no longer need paper OD slips or office visits for simple record errors.

**Amendment (proof files).** A student can attach up to three photos (JPEG/PNG, resized on the phone) or PDFs, 3 MB each, while the request is waiting. They are stored in Postgres (`od_attachments`), not a separate file service, to keep operations to one database (ADR-0003); the type is read from the file's bytes, not its name. Only the student, community managers, Acad Ops and admins can open them; staff views are audited, and files are served sandboxed. The retention job deletes them 180 days after the request is decided.
