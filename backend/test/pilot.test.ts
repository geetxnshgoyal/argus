import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index.ts';
import { createUser, loginAs, makeApp, type TestApp } from './helpers/app.ts';
import { closeTestDb, hasDb, resetDb, testDb } from './helpers/db.ts';
import { collegeFixture, type College } from './helpers/fixtures.ts';
import { displayQr, Phone } from './helpers/phone.ts';

// Monday 2026-09-21 09:30 India; ADA runs 09:30–11:00 for the whole section.
const T0 = Date.UTC(2026, 8, 21, 4, 0, 0);

describe.skipIf(!hasDb)('pilot support: shadow mode and metrics (spec M8, ADR-0026)', () => {
  let db: Db;
  let t: TestApp;
  let c: College;
  let classId: string;
  let s1: Phone;
  let s2: Phone;
  let admin: Awaited<ReturnType<typeof loginAs>>;
  let ops: Awaited<ReturnType<typeof loginAs>>;

  async function addStudent(email: string, usn: string) {
    const u = await createUser(db, 'student', email, email.split('@')[0]);
    await db.insertInto('students').values({ user_id: u.id, usn, program_id: c.program.id, section_id: c.section.id, group_id: c.b1.id, admission_year: 2025 }).execute();
  }

  beforeEach(async () => {
    db = await testDb();
    await resetDb(db);
    await db.insertInto('app_settings').values({ key: 'shadow_mode', value: JSON.stringify(false) }).execute();
    c = await collegeFixture(db);
    t = await makeApp({ db, now: T0, config: { env: 'dev', attestationBypass: true } });
    await createUser(db, 'acadops', 'ops@college.test', 'Ops');
    await createUser(db, 'admin', 'admin@college.test', 'Admin');
    ops = await loginAs(t.app, 'ops@college.test');
    admin = await loginAs(t.app, 'admin@college.test');
    await c.entry({ offering: c.off.ada.id, weekday: 1, start: '09:30', end: '11:00', teacher: c.tA.id });
    await addStudent('s1@college.test', '2102500001');
    await addStudent('s2@college.test', '2102500002');
    await t.app.inject({ method: 'POST', url: `/v1/admin/sections/${c.section.id}/sync-enrollments`, headers: ops.headers });
    await t.app.inject({ method: 'POST', url: '/v1/admin/timetable/materialize', headers: ops.headers });
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

  async function startClass() {
    const teacher = await loginAs(t.app, c.tA.email);
    const start = await t.app.inject({ method: 'POST', url: `/v1/teacher/class-sessions/${classId}/attendance/start`, headers: teacher.headers });
    expect(start.statusCode).toBe(201);
    const id = start.json().attendance_session_id as string;
    const d = (await t.app.inject({ url: `/v1/attendance/sessions/${id}/display`, headers: teacher.headers })).json();
    return { id, d, teacher };
  }

  it('only an admin can switch shadow mode; it is audited', async () => {
    expect((await t.app.inject({ url: '/v1/admin/pilot/shadow-mode', headers: ops.headers })).json()).toMatchObject({ on: false });
    const byOps = await t.app.inject({ method: 'PUT', url: '/v1/admin/pilot/shadow-mode', headers: ops.headers, payload: { on: true } });
    expect(byOps.statusCode).toBe(403);
    const on = await t.app.inject({ method: 'PUT', url: '/v1/admin/pilot/shadow-mode', headers: admin.headers, payload: { on: true } });
    expect(on.json()).toMatchObject({ on: true, updated_by_name: 'Admin' });
    const audit = await db.selectFrom('audit_log').select(['action', 'after']).where('action', '=', 'pilot.shadow_mode').executeTakeFirstOrThrow();
    expect(audit.after).toEqual({ on: true });
  });

  it('attendance started in shadow mode is marked not official everywhere, and keeps that after the switch', async () => {
    await t.app.inject({ method: 'PUT', url: '/v1/admin/pilot/shadow-mode', headers: admin.headers, payload: { on: true } });
    const { id, d, teacher } = await startClass();
    expect((await s1.scan(displayQr(d, t.clock.now))).statusCode).toBe(200);

    expect((await t.app.inject({ url: `/v1/attendance/sessions/${id}/live`, headers: teacher.headers })).json().session.shadow).toBe(true);
    expect((await t.app.inject({ url: '/v1/me/sessions/active', headers: s1.auth })).json().items[0]).toMatchObject({ shadow: true });
    const adminList = await t.app.inject({ url: '/v1/admin/attendance/sessions?date=2026-09-21', headers: ops.headers });
    expect(adminList.json().items[0]).toMatchObject({ shadow: true });

    // Turning shadow mode off later doesn't make this class official.
    await t.app.inject({ method: 'PUT', url: '/v1/admin/pilot/shadow-mode', headers: admin.headers, payload: { on: false } });
    await t.app.inject({ method: 'POST', url: `/v1/attendance/sessions/${id}/end`, headers: teacher.headers });
    const history = (await t.app.inject({ url: '/v1/me/attendance', headers: s1.auth })).json();
    expect(history).toMatchObject({ shadow_mode: false });
    expect(history.recent[0]).toMatchObject({ code: 'ADA', status: 'present', shadow: true });
  });

  it('metrics: false rejects, scan-to-mark time, support and spot checks against the §17 targets', async () => {
    await addStudent('s3@college.test', '2102500003');
    await t.app.inject({ method: 'POST', url: `/v1/admin/sections/${c.section.id}/sync-enrollments`, headers: ops.headers });
    const s3 = await new Phone(t.app, 's3@college.test').signIn();
    await s3.bind();
    const { id, d, teacher } = await startClass();
    const epochAt = (ms: number) => Math.floor((ms - d.t0_ms) / d.epoch_ms);
    const scannedAgo = (ms: number) => ({ device_time: new Date(t.clock.now - ms).toISOString() });

    t.clock.now += 20_000;
    expect((await s1.scan(displayQr(d, t.clock.now), scannedAgo(1500))).json().decision).toBe('verified');
    // s2 first scans a stale code (a false reject: s2 was there), then succeeds.
    const stale = await s2.scan(displayQr(d, t.clock.now, epochAt(t.clock.now) - 3), scannedAgo(2500));
    expect(stale.json().code).toBe('epoch_expired');
    t.clock.now += 5_000;
    expect((await s2.scan(displayQr(d, t.clock.now), scannedAgo(2500))).statusCode).toBe(200);
    // A duplicate scan is not counted as a false reject.
    expect((await s1.scan(displayQr(d, t.clock.now))).json().code).toBe('already_marked');

    // s3 couldn't scan and asks for support.
    const support = await s3.requestSupport(id);
    expect(support.statusCode).toBe(201);
    await t.app.inject({ method: 'POST', url: `/v1/attendance/sessions/${id}/end`, headers: teacher.headers });

    const m = (await t.app.inject({ url: '/v1/admin/pilot/metrics?from=2026-09-21&to=2026-09-21', headers: ops.headers })).json();
    expect(m.totals).toMatchObject({ sessions: 1, shadow_sessions: 0, expected_students: 3, marked_present: 2 });
    const target = (k: string) => m.targets.find((x: { key: string }) => x.key === k);
    expect(target('false_reject_rate')).toMatchObject({ value: 33.33, verdict: 'fail' }); // 1 of 3 genuine scans
    expect(target('median_time_to_mark')).toMatchObject({ value: 2, verdict: 'pass' }); // accepted scans took 1.5 s and 2.5 s
    expect(target('support_request_rate')).toMatchObject({ value: 33.33, verdict: 'fail' }); // 1 request, 3 students
    expect(target('teacher_minutes').verdict).toBe('pass');
    expect(m.reject_reasons).toEqual(expect.arrayContaining([{ code: 'epoch_expired', n: 1 }, { code: 'already_marked', n: 1 }]));
    expect(m.days).toEqual([expect.objectContaining({ date: '2026-09-21', sessions: 1, support: 1 })]);

    // Another section's range is empty; a backwards range is refused.
    const empty = (await t.app.inject({ url: `/v1/admin/pilot/metrics?from=2026-09-21&to=2026-09-21&section_id=${c.otherSection.id}`, headers: ops.headers })).json();
    expect(empty.totals.sessions).toBe(0);
    expect(empty.targets.every((x: { verdict: string }) => x.verdict === 'no_data')).toBe(true);
    expect((await t.app.inject({ url: '/v1/admin/pilot/metrics?from=2026-09-22&to=2026-09-21', headers: ops.headers })).statusCode).toBe(400);
    // Teachers and students can't see pilot metrics.
    expect((await t.app.inject({ url: '/v1/admin/pilot/metrics?from=2026-09-21&to=2026-09-21', headers: teacher.headers })).statusCode).toBe(403);
  });
});
