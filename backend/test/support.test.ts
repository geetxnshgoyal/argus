import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index.ts';
import { createUser, loginAs, makeApp, type TestApp } from './helpers/app.ts';
import { closeTestDb, hasDb, resetDb, testDb } from './helpers/db.ts';
import { collegeFixture, type College } from './helpers/fixtures.ts';
import { displayQr, Phone } from './helpers/phone.ts';

// Monday 2026-09-21 09:30 India. ADA runs 09:30–11:00 (ends 05:30 UTC).
const T0 = Date.UTC(2026, 8, 21, 4, 0, 0);
const CLASS_END = Date.UTC(2026, 8, 21, 5, 30, 0);

describe.skipIf(!hasDb)('support requests and corrections (integration, spec §7, §16 #10–#11)', () => {
  let db: Db;
  let t: TestApp;
  let c: College;
  let teacher: Awaited<ReturnType<typeof loginAs>>;
  let verifier: Awaited<ReturnType<typeof loginAs>>;
  let ops: Awaited<ReturnType<typeof loginAs>>;
  let ops2: Awaited<ReturnType<typeof loginAs>>;
  let s1: Phone;
  let s2: Phone;
  let classId: string;
  let sessionId: string;
  let s1Id: string;

  const req = (method: 'GET' | 'POST' | 'PATCH', url: string, headers: Record<string, string>, payload?: unknown) =>
    t.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

  beforeEach(async () => {
    db = await testDb();
    await resetDb(db);
    c = await collegeFixture(db);
    t = await makeApp({ db, now: T0, config: { env: 'dev', attestationBypass: true } });
    await createUser(db, 'acadops', 'ops@college.test', 'Ops One');
    await createUser(db, 'acadops', 'ops2@college.test', 'Ops Two');
    await createUser(db, 'verifier', 'ver@college.test', 'Vera');
    ops = await loginAs(t.app, 'ops@college.test');
    ops2 = await loginAs(t.app, 'ops2@college.test');
    verifier = await loginAs(t.app, 'ver@college.test');
    await c.entry({ offering: c.off.ada.id, weekday: 1, start: '09:30', end: '11:00', teacher: c.tA.id });
    for (const [email, usn, group] of [['s1@college.test', '2102500001', c.b1.id], ['s2@college.test', '2102500002', c.b2.id]] as const) {
      const u = await createUser(db, 'student', email, email.split('@')[0]);
      await db.insertInto('students').values({ user_id: u.id, usn, program_id: c.program.id, section_id: c.section.id, group_id: group, admission_year: 2025 }).execute();
      if (usn.endsWith('1')) s1Id = u.id;
    }
    await req('POST', `/v1/admin/sections/${c.section.id}/sync-enrollments`, ops.headers, {});
    await req('POST', '/v1/admin/timetable/materialize', ops.headers, {});
    classId = (await db.selectFrom('class_sessions').select('id').where('date', '=', '2026-09-21').executeTakeFirstOrThrow()).id;
    teacher = await loginAs(t.app, c.tA.email);
    s1 = await new Phone(t.app, 's1@college.test').signIn();
    s2 = await new Phone(t.app, 's2@college.test').signIn();
    await s1.bind();
    await s2.bind();
    sessionId = (await req('POST', `/v1/teacher/class-sessions/${classId}/attendance/start`, teacher.headers, {})).json().attendance_session_id;
  });
  afterAll(async () => {
    await t?.app.close();
    await closeTestDb();
  });

  const display = async () => (await req('GET', `/v1/attendance/sessions/${sessionId}/display`, teacher.headers)).json();
  const record = async (studentId: string) =>
    db.selectFrom('attendance_records').select(['status', 'basis']).where('student_id', '=', studentId).where('class_session_id', '=', classId).executeTakeFirst();

  it('valid QR seen + low evidence score → verifier can approve; evidence access is audited', async () => {
    // s1 scanned a genuine code but too late (grace window missed): tag valid, attempt rejected.
    const d = await display();
    t.clock.now = d.t0_ms + 10 * 3000 + 2500;
    const late = await s1.scan(displayQr(d, t.clock.now, 9));
    expect(late.json().code).toBe('epoch_expired');

    const created = await s1.requestSupport(sessionId);
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const list = (await req('GET', '/v1/verifier/support-requests', verifier.headers)).json();
    expect(list.items[0]).toMatchObject({ id, can_approve: true, valid_tag_seen: true });
    const detail = (await req('GET', `/v1/verifier/support-requests/${id}`, verifier.headers)).json();
    expect(detail.evidence.attempts[0]).toMatchObject({ decision: 'rejected', tag_valid: true });
    expect(detail.evidence.student.usn).toBe('2102500001');
    expect(JSON.stringify(detail.evidence)).not.toContain('77.5'); // no coordinates in evidence

    const ok = await req('POST', `/v1/verifier/support-requests/${id}/decision`, verifier.headers, { action: 'approve' });
    expect(ok.statusCode).toBe(200);
    expect(await record(s1Id)).toMatchObject({ status: 'present', basis: 'verifier' });
    const actions = (await db.selectFrom('audit_log').select('action').execute()).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['support.request', 'support.view_evidence', 'support.approve']));
    const mine = (await t.app.inject({ url: '/v1/me/support-requests', headers: s1.auth })).json();
    expect(mine.items[0]).toMatchObject({ id, status: 'approved' });
  });

  it('never saw the QR → verifier cannot approve (spec §16 #10); the teacher decides', async () => {
    const id = (await s1.requestSupport(sessionId, { reason: 'camera_broken' })).json().id;
    const blocked = await req('POST', `/v1/verifier/support-requests/${id}/decision`, verifier.headers, { action: 'approve' });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('approval_not_allowed');

    expect((await req('POST', `/v1/verifier/support-requests/${id}/decision`, verifier.headers, { action: 'ask_teacher' })).statusCode).toBe(200);
    const q = (await req('GET', '/v1/teacher/support-requests', teacher.headers)).json();
    expect(q.items).toHaveLength(1);
    expect(q.items[0]).toMatchObject({ id, usn: '2102500001' });
    // Another teacher can't answer.
    const other = await loginAs(t.app, c.tB.email);
    expect((await req('POST', `/v1/support-requests/${id}/teacher-confirmation`, other.headers, { answer: 'present' })).statusCode).toBe(404);
    expect((await req('POST', `/v1/support-requests/${id}/teacher-confirmation`, teacher.headers, { answer: 'present' })).statusCode).toBe(200);
    expect(await record(s1Id)).toMatchObject({ status: 'present', basis: 'teacher' });
  });

  it('a high evidence score blocks approval even with a valid tag', async () => {
    const d = await display();
    t.clock.now = d.t0_ms + 10 * 3000 + 2500;
    await s1.scan(displayQr(d, t.clock.now, 9));
    const id = (await s1.requestSupport(sessionId, { location: { lat: 12.9, lon: 77.5, accuracy_m: 5, fix_age_ms: 10, is_mock: true } })).json().id;
    const detail = (await req('GET', `/v1/verifier/support-requests/${id}`, verifier.headers)).json();
    expect(detail.evidence_score).toBeGreaterThanOrEqual(70);
    expect(detail.can_approve).toBe(false);
    expect((await req('POST', `/v1/verifier/support-requests/${id}/decision`, verifier.headers, { action: 'approve' })).json().code).toBe('approval_not_allowed');
  });

  it('teacher "not sure" returns it to the verifier, who can reject with a reason', async () => {
    const id = (await s1.requestSupport(sessionId)).json().id;
    await req('POST', `/v1/verifier/support-requests/${id}/decision`, verifier.headers, { action: 'ask_teacher' });
    await req('POST', `/v1/support-requests/${id}/teacher-confirmation`, teacher.headers, { answer: 'not_sure' });
    const d = (await req('GET', `/v1/verifier/support-requests/${id}`, verifier.headers)).json();
    expect(d).toMatchObject({ status: 'pending', teacher: { answer: 'not_sure' } });
    expect((await req('POST', `/v1/verifier/support-requests/${id}/decision`, verifier.headers, { action: 'reject' })).statusCode).toBe(400);
    const r = await req('POST', `/v1/verifier/support-requests/${id}/decision`, verifier.headers, { action: 'reject', reason: 'Teacher could not confirm' });
    expect(r.json().status).toBe('rejected');
    const mine = (await t.app.inject({ url: `/v1/support-requests/${id}`, headers: s1.auth })).json();
    expect(mine).toMatchObject({ status: 'rejected', decision_reason: 'Teacher could not confirm' });
  });

  it('only during class, only once, only if not already marked, only from the bound phone', async () => {
    const d = await display();
    await s2.scan(displayQr(d, t.clock.now));
    expect((await s2.requestSupport(sessionId)).json().code).toBe('already_marked');
    expect((await s1.requestSupport(sessionId)).statusCode).toBe(201);
    expect((await s1.requestSupport(sessionId)).json().code).toBe('already_requested');
    const second = await new Phone(t.app, 's1@college.test').signIn();
    await second.bind(); // pending phone
    expect((await second.requestSupport(sessionId)).json().code).toBe('device_not_active');
    t.clock.now = CLASS_END + 60_000;
    await s1.signIn(); // the 15-minute access token expired with the clock jump
    expect((await s1.requestSupport(sessionId)).json().code).toBe('class_not_ongoing');
  });

  it('decisions stop 15 minutes after class end; open requests expire', async () => {
    const id = (await s1.requestSupport(sessionId)).json().id;
    t.clock.now = CLASS_END + 16 * 60_000;
    verifier = await loginAs(t.app, 'ver@college.test');
    const late = await req('POST', `/v1/verifier/support-requests/${id}/decision`, verifier.headers, { action: 'ask_teacher' });
    expect(late.json().code).toBe('expired');
    expect((await db.selectFrom('support_requests').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status).toBe('expired');
  });

  it('corrections: only after class, never approved by the requester (spec §16 #11), audited', async () => {
    const body = { student_id: s1Id, class_session_id: classId, new_status: 'present', reason: 'Was presenting at the front, phone in bag' };
    expect((await req('POST', '/v1/teacher/attendance/corrections', teacher.headers, body)).json().code).toBe('class_ongoing');
    await req('POST', `/v1/attendance/sessions/${sessionId}/end`, teacher.headers, {});
    t.clock.now = CLASS_END + 60 * 60_000;
    // Staff sessions idle out after 2 h; sign in again after the clock jump.
    [teacher, ops, ops2] = [await loginAs(t.app, c.tA.email), await loginAs(t.app, 'ops@college.test'), await loginAs(t.app, 'ops2@college.test')];
    expect(await record(s1Id)).toMatchObject({ status: 'absent' });

    // Another teacher can't request for this class.
    const other = await loginAs(t.app, c.tB.email);
    expect((await req('POST', '/v1/teacher/attendance/corrections', other.headers, body)).statusCode).toBe(403);

    const created = await req('POST', '/v1/admin/attendance/corrections', ops.headers, body);
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const self = await req('POST', `/v1/admin/attendance/corrections/${id}/approve`, ops.headers, {});
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('two_person_rule');
    // The database refuses it too.
    await expect(sql`update attendance_corrections set approved_by = requested_by where id = ${id}`.execute(db)).rejects.toThrow(/two_person/);

    const ok = await req('POST', `/v1/admin/attendance/corrections/${id}/approve`, ops2.headers, { note: 'ID and teacher confirmed' });
    expect(ok.statusCode).toBe(200);
    expect(await record(s1Id)).toMatchObject({ status: 'present', basis: 'correction' });
    const audit = await db.selectFrom('audit_log').select(['action', 'before', 'after']).where('action', '=', 'correction.approve').executeTakeFirstOrThrow();
    expect(audit.before).toMatchObject({ status: 'absent' });

    // Teacher-requested correction approved by Acad Ops.
    const t2 = await req('POST', '/v1/teacher/attendance/corrections', teacher.headers, { ...body, new_status: 'late' });
    expect((await req('POST', `/v1/admin/attendance/corrections/${t2.json().id}/approve`, ops.headers, {})).statusCode).toBe(200);
    expect(await record(s1Id)).toMatchObject({ status: 'late', basis: 'correction' });
    const list = (await req('GET', '/v1/admin/attendance/corrections?status=all', ops.headers)).json();
    expect(list.items).toHaveLength(2);
  });

  it('Acad Ops sessions browser, risk flag report and admin-only risk settings', async () => {
    const d = await display();
    await s1.scan(displayQr(d, t.clock.now), { location: { lat: 1, lon: 1, accuracy_m: 5, fix_age_ms: 10, is_mock: true } });
    const list = (await req('GET', '/v1/admin/attendance/sessions?date=2026-09-21', ops.headers)).json();
    expect(list.items[0]).toMatchObject({ id: sessionId, counts: { present: 1 } });
    const detail = (await req('GET', `/v1/admin/attendance/sessions/${sessionId}`, ops.headers)).json();
    expect(detail.students.find((s: { usn: string }) => s.usn === '2102500001')).toMatchObject({ record: { status: 'present' }, attempts: 1 });
    const flags = (await req('GET', '/v1/admin/risk/flags', ops.headers)).json();
    expect(flags.items[0]).toMatchObject({ type: 'flagged_high', usn: '2102500001' });
    expect((await req('POST', `/v1/admin/risk/flags/${flags.items[0].id}/resolve`, ops.headers, { resolution: 'Talked to student; GPS app uninstalled' })).statusCode).toBe(200);

    // Acad Ops can see risk settings but only admins change them (ADR-0014).
    expect((await req('GET', '/v1/admin/risk-settings', ops.headers)).json().items.length).toBeGreaterThan(10);
    expect((await req('PATCH', '/v1/admin/risk-settings/location_mock', ops.headers, { enabled: false })).statusCode).toBe(403);
    await createUser(db, 'admin', 'admin@college.test', 'Admin');
    const admin = await loginAs(t.app, 'admin@college.test');
    const off = await req('PATCH', '/v1/admin/risk-settings/location_mock', admin.headers, { enabled: false });
    expect(off.json()).toMatchObject({ key: 'location_mock', enabled: false });
    expect((await req('PATCH', '/v1/admin/risk-settings/threshold_flagged', admin.headers, { value: 90 })).json().code).toBe('validation_failed');
    // The kill switch takes effect immediately: a mock location is no longer flagged.
    const again = await s2.scan(displayQr(await display(), t.clock.now), { location: { lat: 1, lon: 1, accuracy_m: 5, fix_age_ms: 10, is_mock: true } });
    expect(again.json().decision).toBe('verified');
    expect(await db.selectFrom('audit_log').select('action').where('action', '=', 'risk_settings.update').execute()).toHaveLength(1);
  });
});

