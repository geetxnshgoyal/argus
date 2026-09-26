import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index.ts';
import { dayLabel } from '../src/notices/service.ts';
import { createUser, loginAs, makeApp, type TestApp } from './helpers/app.ts';
import { closeTestDb, hasDb, resetDb, testDb } from './helpers/db.ts';
import { collegeFixture, type College } from './helpers/fixtures.ts';
import { Phone } from './helpers/phone.ts';

// Monday 2026-09-21 09:30 India. The Batch 1 lab is on Wednesdays 10:00–11:00.
const T0 = Date.UTC(2026, 8, 21, 4, 0, 0);
const WED = '2026-09-23';

describe('dayLabel', () => {
  it('reads like a calendar', () => {
    expect(dayLabel('2026-09-23')).toBe('Wed 23 Sep');
    expect(dayLabel('2027-01-03')).toBe('Sun 3 Jan');
  });
});

describe.skipIf(!hasDb)('notices from Acad Ops (integration, ADR-0023)', () => {
  let db: Db;
  let t: TestApp;
  let c: College;
  let ops: Awaited<ReturnType<typeof loginAs>>;
  let tA: Awaited<ReturnType<typeof loginAs>>;
  let s1: Phone;
  let s2: Phone;
  let ids: Record<'s1' | 's2' | 'other', string>;
  let labEntry: string;

  const req = (method: 'GET' | 'POST' | 'DELETE', url: string, headers: Record<string, string>, payload?: unknown) =>
    t.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const recipientsOf = async (noticeId: string) =>
    (await db.selectFrom('notice_recipients').select('user_id').where('notice_id', '=', noticeId).execute()).map((r) => r.user_id).sort();
  const inbox = async (who: Phone | Awaited<ReturnType<typeof loginAs>>) => (await req('GET', '/v1/me/notices', who instanceof Phone ? who.auth : who.headers)).json();

  beforeEach(async () => {
    db = await testDb();
    await resetDb(db);
    c = await collegeFixture(db);
    t = await makeApp({ db, now: T0, config: { env: 'dev', attestationBypass: true } });
    await createUser(db, 'acadops', 'ops@college.test', 'Ops One');
    ops = await loginAs(t.app, 'ops@college.test');
    labEntry = (await c.entry({ offering: c.off.adaLab.id, group: c.b1.id, weekday: 3, start: '10:00', end: '11:00' })).id;
    await c.assign(c.tA.id, c.off.adaLab.id, c.b1.id);
    await c.assign(c.tB.id, c.off.adaLab.id, c.b2.id);
    await c.assign(c.tB.id, c.off.ada.id);
    const add = async (email: string, usn: string, section: string, group: string | null) => {
      const u = await createUser(db, 'student', email);
      await db.insertInto('students').values({ user_id: u.id, usn, program_id: c.program.id, section_id: section, group_id: group, admission_year: 2025 }).execute();
      return u.id;
    };
    ids = {
      s1: await add('s1@college.test', '2102500001', c.section.id, c.b1.id),
      s2: await add('s2@college.test', '2102500002', c.section.id, c.b2.id),
      other: await add('s3@college.test', '2102500003', c.otherSection.id, null),
    };
    await req('POST', `/v1/admin/sections/${c.section.id}/sync-enrollments`, ops.headers, {});
    await req('POST', '/v1/admin/timetable/materialize', ops.headers, {});
    tA = await loginAs(t.app, c.tA.email);
    s1 = await new Phone(t.app, 's1@college.test').signIn();
    s2 = await new Phone(t.app, 's2@college.test').signIn();
  });
  afterAll(async () => {
    await t?.app.close();
    await closeTestDb();
  });

  it('an announcement for one lab batch reaches that batch and its teachers only; read receipts; withdraw', async () => {
    const audience = { kind: 'section', section_id: c.section.id, group_id: c.b1.id };
    const preview = await req('POST', '/v1/admin/notices/audience', ops.headers, { audience });
    expect(preview.json()).toEqual({ label: '2nd Year 3rd Sem · Batch 1', students: 1, teachers: 2 }); // tA (batch), tB (whole-section ADA)

    const posted = await req('POST', '/v1/admin/notices', ops.headers, { title: 'Lab record due Friday', body: 'Bring your lab record.', audience });
    expect(posted.statusCode).toBe(201);
    expect(posted.json()).toMatchObject({ recipients: 3, students: 1, teachers: 2 });
    const id = posted.json().id;
    expect(await recipientsOf(id)).toEqual([ids.s1, c.tA.id, c.tB.id].sort());

    const mine = await inbox(s1);
    expect(mine.unread).toBe(1);
    expect(mine.items[0]).toMatchObject({ id, kind: 'announcement', title: 'Lab record due Friday', body: 'Bring your lab record.', read: false, class_date: null });
    expect((await inbox(s2)).items).toEqual([]);
    expect((await inbox(tA)).unread).toBe(1); // teachers see it on the web

    expect((await req('POST', '/v1/me/notices/read', s1.auth, { ids: [id] })).statusCode).toBe(204);
    expect((await inbox(s1)).unread).toBe(0);
    const list = (await req('GET', '/v1/admin/notices', ops.headers)).json().items;
    expect(list[0]).toMatchObject({ id, audience_label: '2nd Year 3rd Sem · Batch 1', recipients: 3, read: 1, created_by_name: 'Ops One', withdrawn_at: null });

    expect((await req('DELETE', `/v1/admin/notices/${id}`, ops.headers)).statusCode).toBe(204);
    expect((await inbox(s1)).items).toEqual([]);
    const audit = await db.selectFrom('audit_log').select('action').where('entity_type', '=', 'notice').orderBy('id').execute();
    expect(audit.map((a) => a.action)).toEqual(['notice.post', 'notice.withdraw']);
  });

  it('refuses empty audiences, students and teachers cannot post', async () => {
    const empty = await req('POST', '/v1/admin/notices', ops.headers, { title: 'Hello', audience: { kind: 'offering', offering_id: c.off.otherAda.id } });
    expect(empty.json().code).toBe('no_recipients');
    expect((await req('POST', '/v1/admin/notices', tA.headers, { title: 'Hello', audience: { kind: 'students' } })).statusCode).toBe(403);
    expect((await req('POST', '/v1/admin/notices', s1.auth, { title: 'Hello', audience: { kind: 'students' } })).statusCode).toBe(403);
    const wrongBatch = await req('POST', '/v1/admin/notices/audience', ops.headers, { audience: { kind: 'section', section_id: c.otherSection.id, group_id: c.b1.id } });
    expect(wrongBatch.json().code).toBe('invalid_reference');
    const everyone = await req('POST', '/v1/admin/notices', ops.headers, { title: 'Holiday on Friday', audience: { kind: 'everyone' } });
    expect(everyone.json()).toMatchObject({ students: 3, teachers: 3 });
  });

  it('moving a class tells its students and both teachers; undoing it says it is back to normal', async () => {
    const moved = await req('POST', '/v1/admin/timetable/overrides', ops.headers, {
      date: WED,
      action: 'modify',
      entry_id: labEntry,
      new_room_id: c.room.concept.id,
      new_teacher_id: c.tC.id,
      reason: 'Teacher A on leave',
      notice: 'Bring your laptops.',
    });
    expect(moved.statusCode).toBe(201);
    expect(moved.json().notified).toBe(3);
    const n = (await inbox(s1)).items[0];
    expect(n).toMatchObject({ kind: 'class_change', title: 'ADA LAB changed · Wed 23 Sep', class_date: WED, read: false });
    expect(n.body).toBe('ADA Lab (Batch 1) on Wed 23 Sep:\nRoom: Classroom 6 → Concept Room\nTeacher: Teacher A → Teacher C\n\nBring your laptops.');
    expect(n.body).not.toContain('leave'); // the reason stays internal
    expect(await recipientsOf(n.id)).toEqual([ids.s1, c.tA.id, c.tC.id].sort());
    expect((await inbox(s2)).items).toEqual([]);

    const ov = moved.json().id;
    expect((await req('DELETE', `/v1/admin/timetable/overrides/${ov}`, ops.headers)).statusCode).toBe(204);
    const after = (await inbox(s1)).items;
    expect(after).toHaveLength(1); // the change notice was withdrawn
    expect(after[0]).toMatchObject({ title: 'ADA LAB back to normal · Wed 23 Sep', body: 'ADA Lab (Batch 1) on Wed 23 Sep is on as usual: 10:00–11:00 in Classroom 6 with Teacher A.' });
    expect(await recipientsOf(after[0].id)).toEqual([ids.s1, c.tA.id, c.tC.id].sort());

    // Class-change notices leave the app once their day is over.
    t.clock.now = Date.UTC(2026, 8, 24, 4, 0, 0);
    await s1.signIn(); // the 15-minute access token has expired by now
    expect((await inbox(s1)).items).toEqual([]);
  });

  it('cancelling, replacing and adding classes; notify:false stays quiet', async () => {
    const cancel = await req('POST', '/v1/admin/timetable/overrides', ops.headers, { date: WED, action: 'cancel', entry_id: labEntry, reason: 'Lab maintenance' });
    const first = (await inbox(s1)).items[0];
    expect(first).toMatchObject({ title: 'ADA LAB cancelled · Wed 23 Sep', body: 'ADA Lab (Batch 1) at 10:00–11:00 on Wed 23 Sep will not take place.' });

    // A new change for the same class and day replaces the old one, and its notice.
    await req('POST', '/v1/admin/timetable/overrides', ops.headers, { date: WED, action: 'modify', entry_id: labEntry, new_start: '11:00', new_end: '12:00', reason: 'Moved later' });
    const items = (await inbox(s1)).items;
    expect(items.map((i: { title: string }) => i.title)).toEqual(['ADA LAB changed · Wed 23 Sep']);
    expect(items[0].body).toContain('Time: 10:00–11:00 → 11:00–12:00');
    expect(cancel.json().notified).toBe(2); // s1 + Teacher A

    const extra = await req('POST', '/v1/admin/timetable/overrides', ops.headers, {
      date: '2026-09-25',
      action: 'add',
      new_offering_id: c.off.ada.id,
      new_start: '14:00',
      new_end: '15:00',
      new_room_id: c.room.c6.id,
      reason: 'Extra class before the test',
    });
    expect(extra.statusCode).toBe(201);
    const extraNotice = (await inbox(s2)).items[0];
    expect(extraNotice).toMatchObject({ title: 'Extra ADA class · Fri 25 Sep', body: 'Analysis and Design of Algorithms, 14:00–15:00 in Classroom 6 with Teacher B.' });
    expect((await inbox(s1)).items).toHaveLength(2);
    expect((await req('DELETE', `/v1/admin/timetable/overrides/${extra.json().id}`, ops.headers)).statusCode).toBe(204);
    expect((await inbox(s2)).items[0].title).toBe('Extra ADA class called off · Fri 25 Sep');

    const quiet = await req('POST', '/v1/admin/timetable/overrides', ops.headers, { date: '2026-09-30', action: 'cancel', entry_id: labEntry, reason: 'Exam', notify: false });
    expect(quiet.json().notified).toBe(0);
    expect(await db.selectFrom('notices').select('id').where('class_date', '=', '2026-09-30').execute()).toEqual([]);
  });
});
