import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index.ts';
import { createUser, loginAs, makeApp, type TestApp } from './helpers/app.ts';
import { closeTestDb, hasDb, resetDb, testDb } from './helpers/db.ts';
import { collegeFixture, type College } from './helpers/fixtures.ts';
import { displayQr, Phone } from './helpers/phone.ts';

// Monday 2026-09-21 09:30 India; ADA runs 09:30–11:00 for the whole section.
const T0 = Date.UTC(2026, 8, 21, 4, 0, 0);
const AFTER_CLASS = Date.UTC(2026, 8, 21, 6, 0, 0); // 11:30

type Headers = Awaited<ReturnType<typeof loginAs>>;

describe.skipIf(!hasDb)('OD requests and attendance issues (ADR-0027)', () => {
  let db: Db;
  let t: TestApp;
  let c: College;
  let classId: string;
  let s1: Phone;
  let s2: Phone;
  let ops: Headers;
  let ops2: Headers;
  let cm: Headers;

  async function addStudent(email: string, usn: string) {
    const u = await createUser(db, 'student', email, email.split('@')[0]);
    await db.insertInto('students').values({ user_id: u.id, usn, program_id: c.program.id, section_id: c.section.id, group_id: c.b1.id, admission_year: 2025 }).execute();
    return u;
  }
  const post = (url: string, headers: Record<string, string>, payload: object = {}) => t.app.inject({ method: 'POST', url, headers, payload });
  const get = (url: string, headers: Record<string, string>) => t.app.inject({ url, headers });
  /** Re-login everyone after a clock jump past the 2 h idle sign-out. */
  async function loginStaff() {
    ops = await loginAs(t.app, 'ops@college.test');
    ops2 = await loginAs(t.app, 'ops2@college.test');
    cm = await loginAs(t.app, 'cm@college.test');
  }
  async function relogin() {
    await loginStaff();
    // Phones' access tokens last 15 minutes: sign them in again too.
    await s1.signIn();
    await s2.signIn();
  }

  beforeEach(async () => {
    db = await testDb();
    await resetDb(db);
    c = await collegeFixture(db);
    t = await makeApp({ db, now: T0, config: { env: 'dev', attestationBypass: true } });
    await createUser(db, 'acadops', 'ops@college.test', 'Ops One');
    await createUser(db, 'acadops', 'ops2@college.test', 'Ops Two');
    await createUser(db, 'community_manager', 'cm@college.test', 'Community Manager');
    await loginStaff();
    await c.entry({ offering: c.off.ada.id, weekday: 1, start: '09:30', end: '11:00', teacher: c.tA.id });
    await addStudent('s1@college.test', '2102500001');
    await addStudent('s2@college.test', '2102500002');
    await post(`/v1/admin/sections/${c.section.id}/sync-enrollments`, ops.headers);
    await post('/v1/admin/timetable/materialize', ops.headers);
    classId = (await db.selectFrom('class_sessions').select('id').where('offering_id', '=', c.off.ada.id).executeTakeFirstOrThrow()).id;
    s1 = await new Phone(t.app, 's1@college.test').signIn();
    s2 = await new Phone(t.app, 's2@college.test').signIn();
    await s1.bind();
    await s2.bind();
  });
  afterAll(async () => {
    await t?.app.close();
    await closeTestDb();
  });

  async function runClass(scanners: Phone[]) {
    const teacher = await loginAs(t.app, c.tA.email);
    const id = (await post(`/v1/teacher/class-sessions/${classId}/attendance/start`, teacher.headers)).json().attendance_session_id as string;
    const d = (await get(`/v1/attendance/sessions/${id}/display`, teacher.headers)).json();
    for (const p of scanners) expect((await p.scan(displayQr(d, t.clock.now))).statusCode).toBe(200);
    return { id, teacher };
  }
  const record = async (studentEmail: string) =>
    (await db.selectFrom('attendance_records as r').innerJoin('users as u', 'u.id', 'r.student_id').select(['r.status', 'r.basis']).where('u.email', '=', studentEmail).executeTakeFirst()) ?? null;

  it('OD in advance for a whole day: community manager, then a different Acad Ops person; the class ends as OD', async () => {
    const req = await post('/v1/me/od-requests', s2.auth, { kind: 'days', dates: ['2026-09-21'], event: 'Inter-college hackathon', reason: 'Representing the college' });
    expect(req.statusCode).toBe(201);
    expect(req.json()).toMatchObject({ status: 'pending_cm', classes: 1 });
    const id = req.json().id as string;

    // Order is enforced: Acad Ops can't approve before the community manager.
    expect((await post(`/v1/admin/od-requests/${id}/decision`, ops.headers, { decision: 'approve' })).json().code).toBe('wrong_step');
    // Only community managers (and admins) see the first queue.
    expect((await get('/v1/community/od-requests', ops.headers)).statusCode).toBe(403);
    expect((await get('/v1/community/od-requests', cm.headers)).json().items).toHaveLength(1);
    expect((await post(`/v1/community/od-requests/${id}/decision`, cm.headers, { decision: 'approve', note: 'On the event list' })).json()).toMatchObject({ status: 'pending_ops' });
    expect((await post(`/v1/admin/od-requests/${id}/decision`, ops.headers, { decision: 'approve' })).json()).toMatchObject({ status: 'approved', records_changed: 0 });

    // Class runs: s2 is shown as on duty, s1 scans.
    const { id: sessionId, teacher } = await runClass([s1]);
    const live = (await get(`/v1/attendance/sessions/${sessionId}/live`, teacher.headers)).json();
    expect(live.students.find((s: { usn: string }) => s.usn === '2102500002').state).toBe('od');
    expect(live.counts).toMatchObject({ present: 1, od: 1 });
    await post(`/v1/attendance/sessions/${sessionId}/end`, teacher.headers);
    expect(await record('s2@college.test')).toEqual({ status: 'od', basis: 'od' });
    expect(await record('s1@college.test')).toMatchObject({ status: 'present' });

    // OD counts as attended; the student sees the whole trail.
    const history = (await get('/v1/me/attendance', s2.auth)).json();
    expect(history.subjects[0]).toMatchObject({ code: 'ADA', total: 1, attended: 1, od: 1, percent: 100 });
    const mine = (await get('/v1/me/od-requests', s2.auth)).json().items[0];
    expect(mine.dates).toEqual(['2026-09-21']); // dates stay calendar dates in any server time zone
    expect(mine).toMatchObject({ status: 'approved', community_manager: { name: 'Community Manager', note: 'On the event list' }, acadops: { name: 'Ops One' } });
  });

  it('OD after the class: an absent record becomes OD, a real scan is never overwritten', async () => {
    const { id: sessionId, teacher } = await runClass([s1]);
    await post(`/v1/attendance/sessions/${sessionId}/end`, teacher.headers);
    expect((await record('s2@college.test'))?.status).toBe('absent');

    t.clock.now = AFTER_CLASS;
    await relogin();
    const a = (await post('/v1/me/od-requests', s2.auth, { kind: 'classes', class_session_ids: [classId], event: 'NSS camp', reason: 'Called by the NSS officer' })).json().id;
    const b = (await post('/v1/me/od-requests', s1.auth, { kind: 'classes', class_session_ids: [classId], event: 'NSS camp', reason: 'Same camp' })).json().id;
    for (const id of [a, b]) {
      await post(`/v1/community/od-requests/${id}/decision`, cm.headers, { decision: 'approve' });
      await post(`/v1/admin/od-requests/${id}/decision`, ops.headers, { decision: 'approve' });
    }
    expect(await record('s2@college.test')).toEqual({ status: 'od', basis: 'od' });
    expect(await record('s1@college.test')).toMatchObject({ status: 'present', basis: 'system' });
    const actions = (await db.selectFrom('audit_log').select('action').where('entity_type', '=', 'od_request').execute()).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['od.request', 'od.cm_approve', 'od.ops_approve']));
  });

  it('rejections need a note; one person cannot approve both steps; students can only cancel while waiting', async () => {
    const id = (await post('/v1/me/od-requests', s1.auth, { kind: 'days', dates: ['2026-09-22'], event: 'Sports meet', reason: 'Team member' })).json().id;
    const noNote = await post(`/v1/community/od-requests/${id}/decision`, cm.headers, { decision: 'reject' });
    expect(noNote.statusCode).toBe(400);
    // An admin can act as community manager, but then can't give the final approval too.
    await createUser(db, 'admin', 'admin@college.test', 'Admin');
    const admin = await loginAs(t.app, 'admin@college.test');
    await post(`/v1/community/od-requests/${id}/decision`, admin.headers, { decision: 'approve' });
    expect((await post(`/v1/admin/od-requests/${id}/decision`, admin.headers, { decision: 'approve' })).json().code).toBe('two_person_rule');
    expect((await post(`/v1/admin/od-requests/${id}/decision`, ops2.headers, { decision: 'reject', note: 'No letter from the coach' })).json().status).toBe('rejected');
    expect((await post(`/v1/me/od-requests/${id}/cancel`, s1.auth)).json().code).toBe('already_decided');

    const other = (await post('/v1/me/od-requests', s1.auth, { kind: 'days', dates: ['2026-09-23'], event: 'Sports meet', reason: 'Team member' })).json().id;
    expect((await post(`/v1/me/od-requests/${other}/cancel`, s2.auth)).statusCode).toBe(404); // not s2's
    expect((await post(`/v1/me/od-requests/${other}/cancel`, s1.auth)).json()).toEqual({ ok: true });
    // Classes that aren't the student's are refused.
    const theirs = await db.selectFrom('class_sessions').select('id').where('offering_id', '=', c.off.otherAda.id).executeTakeFirst();
    if (theirs) expect((await post('/v1/me/od-requests', s1.auth, { kind: 'classes', class_session_ids: [theirs.id], event: 'x event', reason: 'x reason' })).statusCode).toBe(400);
  });

  it('issue: student marked absent → teacher confirms → another person in Acad Ops approves → present', async () => {
    const { id: sessionId, teacher } = await runClass([s1]);
    // Not while the class is on.
    expect((await post('/v1/me/attendance-issues', s2.auth, { class_session_id: classId, reason: 'marked_absent_but_present', note: 'Camera would not open' })).json().code).toBe('class_ongoing');
    await post(`/v1/attendance/sessions/${sessionId}/end`, teacher.headers);

    t.clock.now = AFTER_CLASS;
    await relogin();
    const tA = await loginAs(t.app, c.tA.email);
    // s1 is already present: nothing to fix.
    expect((await post('/v1/me/attendance-issues', s1.auth, { class_session_id: classId, reason: 'marked_absent_but_present', note: 'x x x' })).json().code).toBe('no_change');
    const raised = await post('/v1/me/attendance-issues', s2.auth, { class_session_id: classId, reason: 'marked_absent_but_present', note: 'Camera would not open, I sat in row 2' });
    expect(raised.json()).toMatchObject({ status: 'pending_teacher' });
    expect((await post('/v1/me/attendance-issues', s2.auth, { class_session_id: classId, reason: 'other', note: 'again' })).json().code).toBe('already_raised');

    const queue = (await get('/v1/teacher/attendance-issues', tA.headers)).json().items;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ record_status: 'absent', student: { usn: '2102500002' }, class: { code: 'ADA' } });
    const confirmed = (await post(`/v1/teacher/attendance-issues/${queue[0].id}/answer`, tA.headers, { decision: 'confirm', note: 'She was there' })).json();
    expect(confirmed.status).toBe('pending_ops');

    // The correction goes through the usual two-person approval.
    expect((await post(`/v1/admin/attendance/corrections/${confirmed.correction_id}/approve`, ops.headers, {})).statusCode).toBe(200);
    expect(await record('s2@college.test')).toMatchObject({ status: 'present', basis: 'correction' });
    expect((await get('/v1/me/attendance-issues', s2.auth)).json().items[0]).toMatchObject({ status: 'resolved', teacher_note: 'She was there' });
  });

  it('issue declined by the teacher needs a reason; other teachers cannot see it', async () => {
    const { id: sessionId, teacher } = await runClass([s1]);
    await post(`/v1/attendance/sessions/${sessionId}/end`, teacher.headers);
    t.clock.now = AFTER_CLASS;
    await relogin();
    const tA = await loginAs(t.app, c.tA.email);
    const tB = await loginAs(t.app, c.tB.email);
    const id = (await post('/v1/me/attendance-issues', s2.auth, { class_session_id: classId, reason: 'marked_absent_but_present', note: 'I was there' })).json().id;
    expect((await get('/v1/teacher/attendance-issues', tB.headers)).json().items).toHaveLength(0);
    expect((await post(`/v1/teacher/attendance-issues/${id}/answer`, tB.headers, { decision: 'confirm' })).statusCode).toBe(404);
    expect((await post(`/v1/teacher/attendance-issues/${id}/answer`, tA.headers, { decision: 'decline' })).statusCode).toBe(400);
    expect((await post(`/v1/teacher/attendance-issues/${id}/answer`, tA.headers, { decision: 'decline', note: 'Not in class; I checked the headcount' })).json()).toEqual({ status: 'declined' });
    expect(await record('s2@college.test')).toMatchObject({ status: 'absent' });
  });
});
