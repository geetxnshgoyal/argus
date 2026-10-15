import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index.ts';
import { DEMO_ACCOUNTS, resetDemo } from '../src/demo/seed.ts';
import { runDueJobs } from '../src/jobs.ts';
import { cookieFrom, createUser, makeApp, type TestApp } from './helpers/app.ts';
import { closeTestDb, hasDb, resetDb, testDb } from './helpers/db.ts';

// Monday 2026-09-21 09:30 India: the demo's Data Structures class (Dr. Ananya Rao) runs 09:00–10:00.
const MONDAY_0930 = Date.UTC(2026, 8, 21, 4, 0, 0);
// Wednesday 12:30 India: Dr. Rao has no class then.
const WEDNESDAY_1230 = Date.UTC(2026, 8, 23, 7, 0, 0);

describe.skipIf(!hasDb)('demo deployment (ARGUS_DEMO)', () => {
  let db: Db;
  let t: TestApp;

  async function demoLogin(role: string) {
    const res = await t.app.inject({ method: 'POST', url: '/v1/auth/demo/login', payload: { role } });
    expect(res.statusCode).toBe(200);
    const cookie = cookieFrom(res);
    const csrf = (await t.app.inject({ url: '/v1/me', headers: { cookie } })).json().csrf_token as string;
    return { cookie, headers: { cookie, 'x-argus-csrf': csrf }, home: res.json().home as string };
  }

  beforeEach(async () => {
    db = await testDb();
    await resetDb(db);
    await db.insertInto('app_settings').values({ key: 'shadow_mode', value: JSON.stringify(false) }).execute();
    t = await makeApp({ db, now: MONDAY_0930, config: { demo: true } });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('fills an empty database on the first job run: two weeks of real-looking history', async () => {
    expect((await t.app.inject('/v1/auth/methods')).json()).toMatchObject({ demo: true });
    expect((await t.app.inject({ method: 'POST', url: '/v1/auth/demo/login', payload: { role: 'teacher' } })).statusCode).toBe(503);

    expect((await runDueJobs(t.ctx)).ran).toContain('demo_reset');
    const counts = async (table: 'users' | 'class_sessions' | 'attendance_sessions' | 'attendance_records' | 'od_requests' | 'attendance_issues' | 'risk_flags') =>
      Number((await db.selectFrom(table).select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()).n);
    expect(await counts('users')).toBe(4 + 4 + 52);
    expect(await counts('attendance_sessions')).toBeGreaterThan(40); // ~two weeks of classes, each taken
    expect(await counts('attendance_records')).toBeGreaterThan(1000);
    expect(await counts('od_requests')).toBe(3);
    expect(await counts('attendance_issues')).toBe(1);
    const statuses = await db.selectFrom('attendance_records').select('status').distinct().execute();
    expect(statuses.map((s) => s.status).sort()).toEqual(['absent', 'present']);
    // A second run the same day does nothing.
    expect((await runDueJobs(t.ctx)).ran).not.toContain('demo_reset');
  });

  it('one click signs in as each staff role; students only exist as sample data', async () => {
    await resetDemo(t.ctx);
    for (const role of ['teacher', 'acadops', 'admin', 'community_manager'] as const) {
      const s = await demoLogin(role);
      const me = (await t.app.inject({ url: '/v1/me', headers: { cookie: s.cookie } })).json();
      expect(me.user).toMatchObject({ role, email: DEMO_ACCOUNTS[role].email });
    }
    expect((await t.app.inject({ method: 'POST', url: '/v1/auth/demo/login', payload: { role: 'student' } })).statusCode).toBe(400);
  });

  it('a teacher starts the class on now, and simulated students scan in two waves', async () => {
    await resetDemo(t.ctx);
    const teacher = await demoLogin('teacher');
    const now = (await t.app.inject({ method: 'POST', url: '/v1/demo/class-now', headers: teacher.headers })).json().class_session_id as string;
    const start = await t.app.inject({ method: 'POST', url: `/v1/teacher/class-sessions/${now}/attendance/start`, headers: teacher.headers });
    expect(start.statusCode).toBe(201);
    const session = start.json().attendance_session_id as string;
    const sim = (url: string) => t.app.inject({ method: 'POST', url, headers: teacher.headers });
    const first = (await sim(`/v1/demo/attendance-sessions/${session}/simulate`)).json();
    expect(first.added).toBeGreaterThan(20);
    expect(first.remaining).toBeGreaterThan(0);
    const second = (await sim(`/v1/demo/attendance-sessions/${session}/simulate`)).json();
    expect(second).toEqual({ added: first.remaining, remaining: 0 });
    const live = (await t.app.inject({ url: `/v1/attendance/sessions/${session}/live`, headers: teacher.headers })).json();
    expect(live.counts.expected).toBe(36);
    expect(live.counts.present).toBe(34); // two students never turn up
  });

  it('adds a class starting now when the teacher is free', async () => {
    await resetDemo(t.ctx);
    t.clock.now = WEDNESDAY_1230;
    const teacher = await demoLogin('teacher');
    const res = await t.app.inject({ method: 'POST', url: '/v1/demo/class-now', headers: teacher.headers });
    expect(res.statusCode).toBe(200);
    const cls = (await t.app.inject({ url: `/v1/teacher/class-sessions/${res.json().class_session_id}`, headers: teacher.headers })).json();
    expect(cls).toMatchObject({ room: 'Seminar Hall', start: '12:30', end: '13:20', section: { name: 'CSE 2nd Year · Section B' } });
    expect(cls.expected).toBe(16);
  });

  it('redoes a fill that was cut short (accounts made, no history yet)', async () => {
    await resetDemo(t.ctx);
    await db.deleteFrom('attendance_records').execute();
    await db.deleteFrom('risk_flags').execute();
    await db.deleteFrom('attendance_attempts').execute();
    await db.deleteFrom('attendance_rounds').execute();
    await db.deleteFrom('attendance_sessions').execute();
    expect((await runDueJobs(t.ctx)).ran).toContain('demo_reset');
    expect((await db.selectFrom('attendance_sessions').select('id').execute()).length).toBeGreaterThan(40);
  });

  it("the demo's admin can reset it on the spot; a teacher can't", async () => {
    await resetDemo(t.ctx);
    const teacher = await demoLogin('teacher');
    expect((await t.app.inject({ method: 'POST', url: '/v1/demo/reset', headers: teacher.headers })).statusCode).toBe(403);
    const admin = await demoLogin('admin');
    const r = await t.app.inject({ method: 'POST', url: '/v1/demo/reset', headers: admin.headers });
    expect(r.statusCode).toBe(200);
    expect(r.json().students).toBe(52);
  });

  it('late in the evening the class runs until midnight', async () => {
    await resetDemo(t.ctx);
    t.clock.now = Date.UTC(2026, 8, 23, 17, 40, 0); // Wednesday 23:10 India
    const teacher = await demoLogin('teacher');
    const res = await t.app.inject({ method: 'POST', url: '/v1/demo/class-now', headers: teacher.headers });
    expect(res.statusCode).toBe(200);
    const cls = (await t.app.inject({ url: `/v1/teacher/class-sessions/${res.json().class_session_id}`, headers: teacher.headers })).json();
    expect(cls).toMatchObject({ start: '23:10', end: '23:59' });
  });

  it('never wipes a database with real accounts', async () => {
    await createUser(db, 'admin', 'principal@real-college.edu');
    await expect(resetDemo(t.ctx)).rejects.toThrow(/non-demo accounts/);
    await runDueJobs(t.ctx); // the nightly reset refuses too, and says why
    expect(await db.selectFrom('users').select('email').execute()).toEqual([{ email: 'principal@real-college.edu' }]);
    const job = await db.selectFrom('job_runs').select('last_error').where('name', '=', 'demo_reset').executeTakeFirstOrThrow();
    expect(job.last_error).toMatch(/non-demo accounts/);
  });

  it('is entirely off on a normal deployment', async () => {
    const normal = await makeApp({ db, now: MONDAY_0930 });
    expect((await normal.app.inject({ method: 'POST', url: '/v1/auth/demo/login', payload: { role: 'admin' } })).statusCode).toBe(404);
    expect((await normal.app.inject({ method: 'POST', url: '/v1/demo/class-now' })).statusCode).toBe(404);
    expect((await normal.app.inject('/v1/auth/methods')).json().demo).toBe(false);
    await expect(resetDemo(normal.ctx)).rejects.toThrow();
    await normal.app.close();
  });
});
