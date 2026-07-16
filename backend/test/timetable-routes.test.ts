import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index.ts';
import { uuidv7 } from '../src/platform/ids.ts';
import { createUser, loginAs, makeApp, type TestApp } from './helpers/app.ts';
import { closeTestDb, hasDb, resetDb, testDb } from './helpers/db.ts';
import { collegeFixture, type College } from './helpers/fixtures.ts';
import { buildCollegeTimetableXlsx } from './helpers/timetable-sheet.ts';

// makeApp's clock: Monday 2026-09-21, 09:30 in India.
describe.skipIf(!hasDb)('timetable API (integration)', () => {
  let db: Db;
  let t: TestApp;
  let c: College;
  let ops: Awaited<ReturnType<typeof loginAs>>;
  let sheet: string;

  beforeEach(async () => {
    db = await testDb();
    await resetDb(db);
    c = await collegeFixture(db);
    t = await makeApp({ db });
    await createUser(db, 'acadops', 'ops@college.test', 'Ops');
    ops = await loginAs(t.app, 'ops@college.test');
    sheet ??= (await buildCollegeTimetableXlsx()).toString('base64');
  });
  afterAll(async () => {
    await t?.app.close();
    await closeTestDb();
  });

  const post = (url: string, payload: unknown, headers = ops.headers) => t.app.inject({ method: 'POST', url, headers, payload: payload as object });
  const get = (url: string, headers = ops.headers) => t.app.inject({ url, headers });

  async function addStudent(email: string, usn: string, groupId: string | null) {
    const u = await createUser(db, 'student', email);
    await db.insertInto('students').values({ user_id: u.id, usn, program_id: c.program.id, section_id: c.section.id, group_id: groupId, admission_year: 2025 }).execute();
    return u;
  }

  async function importSheet(dryRun: boolean) {
    return post(`/v1/admin/timetable/import?dry_run=${dryRun}`, { term_id: c.term.id, section_id: c.section.id, xlsx_base64: sheet });
  }

  describe('import of the college sheet', () => {
    it('dry run reports exactly what would happen and changes nothing', async () => {
      const res = await importSheet(true);
      expect(res.statusCode).toBe(200);
      const r = res.json();
      expect(r.summary).toMatchObject({ classes: 30, new: 30, errors: 0 });
      expect(r.create.rooms).toEqual(expect.arrayContaining(['Classroom 8', 'Classroom 4', 'Classroom 1']));
      expect(r.create.subjects.map((s: { code: string }) => s.code)).toEqual(expect.arrayContaining(['AI', 'M3', 'DE', 'HOLISTIC', 'AP LAB', 'M3 LAB', 'CONTEST']));
      expect(r.teacherless.length).toBeGreaterThan(0);
      expect(r.summary.sessions_scheduled).toBeGreaterThan(0); // the real scheduler ran...
      // ...and was rolled back.
      expect(await db.selectFrom('timetable_entries').select('id').execute()).toHaveLength(0);
      expect(await db.selectFrom('class_sessions').select('id').execute()).toHaveLength(0);
      expect(await db.selectFrom('rooms').select('id').execute()).toHaveLength(2);
    });

    it('imports: weekly entries, 14 days of classes, enrollments with batches, audited', async () => {
      const s1 = await addStudent('s1@college.test', '2102500001', c.b1.id);
      const s2 = await addStudent('s2@college.test', '2102500002', c.b2.id);
      const res = await importSheet(false);
      expect(res.statusCode).toBe(200);
      expect(await db.selectFrom('timetable_entries').select('id').execute()).toHaveLength(30);
      // Mon 21 – Sun 4 Oct: two weeks of Mon–Fri classes (7+7+7+6+3 per week).
      expect(await db.selectFrom('class_sessions').select('id').execute()).toHaveLength(60);
      const enr = await db.selectFrom('enrollments').select(['student_id', 'group_id', 'source']).execute();
      expect(enr.filter((e) => e.student_id === s1.id).every((e) => e.group_id === c.b1.id && e.source === 'section')).toBe(true);
      expect(enr.filter((e) => e.student_id === s2.id).length).toBeGreaterThan(0);
      const audit = await db.selectFrom('audit_log').select('action').where('action', '=', 'timetable.import').execute();
      expect(audit).toHaveLength(1);

      // Re-importing the same sheet changes nothing.
      const again = (await importSheet(true)).json();
      expect(again.summary).toMatchObject({ new: 0, unchanged: 30, ended: 0 });
    });

    it('refuses an import that would double-book a room used by another section', async () => {
      await c.entry({ offering: c.off.otherAda.id, weekday: 1, start: '09:30', end: '10:00', room: c.room.c6.id });
      const r = (await importSheet(true)).json();
      expect(r.summary.errors).toBeGreaterThan(0);
      expect(r.issues.find((i: { level: string }) => i.level === 'error').message).toMatch(/Room Classroom 6 is double-booked/);
      const commit = await importSheet(false);
      expect(commit.statusCode).toBe(400);
      expect(commit.json().code).toBe('import_has_errors');
    });
  });

  describe('students and teachers see their own classes', () => {
    it('a student sees whole-section classes plus only their own batch labs', async () => {
      await addStudent('s1@college.test', '2102500001', c.b1.id);
      await importSheet(false);
      const key = (await import('./helpers/app.ts')).deviceKey();
      const login = await t.app.inject({
        method: 'POST',
        url: '/v1/auth/dev/mobile-login',
        payload: { email: 's1@college.test', session_public_key: key.spki, signature: key.sign('argus/v1/dev-login|s1@college.test') },
      });
      const auth = { authorization: `Bearer ${login.json().access_token}` };
      const tt = (await t.app.inject({ url: '/v1/me/timetable?from=2026-09-21&to=2026-09-21', headers: auth })).json();
      expect(tt.items.map((s: { subject: { code: string }; batch: string | null }) => `${s.subject.code}${s.batch ? `/${s.batch}` : ''}`)).toEqual([
        'AP', 'ADA', 'AI', 'HOLISTIC/Batch 1', 'ADA LAB/Batch 1',
      ]);
      expect(tt.items[0]).toMatchObject({ start: '09:30', end: '11:00', room: 'Classroom 6', status: 'scheduled' });
    });

    it('a teacher sees today\'s classes with the expected student count', async () => {
      await addStudent('s1@college.test', '2102500001', c.b1.id);
      await addStudent('s2@college.test', '2102500002', c.b2.id);
      await importSheet(false);
      const ada = await db.selectFrom('course_offerings as o').innerJoin('subjects as s', 's.id', 'o.subject_id').select('o.id').where('s.code', '=', 'ADA LAB').where('o.section_id', '=', c.section.id).executeTakeFirstOrThrow();
      await post('/v1/admin/teaching-assignments', { teacher_id: c.tA.id, offering_id: ada.id, group_id: c.b1.id });
      await post('/v1/admin/timetable/materialize', {});
      const teacher = await loginAs(t.app, c.tA.email);
      const today = (await get('/v1/teacher/sessions/today', teacher.headers)).json();
      expect(today.items).toHaveLength(1);
      expect(today.items[0]).toMatchObject({ subject: { code: 'ADA LAB' }, batch: 'Batch 1', expected: 1 });
      // Other teachers cannot open this class.
      const other = await loginAs(t.app, c.tB.email);
      expect((await get(`/v1/teacher/class-sessions/${today.items[0].id}`, other.headers)).statusCode).toBe(404);
    });
  });

  describe('changes for one day', () => {
    it('moves one class for one date only; can be undone', async () => {
      const e = await c.entry({ offering: c.off.ada.id, weekday: 1, start: '09:30', end: '11:00' });
      await post('/v1/admin/timetable/materialize', {});
      const res = await post('/v1/admin/timetable/overrides', { date: '2026-09-28', action: 'modify', entry_id: e.id, new_room_id: c.room.concept.id, reason: 'Projector broken' });
      expect(res.statusCode).toBe(201);
      const rooms = async () => (await get(`/v1/admin/class-sessions?section_id=${c.section.id}&from=2026-09-21&to=2026-10-04`)).json().items.map((s: { date: string; room: string }) => `${s.date} ${s.room}`);
      expect(await rooms()).toEqual(['2026-09-21 Classroom 6', '2026-09-28 Concept Room']);
      expect((await t.app.inject({ method: 'DELETE', url: `/v1/admin/timetable/overrides/${res.json().id}`, headers: ops.headers })).statusCode).toBe(204);
      expect(await rooms()).toEqual(['2026-09-21 Classroom 6', '2026-09-28 Classroom 6']);
    });

    it('asks for confirmation before changing a class that already has attendance', async () => {
      const e = await c.entry({ offering: c.off.ada.id, weekday: 1, start: '09:30', end: '11:00' });
      await post('/v1/admin/timetable/materialize', {});
      await db.updateTable('class_sessions').set({ attendance_locked: true }).where('date', '=', '2026-09-21').execute();
      const body = { date: '2026-09-21', action: 'cancel', entry_id: e.id, reason: 'Clash with event' };
      const first = await post('/v1/admin/timetable/overrides', body);
      expect(first.statusCode).toBe(409);
      expect(first.json().code).toBe('session_has_attendance');
      const confirmed = await post('/v1/admin/timetable/overrides', { ...body, confirm: true });
      expect(confirmed.statusCode).toBe(201);
      const s = await db.selectFrom('class_sessions').select('status').where('date', '=', '2026-09-21').executeTakeFirstOrThrow();
      expect(s.status).toBe('cancelled');
    });

    it('refuses changes to past dates', async () => {
      const e = await c.entry({ offering: c.off.ada.id, weekday: 1, start: '09:30', end: '11:00' });
      const res = await post('/v1/admin/timetable/overrides', { date: '2026-09-14', action: 'cancel', entry_id: e.id, reason: 'Too late' });
      expect(res.json().code).toBe('past_date');
    });
  });

  describe('weekly entries', () => {
    it('explains double-booking in plain language', async () => {
      await c.entry({ offering: c.off.ada.id, weekday: 1, start: '09:30', end: '11:00', teacher: c.tA.id });
      const res = await post('/v1/admin/timetable/entries', { offering_id: c.off.otherAda.id, weekday: 1, start_time: '10:00', end_time: '11:00', room_id: c.room.concept.id, teacher_id: c.tA.id });
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toMatch(/Teacher A would teach two classes at once/);
    });

    it('creates an entry and schedules it immediately', async () => {
      const res = await post('/v1/admin/timetable/entries', { offering_id: c.off.ada.id, weekday: 2, start_time: '9:30', end_time: '11:00', room_id: c.room.c6.id });
      expect(res.statusCode).toBe(201);
      const s = await db.selectFrom('class_sessions').select('date').execute();
      expect(s.map((x) => x.date).sort()).toEqual(['2026-09-22', '2026-09-29']);
    });

    it('holidays remove that day\'s classes', async () => {
      await c.entry({ offering: c.off.ada.id, weekday: 2, start: '09:30', end: '11:00' });
      await post('/v1/admin/timetable/materialize', {});
      const res = await t.app.inject({ method: 'PUT', url: `/v1/admin/timetable/calendar/${c.term.id}/2026-09-22`, headers: ops.headers, payload: { kind: 'holiday', note: 'Festival' } });
      expect(res.statusCode).toBe(200);
      const s = await db.selectFrom('class_sessions').select('date').execute();
      expect(s.map((x) => x.date)).toEqual(['2026-09-29']);
    });
  });

  it('conflicts page lists missing teachers and rooms', async () => {
    await c.entry({ offering: c.off.ada.id, weekday: 1, start: '09:30', end: '11:00', room: null });
    const r = (await get(`/v1/admin/conflicts?term_id=${c.term.id}`)).json();
    expect(r.conflicts).toEqual([]);
    expect(r.warnings.map((w: { message: string }) => w.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/No teacher assigned for ADA/), expect.stringMatching(/No room set for ADA/)]),
    );
  });

  it('only Acad Ops can change the timetable', async () => {
    const teacher = await loginAs(t.app, c.tA.email);
    const res = await post('/v1/admin/timetable/overrides', { date: '2026-09-28', action: 'cancel', entry_id: uuidv7(), reason: 'x' }, teacher.headers);
    expect(res.statusCode).toBe(403);
  });
});
