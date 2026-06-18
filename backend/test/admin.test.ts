import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index.ts';
import { createUser, loginAs, makeApp, type TestApp } from './helpers/app.ts';
import { closeTestDb, hasDb, resetDb, testDb } from './helpers/db.ts';

describe.skipIf(!hasDb)('admin (integration)', () => {
  let db: Db;
  let t: TestApp;
  let ops: Awaited<ReturnType<typeof loginAs>>;

  beforeEach(async () => {
    db = await testDb();
    await resetDb(db);
    t = await makeApp({ db });
    await createUser(db, 'acadops', 'ops@college.test', 'Ops');
    ops = await loginAs(t.app, 'ops@college.test');
  });
  afterAll(async () => {
    await t?.app.close();
    await closeTestDb();
  });

  const post = (url: string, payload: unknown, headers = ops.headers) => t.app.inject({ method: 'POST', url, headers, payload: payload as object });
  const patch = (url: string, payload: unknown, headers = ops.headers) => t.app.inject({ method: 'PATCH', url, headers, payload: payload as object });

  async function orgFixture() {
    const dept = (await post('/v1/admin/departments', { code: 'cse', name: 'Computer Science' })).json();
    const prog = (await post('/v1/admin/programs', { code: 'BTECH-CSE', name: 'B.Tech CSE', department_id: dept.id })).json();
    const term = (await post('/v1/admin/terms', { name: '2026 Odd', start_date: '2026-08-01', end_date: '2026-12-15' })).json();
    const sec = (await post('/v1/admin/sections', { program_id: prog.id, term_id: term.id, name: '2nd Year 3rd Sem' })).json();
    return { dept, prog, term, sec };
  }

  it('only Acad Ops and admins can use the admin API', async () => {
    await createUser(db, 'teacher', 't@college.test');
    const teacher = await loginAs(t.app, 't@college.test');
    expect((await t.app.inject({ url: '/v1/admin/rooms', headers: teacher.headers })).statusCode).toBe(403);
    expect((await t.app.inject({ url: '/v1/admin/rooms' })).statusCode).toBe(401);
  });

  it('creates, lists, updates and deletes org data, auditing every change', async () => {
    const { dept } = await orgFixture();
    expect(dept.code).toBe('CSE'); // codes are normalised to upper case
    const list = (await t.app.inject({ url: '/v1/admin/departments?q=comp', headers: ops.headers })).json();
    expect(list.total).toBe(1);
    const upd = await patch(`/v1/admin/departments/${dept.id}`, { name: 'CSE Dept' });
    expect(upd.json().name).toBe('CSE Dept');
    const room = (await post('/v1/admin/rooms', { code: 'Classroom 6', capacity: 70 })).json();
    const del = await t.app.inject({ method: 'DELETE', url: `/v1/admin/rooms/${room.id}`, headers: ops.headers });
    expect(del.statusCode).toBe(204);

    const actions = (await db.selectFrom('audit_log').select('action').orderBy('id').execute()).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['department.create', 'program.create', 'term.create', 'section.create', 'department.update', 'room.create', 'room.delete']));
    const d = await db.selectFrom('audit_log').select(['before', 'after', 'actor_id']).where('action', '=', 'department.update').executeTakeFirstOrThrow();
    expect(d.before).toMatchObject({ name: 'Computer Science' });
    expect(d.after).toMatchObject({ name: 'CSE Dept' });
    expect(d.actor_id).toBeTruthy();
  });

  it('reports duplicates and in-use deletes in plain language', async () => {
    const { dept } = await orgFixture();
    const dup = await post('/v1/admin/departments', { code: 'CSE', name: 'Again' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('duplicate');
    const inUse = await t.app.inject({ method: 'DELETE', url: `/v1/admin/departments/${dept.id}`, headers: ops.headers });
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json().code).toBe('in_use');
  });

  it('validates input with field-level messages', async () => {
    const res = await post('/v1/admin/terms', { name: 'Bad', start_date: '2026-12-01', end_date: '2026-01-01' });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.fields).toHaveProperty('end_date');
    const cidr = await post('/v1/admin/campus-networks', { cidr: 'not-a-cidr' });
    expect(cidr.json().details.fields).toHaveProperty('cidr');
    const ok = await post('/v1/admin/campus-networks', { cidr: '203.0.113.0/24', label: 'Campus egress' });
    expect(ok.statusCode).toBe(201);
  });

  it('keeps offerings, enrollments and teaching assignments consistent', async () => {
    const { term, sec, prog } = await orgFixture();
    const otherTerm = (await post('/v1/admin/terms', { name: '2027 Even', start_date: '2027-01-01', end_date: '2027-05-01' })).json();
    const subj = (await post('/v1/admin/subjects', { code: 'ADA', name: 'Analysis and Design of Algorithms', kind: 'lecture' })).json();
    const bad = await post('/v1/admin/offerings', { term_id: otherTerm.id, subject_id: subj.id, section_id: sec.id });
    expect(bad.json().code).toBe('invalid_section');
    const off = (await post('/v1/admin/offerings', { term_id: term.id, subject_id: subj.id, section_id: sec.id })).json();

    // A batch from another section cannot be used.
    const otherSec = (await post('/v1/admin/sections', { program_id: prog.id, term_id: term.id, name: 'Other' })).json();
    const foreignGroup = (await post('/v1/admin/groups', { section_id: otherSec.id, name: 'Batch 1' })).json();
    const stuRes = await post('/v1/admin/users', {
      role: 'student', name: 'Stu', email: 'stu@college.test',
      student: { usn: '2102500001', program_id: prog.id, section_id: sec.id, admission_year: 2025 },
    });
    expect(stuRes.statusCode).toBe(201);
    const enr = await post('/v1/admin/enrollments', { student_id: stuRes.json().id, offering_id: off.id, group_id: foreignGroup.id });
    expect(enr.json().code).toBe('invalid_group');
    expect((await post('/v1/admin/enrollments', { student_id: stuRes.json().id, offering_id: off.id })).statusCode).toBe(201);
  });

  describe('users and roles', () => {
    it('Acad Ops can create students and teachers but not staff roles', async () => {
      const { dept } = await orgFixture();
      const teacher = await post('/v1/admin/users', { role: 'teacher', name: 'Dr T', email: 'drt@college.test', teacher: { faculty_id: 'F001', department_id: dept.id } });
      expect(teacher.statusCode).toBe(201);
      const verifier = await post('/v1/admin/users', { role: 'verifier', name: 'V', email: 'v@college.test' });
      expect(verifier.statusCode).toBe(403);
    });

    it('rejects emails outside the college domain', async () => {
      const res = await post('/v1/admin/users', { role: 'teacher', name: 'X', email: 'x@gmail.com', teacher: { faculty_id: 'F9', department_id: '00000000-0000-7000-8000-000000000000' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().details.fields).toHaveProperty('email');
    });

    it('admins can grant staff roles only with a recent sign-in', async () => {
      await createUser(db, 'admin', 'admin@college.test');
      const admin = await loginAs(t.app, 'admin@college.test');
      expect((await post('/v1/admin/users', { role: 'verifier', name: 'V', email: 'v@college.test' }, admin.headers)).statusCode).toBe(201);
      t.clock.now += 16 * 60 * 1000;
      const late = await post('/v1/admin/users', { role: 'verifier', name: 'W', email: 'w@college.test' }, admin.headers);
      expect(late.statusCode).toBe(401);
      expect(late.json().code).toBe('reauth_required');
    });

    it('disabling a user ends their sessions', async () => {
      const u = await createUser(db, 'teacher', 't@college.test');
      const teacher = await loginAs(t.app, 't@college.test');
      expect((await patch(`/v1/admin/users/${u.id}`, { status: 'disabled' })).statusCode).toBe(200);
      expect((await t.app.inject({ url: '/v1/me', headers: teacher.headers })).statusCode).toBe(401);
    });

    it('cannot disable yourself', async () => {
      const me = (await t.app.inject({ url: '/v1/me', headers: ops.headers })).json();
      expect((await patch(`/v1/admin/users/${me.user.id}`, { status: 'disabled' })).json().code).toBe('cannot_disable_self');
    });
  });

  describe('student roster import', () => {
    // Synthetic rows in the shape the web app extracts from the college export.
    const rows = [
      { usn: '2102500001', name: 'Asha  Rao', email: 'asha@college.test', batch: 'Batch 1', status: 'active' },
      { usn: '2102500002', name: 'Ravi Kumar', email: 'ravi@college.test', batch: 'Batch 2', status: null },
      { usn: '2102500003', name: 'Left Student', email: 'left@college.test', batch: 'Batch 2', status: 'left' },
    ];

    async function importRows(body: Record<string, unknown>, dryRun: boolean) {
      return post(`/v1/admin/students/import?dry_run=${dryRun}`, body);
    }

    it('dry-runs, then imports, creating batches and disabling students who left', async () => {
      const { prog, sec } = await orgFixture();
      const body = { program_id: prog.id, section_id: sec.id, admission_year: 2025, rows };
      const dry = (await importRows(body, true)).json();
      expect(dry.summary).toEqual({ create: 3, update: 0, unchanged: 0, error: 0, disabled: 1 });
      expect(dry.groups_to_create).toEqual(['Batch 1', 'Batch 2']);
      expect(await db.selectFrom('users').select('id').where('role', '=', 'student').execute()).toHaveLength(0);

      const done = await importRows(body, false);
      expect(done.statusCode).toBe(200);
      const students = await db
        .selectFrom('students as s')
        .innerJoin('users as u', 'u.id', 's.user_id')
        .innerJoin('section_groups as g', 'g.id', 's.group_id')
        .select(['s.usn', 'u.name', 'u.status', 'g.name as batch'])
        .orderBy('s.usn')
        .execute();
      expect(students).toEqual([
        { usn: '2102500001', name: 'Asha Rao', status: 'active', batch: 'Batch 1' },
        { usn: '2102500002', name: 'Ravi Kumar', status: 'active', batch: 'Batch 2' },
        { usn: '2102500003', name: 'Left Student', status: 'disabled', batch: 'Batch 2' },
      ]);

      // Re-importing the same file changes nothing.
      const again = (await importRows(body, true)).json();
      expect(again.summary).toMatchObject({ create: 0, update: 0, unchanged: 3 });

      // A change of batch is detected as an update.
      const moved = (await importRows({ ...body, rows: [{ ...rows[0], batch: 'Batch 2' }] }, true)).json();
      expect(moved.rows[0]).toMatchObject({ action: 'update', changes: ['batch'] });
    });

    it('flags bad rows and refuses to import until they are fixed', async () => {
      const { prog, sec } = await orgFixture();
      const bad = [
        { usn: '2102500001', name: 'A', email: 'a@college.test' },
        { usn: '2102500001', name: 'Dup', email: 'b@college.test' },
        { usn: '', name: 'No USN', email: 'c@college.test' },
        { usn: '2102500004', name: 'Wrong domain', email: 'd@gmail.com' },
      ];
      const body = { program_id: prog.id, section_id: sec.id, admission_year: 2025, rows: bad };
      const dry = (await importRows(body, true)).json();
      expect(dry.summary.error).toBe(3);
      expect(dry.rows[1].errors).toContain('USN appears more than once in the file');
      const commit = await importRows(body, false);
      expect(commit.statusCode).toBe(400);
      expect(commit.json().code).toBe('import_has_errors');
      expect(await db.selectFrom('users').select('id').where('role', '=', 'student').execute()).toHaveLength(0);
    });

    it('audits the import', async () => {
      const { prog, sec } = await orgFixture();
      await importRows({ program_id: prog.id, section_id: sec.id, admission_year: 2025, rows }, false);
      const a = await db.selectFrom('audit_log').select(['action', 'after']).where('action', '=', 'students.import').executeTakeFirstOrThrow();
      expect(a.after).toMatchObject({ summary: { create: 3 } });
    });
  });

  describe('audit endpoints', () => {
    it('lists audit entries newest first and verifies the chain', async () => {
      await orgFixture();
      const page = (await t.app.inject({ url: '/v1/admin/audit?entity_type=department', headers: ops.headers })).json();
      expect(page.items[0]).toMatchObject({ action: 'department.create', actor_name: 'Ops' });
      const v = (await post('/v1/admin/audit/verify', {})).json();
      expect(v.ok).toBe(true);

      await sql`alter table audit_log disable trigger audit_log_no_update`.execute(db);
      await sql`update audit_log set action = 'forged' where id = 1`.execute(db);
      await sql`alter table audit_log enable trigger audit_log_no_update`.execute(db);
      const bad = (await post('/v1/admin/audit/verify', {})).json();
      expect(bad).toMatchObject({ ok: false, problem: { id: '1' } });
    });
  });
});
