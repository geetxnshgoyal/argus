# Attendance problems

## "I was in class but couldn't scan" (student)

The student taps **Request support** in the app during or right after the
class (until 15 minutes after it ends).

**Acad Ops** (Admin → **Support requests**): open the request.
- **Approve** is allowed only when the phone scanned a valid classroom code
  and the evidence score is low. Otherwise the button explains why not.
- **Ask teacher**: the teacher gets a question ("Was this student here?")
  and answers Yes / No / Not sure.
- **Reject** with a reason if the evidence says the student wasn't there.

## A record is wrong after class (teacher or Acad Ops)

Attendance → open the class → the student → **Correct** → choose the right
status and write why → **Send for approval**. Someone else in Acad Ops must
approve it; nobody can approve their own correction. Everything is in the
audit log.

## Teacher forgot to start attendance

Attendance can be started from 10 minutes before a class until it ends. After
that, the teacher (or Acad Ops) records the class with corrections, one per
student, each approved by a second person.

## Wrong room or teacher today

Timetable → **Classes by date** → click the class → **Move it** (room, time or
teacher) for that day only, with "Tell the students and teachers" ticked.
To cancel: **Cancel it**. To undo: open it again → **Undo this change**.
A class that already has attendance can't be removed or moved back; it shows
"Attendance taken".

## Many students flagged in one class

Usually a location problem (indoors, poor GPS), not cheating. Look at the
reasons in the class's attendance. If one signal is misbehaving everywhere,
an **admin** can lower it or switch it off on **Anti-proxy checks**, without
a developer. Every change is in the audit log.

## On duty (OD)

Students request OD in the app (**OD & attendance issues → Request OD**) for
whole days or specific classes. The **community manager** confirms it on their
page; then someone in Acad Ops approves it on **Requests → OD requests** (it
must be a different person). Approved classes show as **On duty (OD)** and
count as attended.

## A student says their record is wrong

Students use **Raise an issue** in the app for a past class (up to 30 days).
Their teacher sees it on the teacher home page and confirms or declines. If
confirmed, approve it on **Requests → Corrections**.

## Offline scans ("pending")

When the classroom internet drops, scans are queued on the phone and marked
**pending** until the teacher confirms them on the live attendance page.
