# Start of term

**When:** before the first class of a new semester. Takes about an hour.
Do the steps in order; each one needs the previous.

1. **Semester.** Admin → Academic → **Semesters** → add it with the first and
   last teaching day.
2. **Sections and lab batches.** **Sections**: one per class group (e.g.
   "2nd Year 3rd Sem"). **Lab batches**: Batch 1, Batch 2… for each section.
3. **Students.** People → **Import students** → choose the roster file. Read
   the preview (new, updated, problems), then confirm. Only USN, name, college
   email, batch and status are sent to the server.
4. **Teachers.** People → **Teachers** → add each teacher with their
   college Google address (any domain listed in `OIDC_HOSTED_DOMAIN`).
5. **Timetable.** Timetable → **Import timetable** → upload the college's
   timetable sheet (`.xlsx`). The first run is a **preview**: nothing is saved.
   Fix any red problems in the sheet and upload again, then confirm.
6. **Teaching assignments.** Timetable → **Teaching assignments** → for every
   subject, who teaches it. For labs, one teacher per batch (or one for "All
   batches").
7. **Holidays.** Timetable → **Holidays** → mark holidays, exam days and any
   "follows Monday's timetable" days.
8. **Campus.** Campus → **Campus areas**: centre point and radius (see below).
   **Campus networks**: the college's internet IP ranges, from IT.
9. **Check.** Timetable → **Timetable check** must show **No double-bookings**
   and nothing in "things to check". The common one is "No teacher assigned":
   go back to step 6.
10. **Tell people.** Overview → **Notices** → an announcement to all students
    to install the app and register their phone before the first class.

## Campus area from Google Maps

**One building (recommended):** in Google Maps satellite view, right-click each
corner of the building a little *outside* the walls (about 25 m out: indoor GPS
drifts), click the numbers at the top of the menu to copy them, and paste one
corner per line into **Building outline**. Leave the centre and radius empty;
they are worked out from the outline.

**Whole campus (circle):** right-click the middle of the campus → copy the
numbers → paste as centre latitude and longitude. Radius: right-click →
**Measure distance** to the farthest building, then add 50 m.

## Classroom Wi-Fi routers

Each room can list its Wi-Fi routers (Rooms → edit → **Wi-Fi routers**, one per
line). Scans that see one count as "in this room"; others are flagged for spot
checks, never refused. You don't have to survey: after a few classes, Admin →
**Wi-Fi routers** shows the routers students' phones saw in each room, with an
**Add** button. To survey a room yourself, sit next to each router with a Mac
and run `sh tools/wifi-survey/survey.sh "Room name"`: the strongest router is
the one you're next to.

Also set **College Wi-Fi name** on that page (what the college's networks
start with, e.g. `CAMPUS` for CAMPUS_STUDENTS), so college Wi-Fi from a router
no room lists yet still counts as on campus.

## If something goes wrong

- *Import says a student's email is outside the college domain:* the roster
  has a personal email; fix the row.
- *A class is on the wrong day after import:* change it in **Timetable → Weekly
  timetable** (all weeks) or **Classes by date** (one day only).
