# ADR-0023: Notices from Academic Operations, and automatic class-change notices

**Context.** Acad Ops need to tell students and teachers about room changes, cancellations, extra classes and general news. The spec lists FCM push (`notify/`) but no notice model. Timetable overrides already change the schedule. Until now nobody was told except by seeing "Changed" on the teacher's page.

**Decision.**
- A `notices` row holds the title, message and audience as chosen (everyone, all students, all teachers, a section, or one subject's class, optionally one lab batch). `notice_recipients` fixes who it reached when it was posted. `read_at` is the read receipt, so Acad Ops see "read by 41 of 60". Students who join later don't receive old news.
- Saving a timetable override posts a class-change notice by default (`notify`, on unless unticked). It goes to that class's students and the teachers involved: the usual teacher and any substitute. The text says what changed: room, time, teacher, or cancelled or extra. The override *reason* stays internal (audit log). Acad Ops can add one optional line.
- Undoing an override withdraws its notice and tells the same people the class is back to normal (or an extra class is called off). Replacing an override withdraws the old notice; the new one describes the final state.
- Students see notices in the app: a bell with an unread count, and the newest unread notice at the top of home. Teachers see them on their web home page. Announcements stay visible for 30 days. Class changes stay until their day is over. Withdrawing hides a notice for everyone and is audited.

**Consequences.** No push yet: a student sees a notice when they open the app. The app checks about once a minute while it's open, and again when it comes back to the foreground. Push (FCM for Android, APNs for iOS) can be added on top of `notice_recipients` later. It needs a Firebase project and an Apple push key, which a later milestone will set up.
