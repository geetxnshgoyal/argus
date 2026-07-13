import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index.ts';
import { uuidv7 } from '../src/platform/ids.ts';
import { addDays, isoWeekday, localDate, normTime } from '../src/timetable/dates.ts';
import { materialize } from '../src/timetable/materialize.ts';
import { closeTestDb, hasDb, resetDb, testDb } from './helpers/db.ts';
import { collegeFixture, type College } from './helpers/fixtures.ts';

const TZ = 'Asia/Kolkata';
const MON = '2026-09-21';

describe('date helpers', () => {
  it('computes ISO weekdays, local dates and times', () => {
    expect(isoWeekday('2026-09-21')).toBe(1);
    expect(isoWeekday('2026-09-27')).toBe(7);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    // 20:00 UTC on the 21st is already the 22nd in India.
    expect(localDate(Date.UTC(2026, 8, 21, 20, 0), TZ)).toBe('2026-09-22');
    expect(normTime('9:30')).toBe('09:30:00');
    expect(() => normTime('25:00')).toThrow();
  });
});

describe.skipIf(!hasDb)('materialization (integration)', () => {
  let db: Db;
  let c: College;
  beforeEach(async () => {
    db = await testDb();
    await resetDb(db);
    c = await collegeFixture(db);
  });
  afterAll(closeTestDb);

  const run = (from = MON, to = addDays(MON, 13)) => db.transaction().execute((tx) => materialize(tx, { from, to }, TZ));
  const sessions = () =>
    db
      .selectFrom('class_sessions')
      .select([
        'id', 'date', 'offering_id', 'group_id', 'room_id', 'teacher_id', 'status', 'source_entry_id', 'attendance_locked',
        sql<string>`to_char(lower(time_range) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI')`.as('start_utc'),
      ])
      .orderBy('date')
      .orderBy('time_range')
      .execute();

  it('creates dated sessions from weekly entries, in college time', async () => {
    await c.entry({ offering: c.off.ada.id, weekday: 1, start: '09:30', end: '11:00' });
    await c.entry({ offering: c.off.ap.id, weekday: 3, start: '09:30', end: '11:00' });
    const r = await run();
    expect(r).toMatchObject({ created: 4, updated: 0, removed: 0 });
    const s = await sessions();
    expect(s.map((x) => x.date)).toEqual(['2026-09-21', '2026-09-23', '2026-09-28', '2026-09-30']);
    // 09:30 IST = 04:00 UTC
    expect(s[0]?.start_utc).toBe('2026-09-21T04:00');
  });

  it('is idempotent', async () => {
    await c.entry({ offering: c.off.ada.id, weekday: 1, start: '09:30', end: '11:00' });
    await run();
    expect(await run()).toMatchObject({ created: 0, updated: 0, removed: 0 });
  });

  it('respects entry validity and the term dates', async () => {
    await c.entry({ offering: c.off.ada.id, weekday: 1, start: '09:30', end: '11:00', validFrom: '2026-09-28' });
    await run();
    expect((await sessions()).map((s) => s.date)).toEqual(['2026-09-28']);
    expect(await run('2026-12-20', '2026-12-31')).toMatchObject({ created: 0 });
  });

  it('skips holidays and follows "Saturday follows Monday"', async () => {
    await c.entry({ offering: c.off.ada.id, weekday: 1, start: '09:30', end: '11:00' });
    await db.insertInto('term_calendar_days').values([
      { term_id: c.term.id, date: '2026-09-21', kind: 'holiday', note: 'Festival' },
      { term_id: c.term.id, date: '2026-09-26', kind: 'working', follows_weekday: 1, note: 'Monday timetable' },
    ]).execute();
    await run();
    expect((await sessions()).map((s) => s.date)).toEqual(['2026-09-26', '2026-09-28']);
  });

  it('a one-day override changes only that date and never the weekly entry (M2 done criterion)', async () => {
    const e = await c.entry({ offering: c.off.ada.id, weekday: 1, start: '09:30', end: '11:00' });
    await db.insertInto('timetable_overrides').values({
      id: uuidv7(), term_id: c.term.id, date: '2026-09-28', entry_id: e.id, action: 'modify', new_room_id: c.room.concept.id, reason: 'Projector broken',
    }).execute();
    await run();
    const s = await sessions();
    expect(s.find((x) => x.date === '2026-09-21')?.room_id).toBe(c.room.c6.id);
    expect(s.find((x) => x.date === '2026-09-28')?.room_id).toBe(c.room.concept.id);
    const entryAfter = await db.selectFrom('timetable_entries').select('room_id').where('id', '=', e.id).executeTakeFirstOrThrow();
    expect(entryAfter.room_id).toBe(c.room.c6.id);
  });

  it('cancel keeps a visible cancelled session and frees the room', async () => {
    const e = await c.entry({ offering: c.off.ada.id, weekday: 1, start: '09:30', end: '11:00' });
    await db.insertInto('timetable_overrides').values({ id: uuidv7(), term_id: c.term.id, date: MON, entry_id: e.id, action: 'cancel', reason: 'Teacher on leave' }).execute();
    // Another section uses the same room at the same time that day only.
    await db.insertInto('timetable_overrides').values({
      id: uuidv7(), term_id: c.term.id, date: MON, action: 'add', new_offering_id: c.off.otherAda.id, new_room_id: c.room.c6.id, new_start: '09:30', new_end: '11:00', reason: 'Extra class',
    }).execute();
    await run(MON, MON);
    const s = await sessions();
    expect(s.map((x) => [x.offering_id, x.status])).toEqual(
      expect.arrayContaining([[c.off.ada.id, 'cancelled'], [c.off.otherAda.id, 'scheduled']]),
    );
  });

  it('the database rejects a double-booked room', async () => {
    await c.entry({ offering: c.off.ada.id, weekday: 1, start: '09:30', end: '11:00' });
    await c.entry({ offering: c.off.otherAda.id, weekday: 1, start: '10:30', end: '11:30' });
    await expect(run()).rejects.toMatchObject({ code: '23P01', constraint: 'class_sessions_room_overlap' });
    expect(await sessions()).toHaveLength(0); // all-or-nothing
  });

  it('the database rejects a double-booked teacher', async () => {
    await c.entry({ offering: c.off.ada.id, weekday: 1, start: '09:30', end: '11:00', teacher: c.tA.id });
    await c.entry({ offering: c.off.otherAda.id, weekday: 1, start: '09:30', end: '11:00', room: c.room.concept.id, teacher: c.tA.id });
    await expect(run()).rejects.toMatchObject({ constraint: 'class_sessions_teacher_overlap' });
  });

  it('batches: two labs for different batches may overlap, but not a whole-section class with a batch lab', async () => {
    await c.entry({ offering: c.off.adaLab.id, weekday: 1, start: '15:30', end: '17:00', group: c.b1.id, room: c.room.concept.id });
    await c.entry({ offering: c.off.adaLab.id, weekday: 1, start: '15:30', end: '17:00', group: c.b2.id, room: c.room.c6.id });
    await expect(run()).resolves.toMatchObject({ created: 4 });

    await c.entry({ offering: c.off.ap.id, weekday: 1, start: '16:00', end: '17:00', room: null });
    await expect(run()).rejects.toMatchObject({ constraint: 'class_session_audience_overlap' });
  });

  it('takes the teacher from teaching assignments, batch-specific first', async () => {
    await c.assign(c.tA.id, c.off.adaLab.id, null);
    await c.assign(c.tB.id, c.off.adaLab.id, c.b2.id);
    await c.entry({ offering: c.off.adaLab.id, weekday: 1, start: '15:30', end: '17:00', group: c.b1.id, room: c.room.concept.id });
    await c.entry({ offering: c.off.adaLab.id, weekday: 1, start: '15:30', end: '17:00', group: c.b2.id, room: c.room.c6.id });
    await run(MON, MON);
    const s = await sessions();
    expect(s.find((x) => x.group_id === c.b1.id)?.teacher_id).toBe(c.tA.id);
    expect(s.find((x) => x.group_id === c.b2.id)?.teacher_id).toBe(c.tB.id);
  });

  it('never rewrites or removes a class that already has attendance, unless confirmed', async () => {
    const e = await c.entry({ offering: c.off.ada.id, weekday: 1, start: '09:30', end: '11:00' });
    await run(MON, MON);
    await db.updateTable('class_sessions').set({ attendance_locked: true }).execute();

    await db.updateTable('timetable_entries').set({ room_id: c.room.concept.id }).where('id', '=', e.id).execute();
    const r1 = await run(MON, MON);
    expect(r1.skippedLocked).toHaveLength(1);
    expect((await sessions())[0]?.room_id).toBe(c.room.c6.id);

    await db.insertInto('timetable_overrides').values({
      id: uuidv7(), term_id: c.term.id, date: MON, entry_id: e.id, action: 'modify', new_room_id: c.room.concept.id, reason: 'Confirmed move', applies_to_locked: true,
    }).execute();
    const r2 = await run(MON, MON);
    expect(r2.updated).toBe(1);
    expect((await sessions())[0]?.room_id).toBe(c.room.concept.id);

    // Removing the class from the weekly timetable must not delete a class with attendance.
    await db.updateTable('timetable_entries').set({ valid_to: '2026-09-20' }).where('id', '=', e.id).execute();
    const r3 = await run(MON, MON);
    expect(r3.removed).toBe(0);
    expect(r3.skippedLocked[0]?.reason).toMatch(/already has attendance/);
  });

  it('removes sessions whose entry was end-dated (when no attendance)', async () => {
    const e = await c.entry({ offering: c.off.ada.id, weekday: 1, start: '09:30', end: '11:00' });
    await run();
    await db.updateTable('timetable_entries').set({ valid_to: '2026-09-27' }).where('id', '=', e.id).execute();
    expect(await run()).toMatchObject({ removed: 1 });
  });
});
