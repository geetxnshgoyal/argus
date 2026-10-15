import { randomBytes } from 'node:crypto';
import { sql, type Insertable } from 'kysely';
import type { AppContext } from '../context.ts';
import type { Tx } from '../db/index.ts';
import type { AttemptDecision, AttemptSignals, Database, RecordStatus, Role } from '../db/schema.ts';
import { ApiError } from '../errors.ts';
import { postNotice } from '../notices/service.ts';
import { uuidv7 } from '../platform/ids.ts';
import { addDays, localDate } from '../timetable/dates.ts';
import { rematerialize, syncSectionEnrollments } from '../timetable/service.ts';
import { endAttendance, expectedStudents, loadClass, startAttendance } from '../attendance/service.ts';

/**
 * Demo deployment (ARGUS_DEMO): a made-up college with two weeks of attendance
 * history, flagged scans, OD requests and a student issue, so prospective
 * colleges can click through every role. Everything uses @example.edu
 * addresses; `resetDemo` refuses to touch a database holding anyone else.
 *
 * History is produced by the real timetable and attendance code run on a
 * shifted clock; only the students' scans are written directly (there are no
 * phones), shaped like real ones.
 */

export const DEMO_DOMAIN = 'example.edu';

/** One-click sign-in accounts, by role. */
export const DEMO_ACCOUNTS: Record<Exclude<Role, 'student'>, { email: string; name: string }> = {
  teacher: { email: `ananya.rao@${DEMO_DOMAIN}`, name: 'Dr. Ananya Rao' },
  acadops: { email: `acadops@${DEMO_DOMAIN}`, name: 'Meera Nair (Academic Operations)' },
  admin: { email: `admin@${DEMO_DOMAIN}`, name: 'Arjun Kapoor (Administrator)' },
  community_manager: { email: `community@${DEMO_DOMAIN}`, name: 'Kavya Menon (Community Manager)' },
};

const TEACHERS = [
  { key: 'T1', email: DEMO_ACCOUNTS.teacher.email, name: DEMO_ACCOUNTS.teacher.name },
  { key: 'T2', email: `vikram.mehta@${DEMO_DOMAIN}`, name: 'Prof. Vikram Mehta' },
  { key: 'T3', email: `sana.khan@${DEMO_DOMAIN}`, name: 'Dr. Sana Khan' },
  { key: 'T4', email: `rahul.iyer@${DEMO_DOMAIN}`, name: 'Prof. Rahul Iyer' },
] as const;

const STUDENTS_A = [
  'Aarav Sharma', 'Aditi Verma', 'Akash Reddy', 'Ananya Gupta', 'Arnav Joshi', 'Bhavya Patel', 'Chirag Malhotra', 'Diya Iyer',
  'Eshan Banerjee', 'Gauri Kulkarni', 'Harsh Agarwal', 'Ishita Rao', 'Jai Chopra', 'Kabir Singh', 'Khushi Desai', 'Lakshya Jain',
  'Meghna Pillai', 'Nikhil Saxena', 'Nisha Menon', 'Om Prakash', 'Pooja Hegde', 'Pranav Bhat', 'Riya Kapoor', 'Rohan Das',
  'Saanvi Mishra', 'Sahil Khanna', 'Sneha Raghavan', 'Tanmay Shetty', 'Tara Bose', 'Uday Kumar', 'Vani Krishnan', 'Varun Nair',
  'Yash Thakur', 'Zara Siddiqui', 'Aniket Pawar', 'Divya Shenoy',
];
const STUDENTS_B = [
  'Abhinav Rao', 'Anjali Sen', 'Dev Malhotra', 'Farah Ali', 'Gaurav Tiwari', 'Isha Bhatt', 'Karan Mehra', 'Lavanya S',
  'Manav Arora', 'Neha Joshi', 'Parth Shah', 'Ritika Jain', 'Siddharth Rao', 'Trisha Paul', 'Vihaan Gupta', 'Ira Kulkarni',
];

const SUBJECTS = [
  { code: 'CS201', name: 'Data Structures', kind: 'lecture', teacher: 'T1' },
  { code: 'CS202', name: 'Database Systems', kind: 'lecture', teacher: 'T2' },
  { code: 'CS203', name: 'Operating Systems', kind: 'lecture', teacher: 'T3' },
  { code: 'CS204', name: 'Computer Networks', kind: 'lecture', teacher: 'T4' },
  { code: 'MA201', name: 'Discrete Mathematics', kind: 'lecture', teacher: 'T3' },
  { code: 'CS201L', name: 'Data Structures Lab', kind: 'lab', teacher: 'T1' },
  { code: 'CS202L', name: 'Database Systems Lab', kind: 'lab', teacher: 'T2' },
] as const;

const ROOMS = [
  { code: 'Room 101', routers: ['0a:1b:2c:10:01', '0a:1b:2c:10:02'] },
  { code: 'Lab 1', routers: ['0a:1b:2c:20:01'] },
  { code: 'Lab 2', routers: ['0a:1b:2c:20:02'] },
  { code: 'Seminar Hall', routers: ['0a:1b:2c:30:01'] },
] as const;

const SLOTS = { S1: ['09:00', '10:00'], S2: ['10:00', '11:00'], S3: ['11:15', '12:15'], S4: ['13:00', '14:00'], S5: ['14:00', '16:00'] } as const;
type Slot = keyof typeof SLOTS;
/** weekday (1 = Monday) → slot → lecture subject, or [batch A1 lab, batch A2 lab]. */
const WEEK: Record<number, Partial<Record<Slot, string | [string, string]>>> = {
  1: { S1: 'CS201', S2: 'CS202', S3: 'CS203', S4: 'CS204', S5: ['CS201L', 'CS202L'] },
  2: { S1: 'CS203', S2: 'MA201', S3: 'CS201', S4: 'CS202', S5: ['CS202L', 'CS201L'] },
  3: { S1: 'CS204', S2: 'CS201', S3: 'MA201', S4: 'CS203' },
  4: { S1: 'CS202', S2: 'CS204', S3: 'CS201', S4: 'MA201', S5: ['CS201L', 'CS202L'] },
  5: { S1: 'MA201', S2: 'CS203', S3: 'CS202', S4: 'CS204' },
};

/** Tables whose rows come from migrations (settings, job bookkeeping): kept on reset. */
const KEEP = new Set(['risk_settings', 'app_settings', 'job_runs']);

/** A small deterministic random generator, so every reset looks alike. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const at = (ctx: AppContext, ms: number): AppContext => ({ ...ctx, now: () => ms });

/** Refuses unless every account in the database is a demo account. */
async function assertDemoDatabase(ctx: AppContext): Promise<void> {
  if (!ctx.config.demo) throw new ApiError(404, 'not_found', 'Not found');
  const other = await ctx.db
    .selectFrom('users')
    .select('email')
    .where('email', 'not like', `%@${DEMO_DOMAIN}`)
    .executeTakeFirst();
  if (other) throw new Error('Refusing to reset: this database has non-demo accounts.');
}

export async function hasDemoData(ctx: AppContext): Promise<boolean> {
  return Boolean(await ctx.db.selectFrom('users').select('id').limit(1).executeTakeFirst());
}

/** Wipes the demo database (keeping settings) and fills it with a fresh sample college. */
export async function resetDemo(ctx: AppContext): Promise<{ students: number; classes: number; attendanceTaken: number }> {
  await assertDemoDatabase(ctx);
  const { rows } = await sql<{ tablename: string }>`
    select tablename from pg_tables
    where schemaname = 'public' and tablename not like 'kysely_%' and tablename not like 'pgboss%'`.execute(ctx.db);
  const list = rows.filter((r) => !KEEP.has(r.tablename)).map((r) => `"${r.tablename}"`).join(', ');
  await sql`
    alter table audit_log disable trigger audit_log_no_truncate;
    ${sql.raw(`truncate ${list} restart identity cascade`)};
    alter table audit_log enable trigger audit_log_no_truncate;
  `.execute(ctx.db);
  return seed(ctx);
}

async function seed(ctx: AppContext) {
  const now = ctx.now();
  const tz = ctx.config.timeZone;
  const today = localDate(now, tz);
  const rand = rng(20261015);
  const db = ctx.db;

  const ids = await db.transaction().execute(async (tx) => {
    const user = async (role: Role, email: string, name: string) => {
      const id = uuidv7();
      await tx.insertInto('users').values({ id, role, email, name }).execute();
      return id;
    };
    const dept = uuidv7();
    await tx.insertInto('departments').values({ id: dept, code: 'CSE', name: 'Computer Science and Engineering' }).execute();
    const prog = uuidv7();
    await tx.insertInto('programs').values({ id: prog, code: 'BTECH-CSE', name: 'B.Tech Computer Science', department_id: dept }).execute();
    const term = uuidv7();
    await tx.insertInto('terms').values({ id: term, name: 'Demo Semester', start_date: addDays(today, -60), end_date: addDays(today, 90) }).execute();
    const secA = uuidv7();
    const secB = uuidv7();
    await tx.insertInto('sections').values([
      { id: secA, term_id: term, program_id: prog, name: 'CSE 2nd Year · Section A' },
      { id: secB, term_id: term, program_id: prog, name: 'CSE 2nd Year · Section B' },
    ]).execute();
    const a1 = uuidv7();
    const a2 = uuidv7();
    await tx.insertInto('section_groups').values([
      { id: a1, section_id: secA, name: 'Batch A1' },
      { id: a2, section_id: secA, name: 'Batch A2' },
    ]).execute();

    for (const role of ['admin', 'acadops', 'community_manager'] as const) await user(role, DEMO_ACCOUNTS[role].email, DEMO_ACCOUNTS[role].name);
    await user('acadops', `acadops2@${DEMO_DOMAIN}`, 'Rajesh Pillai (Academic Operations)');
    const teacher: Record<string, string> = {};
    for (const [i, t] of TEACHERS.entries()) {
      teacher[t.key] = await user('teacher', t.email, t.name);
      await tx.insertInto('teachers').values({ user_id: teacher[t.key]!, faculty_id: `FAC-${101 + i}`, department_id: dept }).execute();
    }
    const students: string[] = [];
    const addStudents = async (names: string[], section: string, prefix: string, batch: (i: number) => string | null) => {
      for (const [i, name] of names.entries()) {
        const local = name.toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '.');
        const id = await user('student', `${local}@${DEMO_DOMAIN}`, name);
        await tx.insertInto('students').values({ user_id: id, usn: `${prefix}${String(i + 1).padStart(3, '0')}`, program_id: prog, section_id: section, group_id: batch(i), admission_year: 2025 }).execute();
        if (section === secA) students.push(id);
      }
    };
    await addStudents(STUDENTS_A, secA, '1DM25CS', (i) => (i < STUDENTS_A.length / 2 ? a1 : a2));
    await addStudents(STUDENTS_B, secB, '1DM25CB', () => null);

    const room: Record<string, string> = {};
    for (const r of ROOMS) {
      room[r.code] = uuidv7();
      await tx.insertInto('rooms').values({ id: room[r.code]!, code: r.code, building: 'Main Block', capacity: r.code.startsWith('Lab') ? 30 : 60, wifi_routers: [...r.routers] }).execute();
    }
    const subject: Record<string, string> = {};
    const offering: Record<string, string> = {};
    for (const s of SUBJECTS) {
      subject[s.code] = uuidv7();
      await tx.insertInto('subjects').values({ id: subject[s.code]!, code: s.code, name: s.name, kind: s.kind }).execute();
      offering[s.code] = uuidv7();
      await tx.insertInto('course_offerings').values({ id: offering[s.code]!, term_id: term, subject_id: subject[s.code]!, section_id: secA }).execute();
      await tx.insertInto('teaching_assignments').values({ id: uuidv7(), teacher_id: teacher[s.teacher]!, offering_id: offering[s.code]! }).execute();
    }
    // Section B has no timetable: "Start a demo class now" adds its classes on demand.
    const offeringB = uuidv7();
    await tx.insertInto('course_offerings').values({ id: offeringB, term_id: term, subject_id: subject.CS201!, section_id: secB }).execute();
    await tx.insertInto('teaching_assignments').values({ id: uuidv7(), teacher_id: teacher.T1!, offering_id: offeringB }).execute();

    const entry = (weekday: number, slot: Slot, code: string, group: string | null) => {
      const s = SUBJECTS.find((x) => x.code === code)!;
      const lab = s.kind === 'lab';
      return {
        id: uuidv7(),
        term_id: term,
        offering_id: offering[code]!,
        group_id: group,
        weekday,
        start_time: `${SLOTS[slot][0]}:00`,
        end_time: `${SLOTS[slot][1]}:00`,
        room_id: room[lab ? (code === 'CS201L' ? 'Lab 1' : 'Lab 2') : 'Room 101']!,
        teacher_id: teacher[s.teacher]!,
        valid_from: null,
        valid_to: null,
        note: null,
      };
    };
    for (const [day, slots] of Object.entries(WEEK)) {
      for (const [slot, v] of Object.entries(slots)) {
        if (Array.isArray(v)) {
          await tx.insertInto('timetable_entries').values([entry(Number(day), slot as Slot, v[0], a1), entry(Number(day), slot as Slot, v[1], a2)]).execute();
        } else if (v) {
          await tx.insertInto('timetable_entries').values(entry(Number(day), slot as Slot, v, null)).execute();
        }
      }
    }
    await syncSectionEnrollments(tx, secA);
    await syncSectionEnrollments(tx, secB);
    await tx
      .insertInto('app_settings')
      .values({ key: 'campus_wifi_ssid_prefix', value: JSON.stringify('CAMPUS') })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify('CAMPUS') }))
      .execute();
    return { term, secA, secB, students, teacher, room, acadops: await idOf(tx, DEMO_ACCOUNTS.acadops.email), cm: await idOf(tx, DEMO_ACCOUNTS.community_manager.email) };
  });

  // Two weeks back and two weeks ahead, through the real materializer.
  for (const ms of [now - 14 * 86_400_000, now]) {
    await db.transaction().execute((tx) => rematerialize(tx, at(ctx, ms), { termId: ids.term, sectionId: ids.secA }));
  }

  // Each student's habits: most attend nearly always, a few often don't.
  const habit = new Map(ids.students.map((s, i) => [s, i % 9 === 4 ? 0.62 : i % 7 === 3 ? 0.78 : 0.9 + rand() * 0.08]));
  const devices = await phonesFor(ctx, ids.students);
  const past = await db
    .selectFrom('class_sessions')
    .select('id')
    .where(sql<boolean>`upper(time_range) < ${new Date(now - 5 * 60_000)}`)
    .where('status', '=', 'scheduled')
    .orderBy(sql`lower(time_range)`)
    .execute();
  for (const { id } of past) {
    const cls = (await loadClass(db, id))!;
    const startMs = cls.starts_at.getTime() + 2 * 60_000;
    const { attendance_session_id: sessionId } = await startAttendance(at(ctx, startMs), id, cls.teacher_id!, '127.0.0.1');
    const expected = await expectedStudents(db, id);
    const scanners = expected.filter((e) => rand() < (habit.get(e.id) ?? 0.9)).map((e) => e.id);
    await addScans(at(ctx, startMs + 60_000), sessionId, scanners, devices, rand, { roomCode: ROOM_OF(cls.room_id, ids.room) });
    await endAttendance(at(ctx, cls.ends_at.getTime() - 60_000), sessionId, { teacherId: cls.teacher_id! }, null);
  }
  // Flags older than three days were already looked at.
  await db
    .updateTable('risk_flags')
    .set({ resolved_by: ids.acadops, resolved_at: new Date(now - 2 * 86_400_000), resolution: 'Checked with the teacher: the student was in class.' })
    .where('created_at', '<', new Date(now - 3 * 86_400_000))
    .execute();

  await requestsAndNotices(ctx, ids, today);
  const classes = await db.selectFrom('class_sessions').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
  return { students: STUDENTS_A.length + STUDENTS_B.length, classes: Number(classes.n), attendanceTaken: past.length };
}

const ROOM_OF = (roomId: string | null, rooms: Record<string, string>) => Object.entries(rooms).find(([, id]) => id === roomId)?.[0] ?? 'Room 101';

async function idOf(tx: Tx, email: string): Promise<string> {
  return (await tx.selectFrom('users').select('id').where('email', '=', email).executeTakeFirstOrThrow()).id;
}

/** A registered phone per student (made up: there are no real phones in the demo). */
async function phonesFor(ctx: AppContext, students: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const models = ['Pixel 7a', 'Galaxy A54', 'Redmi Note 13', 'OnePlus Nord CE 3', 'iPhone 13', 'Galaxy M34', 'Nothing Phone (2a)'];
  const when = new Date(ctx.now() - 50 * 86_400_000);
  const rows = students.map((s, i): Insertable<Database['devices']> => {
    const id = uuidv7();
    const ios = models[i % models.length]!.startsWith('iPhone');
    map.set(s, id);
    return {
        id,
        user_id: s,
        state: 'active',
        platform: ios ? 'ios' : 'android',
        model: models[i % models.length]!,
        os_version: ios ? '18.6' : '15',
        app_version: '0.0.9',
        session_key_spki: `demo-${randomBytes(12).toString('hex')}`,
        attempt_key_spki: `demo-${randomBytes(12).toString('hex')}`,
        attestation_level: ios ? 'app_attest' : 'tee',
        biometric_only: true,
        bound_at: when,
        activated_at: when,
      };
  });
  if (rows.length > 0) await ctx.db.insertInto('devices').values(rows).execute();
  return map;
}

/**
 * Scans by the given students in the session's open round, shaped like real ones: most
 * verified, a few flagged (another room's Wi-Fi, poor indoor location), the odd one flagged
 * high (fake GPS). Also used by "Simulate scans" on the live page.
 */
export async function addScans(
  ctx: AppContext,
  sessionId: string,
  studentIds: string[],
  devices: Map<string, string>,
  rand: () => number,
  opts: { roomCode: string },
): Promise<number> {
  if (studentIds.length === 0) return 0;
  const round = await ctx.db.selectFrom('attendance_rounds').select(['id', 'round_no']).where('session_id', '=', sessionId).where('closed_at', 'is', null).orderBy('round_no', 'desc').executeTakeFirst();
  const session = await ctx.db.selectFrom('attendance_sessions').select(['class_session_id', 't0_ms', 'epoch_ms']).where('id', '=', sessionId).executeTakeFirstOrThrow();
  if (!round) return 0;
  const already = new Set(
    (await ctx.db.selectFrom('attendance_attempts').select('student_id').where('round_id', '=', round.id).where('decision', '<>', 'rejected').execute()).map((r) => r.student_id),
  );
  const attempts: Insertable<Database['attendance_attempts']>[] = [];
  const records: Insertable<Database['attendance_records']>[] = [];
  const flags: Insertable<Database['risk_flags']>[] = [];
  for (const [i, studentId] of studentIds.entries()) {
    const deviceId = devices.get(studentId);
    if (!deviceId || already.has(studentId)) continue;
    const t = ctx.now() + i * 1_500;
    const r = rand();
    let decision: AttemptDecision = 'verified';
    let reasons: string[] = [];
    let score = Math.floor(rand() * 8);
    const signals: AttemptSignals = { location: 'inside', accuracy_m: 8 + Math.floor(rand() * 25), distance_m: 0, is_mock: false, campus_network: true, wifi: 'room', wifi_room: opts.roomCode, attestation: 'ok', app_version: '0.0.9' };
    if (r < 0.012) {
      decision = 'flagged_high';
      reasons = ['location_mock', 'wifi_not_campus'];
      score = 75;
      Object.assign(signals, { is_mock: true, wifi: 'not_campus', wifi_room: null, campus_network: false });
    } else if (r < 0.04) {
      decision = 'flagged';
      reasons = ['wifi_other_room'];
      score = 35;
      Object.assign(signals, { wifi: 'other_room', wifi_room: opts.roomCode === 'Room 101' ? 'Seminar Hall' : 'Room 101' });
    } else if (r < 0.06) {
      decision = 'flagged';
      reasons = ['location_poor_accuracy'];
      score = 30;
      Object.assign(signals, { location: 'unknown', accuracy_m: 140 });
    }
    const id = uuidv7(t);
    attempts.push({
      id,
      session_id: sessionId,
      round_id: round.id,
      student_id: studentId,
      device_id: deviceId,
      received_at: new Date(t),
      device_time: new Date(t - 300),
      qr_round: round.round_no,
      qr_epoch: Math.floor((t - Number(session.t0_ms)) / session.epoch_ms),
      nonce: randomBytes(16).toString('base64url'),
      decision,
      reason_codes: reasons,
      risk_score: score,
      signals: JSON.stringify(signals),
      payload_sha256: randomBytes(32).toString('hex'),
    });
    const status: RecordStatus = round.round_no > 1 ? 'late' : 'present';
    records.push({ student_id: studentId, class_session_id: session.class_session_id, attendance_session_id: sessionId, status, basis: 'system' as const, final_attempt_id: id });
    if (decision === 'flagged_high') {
      flags.push({ id: uuidv7(t), student_id: studentId, session_id: sessionId, attempt_id: id, type: 'flagged_high', severity: 'high' as const, details: JSON.stringify({ reasons, score }) });
    }
  }
  if (attempts.length === 0) return 0;
  await ctx.db.transaction().execute(async (tx) => {
    await tx.insertInto('attendance_attempts').values(attempts).execute();
    await tx.insertInto('attendance_records').values(records).onConflict((oc) => oc.columns(['student_id', 'class_session_id']).doNothing()).execute();
    if (flags.length > 0) await tx.insertInto('risk_flags').values(flags).execute();
  });
  ctx.events.publish({ type: 'attempt', sessionId });
  return attempts.length;
}

/** Devices of these students, for simulated scans. */
export async function demoDevices(ctx: AppContext, studentIds: string[]): Promise<Map<string, string>> {
  if (studentIds.length === 0) return new Map();
  const rows = await ctx.db.selectFrom('devices').select(['id', 'user_id']).where('user_id', 'in', studentIds).where('state', '=', 'active').execute();
  return new Map(rows.map((r) => [r.user_id, r.id]));
}

async function requestsAndNotices(ctx: AppContext, ids: { secA: string; students: string[]; acadops: string; cm: string; teacher: Record<string, string> }, today: string) {
  const db = ctx.db;
  const [s1, s2, s3, s4, s5] = ids.students as [string, string, string, string, string];
  const upcoming = await db
    .selectFrom('class_sessions')
    .select(['id', 'date'])
    .where('date', '>', today)
    .where('group_id', 'is', null)
    .orderBy(sql`lower(time_range)`)
    .limit(4)
    .execute();
  const nextDay = upcoming[0]?.date ?? addDays(today, 1);
  const day2 = addDays(nextDay, 1);
  const ago = (days: number) => new Date(ctx.now() - days * 86_400_000);
  await db.insertInto('od_requests').values([
    { id: uuidv7(), student_id: s1, kind: 'days', dates: [nextDay, day2], event: 'Inter-college hackathon (Smart India Hackathon regional round)', reason: 'Representing the college with the coding club team.', status: 'pending_cm' },
    { id: uuidv7(), student_id: s2, kind: 'classes', class_session_ids: upcoming.slice(1, 3).map((c) => c.id), event: 'Cultural fest volunteering', reason: 'Stage management for the annual fest rehearsal.', status: 'pending_ops', cm_id: ids.cm, cm_decided_at: ago(1), cm_note: 'On the volunteer list.' },
    { id: uuidv7(), student_id: s3, kind: 'days', dates: [day2], event: 'State-level basketball tournament', reason: 'Selected for the college team.', status: 'approved', cm_id: ids.cm, cm_decided_at: ago(3), cm_note: 'Confirmed with the sports office.', ops_id: ids.acadops, ops_decided_at: ago(2), ops_note: 'Approved.' },
  ]).execute();

  // A student who says they were marked absent by mistake, waiting for the teacher.
  const missed = await db
    .selectFrom('attendance_records as r')
    .innerJoin('class_sessions as c', 'c.id', 'r.class_session_id')
    .select('c.id')
    .where('r.student_id', '=', s4)
    .where('r.status', '=', 'absent')
    .where('c.teacher_id', '=', ids.teacher.T1!)
    .orderBy('c.date', 'desc')
    .executeTakeFirst();
  if (missed) {
    await db.insertInto('attendance_issues').values({ id: uuidv7(), student_id: s4, class_session_id: missed.id, reason: 'marked_absent_but_present', note: 'My phone battery died before I could scan. I was in the second row; my lab partner can confirm.' }).execute();
  }
  void s5;

  await db.transaction().execute(async (tx) => {
    await postNotice(tx, ctx, {
      kind: 'announcement',
      title: 'Welcome to Argus',
      body: 'Attendance is now marked with the Argus app: scan the code on the classroom screen with your registered phone. Register your phone before your first class.',
      audience: { kind: 'students' },
      label: 'All students',
      recipients: ids.students,
      createdBy: ids.acadops,
    });
    await postNotice(tx, ctx, {
      kind: 'announcement',
      title: 'Mid-semester exams next month',
      body: 'The exam timetable will be shared next week. Classes continue as usual until then.',
      audience: { kind: 'section', section_id: ids.secA, group_id: null },
      label: 'CSE 2nd Year · Section A',
      recipients: ids.students,
      createdBy: ids.acadops,
    });
  });
}

/**
 * "Start a demo class now": the teacher's class on now if there is one, otherwise a
 * 50-minute Data Structures class for Section B starting this minute in the Seminar Hall.
 */
export async function demoClassNow(ctx: AppContext, teacherId: string): Promise<string> {
  if (!ctx.config.demo) throw new ApiError(404, 'not_found', 'Not found');
  const now = new Date(ctx.now());
  const current = await ctx.db
    .selectFrom('class_sessions')
    .select('id')
    .where('teacher_id', '=', teacherId)
    .where('status', 'in', ['scheduled', 'in_progress'])
    .where(sql<boolean>`time_range @> ${now}::timestamptz`)
    .executeTakeFirst();
  if (current) return current.id;
  const off = await ctx.db
    .selectFrom('course_offerings as o')
    .innerJoin('sections as s', 's.id', 'o.section_id')
    .innerJoin('teaching_assignments as ta', 'ta.offering_id', 'o.id')
    .select(['o.id', 'o.term_id', 'o.section_id'])
    .where('s.name', 'like', '%Section B')
    .where('ta.teacher_id', '=', teacherId)
    .executeTakeFirst();
  const room = await ctx.db.selectFrom('rooms').select('id').where('code', '=', 'Seminar Hall').executeTakeFirst();
  if (!off || !room) throw new ApiError(409, 'demo_not_ready', 'The demo data is being reset. Try again in a minute.');
  const tz = ctx.config.timeZone;
  const hhmm = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
  const start = hhmm(now.getTime());
  const end = hhmm(now.getTime() + 50 * 60_000);
  if (end <= start) throw new ApiError(409, 'too_late', 'Demo classes can be added until 11 pm. Try again tomorrow morning.');
  const date = localDate(now.getTime(), tz);
  await ctx.db.transaction().execute(async (tx) => {
    // Clear Section B's earlier demo classes today so the new one fits.
    await tx.updateTable('timetable_overrides').set({ revoked_at: now }).where('term_id', '=', off.term_id).where('date', '=', date).where('new_offering_id', '=', off.id).where('revoked_at', 'is', null).execute();
    await tx
      .insertInto('timetable_overrides')
      .values({ id: uuidv7(), term_id: off.term_id, date, entry_id: null, action: 'add', new_offering_id: off.id, new_group_id: null, new_room_id: room.id, new_teacher_id: teacherId, new_start: `${start}:00`, new_end: `${end}:00`, reason: 'Demo class', created_by: teacherId })
      .execute();
    await rematerialize(tx, ctx, { termId: off.term_id, sectionId: off.section_id });
  });
  const made = await ctx.db
    .selectFrom('class_sessions')
    .select('id')
    .where('teacher_id', '=', teacherId)
    .where('status', '=', 'scheduled')
    .where(sql<boolean>`time_range @> ${now}::timestamptz`)
    .executeTakeFirst();
  if (!made) throw new ApiError(409, 'demo_class_failed', 'Could not add a demo class right now. Try again in a minute.');
  return made.id;
}
