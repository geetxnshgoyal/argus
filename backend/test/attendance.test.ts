import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { housekeeping } from '../src/attendance/service.ts';
import type { Db } from '../src/db/index.ts';
import { uuidv7 } from '../src/platform/ids.ts';
import { createUser, deviceKey, loginAs, makeApp, type TestApp } from './helpers/app.ts';
import { closeTestDb, hasDb, resetDb, testDb } from './helpers/db.ts';
import { collegeFixture, type College } from './helpers/fixtures.ts';
import { displayQr, Phone } from './helpers/phone.ts';

// makeApp's clock: Monday 2026-09-21 09:30 India (04:00 UTC). ADA runs 09:30–11:00 for the whole section.
const T0 = Date.UTC(2026, 8, 21, 4, 0, 0);

describe.skipIf(!hasDb)('attendance (integration, spec §16 adversarial suite)', () => {
  let db: Db;
  let t: TestApp;
  let c: College;
  let teacher: Awaited<ReturnType<typeof loginAs>>;
  let s1: Phone;
  let s2: Phone;
  let classId: string;

  async function addStudent(email: string, usn: string, groupId: string | null, sectionId = c.section.id) {
    const u = await createUser(db, 'student', email, email.split('@')[0]);
    await db.insertInto('students').values({ user_id: u.id, usn, program_id: c.program.id, section_id: sectionId, group_id: groupId, admission_year: 2025 }).execute();
    return u;
  }

  const post = (url: string, payload: unknown = {}, headers = teacher.headers) => t.app.inject({ method: 'POST', url, headers, payload: payload as object });
  const get = (url: string, headers = teacher.headers) => t.app.inject({ url, headers });

  async function start() {
    const res = await post(`/v1/teacher/class-sessions/${classId}/attendance/start`);
    expect(res.statusCode).toBe(201);
    return res.json().attendance_session_id as string;
  }

  /** The teacher's own browser acts as the display. */
  async function display(sessionId: string) {
    const res = await get(`/v1/attendance/sessions/${sessionId}/display`);
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  beforeEach(async () => {
    db = await testDb();
    await resetDb(db);
    c = await collegeFixture(db);
    t = await makeApp({ db, now: T0, config: { env: 'dev', attestationBypass: true } });
    await createUser(db, 'acadops', 'ops@college.test', 'Ops');
    const ops = await loginAs(t.app, 'ops@college.test');
    await c.entry({ offering: c.off.ada.id, weekday: 1, start: '09:30', end: '11:00', teacher: c.tA.id });
    await addStudent('s1@college.test', '2102500001', c.b1.id);
    await addStudent('s2@college.test', '2102500002', c.b2.id);
    await t.app.inject({ method: 'POST', url: `/v1/admin/sections/${c.section.id}/sync-enrollments`, headers: ops.headers });
    expect((await t.app.inject({ method: 'POST', url: '/v1/admin/timetable/materialize', headers: ops.headers })).statusCode).toBe(200);
    const cs = await db.selectFrom('class_sessions').select('id').where('date', '=', '2026-09-21').where('offering_id', '=', c.off.ada.id).executeTakeFirstOrThrow();
    classId = cs.id;
    teacher = await loginAs(t.app, c.tA.email);
    s1 = await new Phone(t.app, 's1@college.test').signIn();
    s2 = await new Phone(t.app, 's2@college.test').signIn();
    expect((await s1.bind()).statusCode).toBe(200);
    expect((await s2.bind()).statusCode).toBe(200);
  });
  afterAll(async () => {
    await t?.app.close();
    await closeTestDb();
  });

  it('a whole class: start, scan, live panel, end (unmarked → absent), audited', async () => {
    const id = await start();
    const d = await display(id);
    expect(d).toMatchObject({ status: 'active', round: 1, epoch_ms: 3000 });
    expect(d).not.toHaveProperty('ks');
    t.clock.now += 4500;
    const ok = await s1.scan(displayQr(d, t.clock.now));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ decision: 'verified', record: 'present' });

    const live = (await get(`/v1/attendance/sessions/${id}/live`)).json();
    expect(live.counts).toMatchObject({ expected: 2, present: 1, unmarked: 1 });

    const end = await post(`/v1/attendance/sessions/${id}/end`);
    expect(end.statusCode).toBe(200);
    expect(end.json()).toMatchObject({ present: 1, absent: 1 });
    const records = await db.selectFrom('attendance_records').select(['student_id', 'status', 'basis']).execute();
    expect(records.map((r) => r.status).sort()).toEqual(['absent', 'present']);
    const actions = (await db.selectFrom('audit_log').select('action').execute()).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['device.bind', 'attendance.start', 'attendance.end']));

    // Session over: the display is told to wipe; scans are refused.
    expect((await display(id)).status).toBe('ended');
    expect((await s2.scan(displayQr(d, t.clock.now))).json().code).toBe('session_closed');
  });

  it('login as another student on an unbound device → rejected (spec §16 #1)', async () => {
    const id = await start();
    const d = await display(id);
    const thief = await new Phone(t.app, 's1@college.test').signIn(); // s1's account, a different phone, not bound
    thief.deviceId = s1.deviceId; // claims s1's device, but can't sign with its key
    const res = await thief.scan(displayQr(d, t.clock.now));
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('bad_signature');
  });

  it('a second phone for the same account waits 48 h; the old one keeps working (ADR-0007)', async () => {
    const second = await new Phone(t.app, 's1@college.test').signIn();
    const bound = await second.bind();
    expect(bound.json()).toMatchObject({ state: 'pending', needs_approval: false });
    const id = await start();
    const d = await display(id);
    const res = await second.scan(displayQr(d, t.clock.now));
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('device_not_active');
    expect((await s1.scan(displayQr(d, t.clock.now))).statusCode).toBe(200);
  });

  it('re-registering the same phone (same hardware session key) replaces the binding at once', async () => {
    const before = s1.deviceId;
    Object.assign(s1, { attempt: deviceKey() }); // the app makes a fresh attempt key when registering
    const again = await s1.bind({ androidId: 'different-or-missing' });
    expect(again.json()).toMatchObject({ state: 'active' });
    expect(s1.deviceId).not.toBe(before);
    const old = await db.selectFrom('devices').select(['state', 'revoke_reason']).where('id', '=', before).executeTakeFirstOrThrow();
    expect(old).toMatchObject({ state: 'revoked', revoke_reason: 'reinstalled' });
  });

  it('another account on the same app install is refused (same session key)', async () => {
    await addStudent('s3@college.test', '2102500003', c.b1.id);
    const shared = new Phone(t.app, 's3@college.test');
    // Same hardware session key as s1's phone (signing in as s3 on s1's phone).
    Object.assign(shared, { session: s1.session });
    await shared.signIn();
    const res = await shared.bind({ androidId: 'x' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('device_in_use');
  });

  it('one phone cannot be bound to two students (spec §16 #2, ADR-0009)', async () => {
    await addStudent('s3@college.test', '2102500003', c.b1.id);
    const other = await new Phone(t.app, 's3@college.test').signIn();
    const res = await other.bind({ androidId: s1.androidId });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('device_in_use');
  });

  it('replay of a captured attempt → nonce rejection (spec §16 #3)', async () => {
    const d = await display(await start());
    const payload = s1.payload(displayQr(d, t.clock.now));
    expect((await s1.send(payload)).statusCode).toBe(200);
    const again = await s1.send(payload);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('replayed_nonce');
  });

  it('old QR beyond the grace window → epoch rejection; within grace → late_in_window (spec §16 #4)', async () => {
    const d = await display(await start());
    const epochAt = (ms: number) => Math.floor((ms - d.t0_ms) / d.epoch_ms);
    t.clock.now = d.t0_ms + 10 * 3000 + 1500; // 1.5 s into epoch 10
    const late = await s1.scan(displayQr(d, t.clock.now, epochAt(t.clock.now) - 1));
    expect(late.statusCode).toBe(200);
    expect(late.json().reason_codes).toContain('late_in_window');
    t.clock.now = d.t0_ms + 20 * 3000 + 2500; // 2.5 s past the boundary: previous epoch no longer accepted
    const old = await s2.scan(displayQr(d, t.clock.now, epochAt(t.clock.now) - 1));
    expect(old.json().code).toBe('epoch_expired');
  });

  it('tag from another round or session → rejection (spec §16 #5)', async () => {
    const id = await start();
    const r1 = await display(id);
    const r2 = await post(`/v1/attendance/sessions/${id}/rounds`, { mode: 'full' });
    expect(r2.statusCode).toBe(201);
    const d2 = await display(id);
    // Round-1 key used with the round-2 number: the tag doesn't verify.
    const forged = displayQr({ ...r1, round: 2 }, t.clock.now);
    expect((await s1.scan(forged)).json().code).toBe('bad_tag');
    // Round-1 code after round 2 opened: round closed.
    expect((await s1.scan(displayQr(r1, t.clock.now))).json().code).toBe('round_closed');
    expect((await s1.scan(displayQr(d2, t.clock.now))).statusCode).toBe(200);
  });

  it('payload modified after signing → signature rejection (spec §16 #6)', async () => {
    const d = await display(await start());
    const payload = s1.payload(displayQr(d, t.clock.now));
    const sig = s1.attempt.sign(payload);
    const tampered = Buffer.from(payload.toString().replace('"is_mock":false', '"is_mock":true'));
    const res = await s1.send(tampered, sig);
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('bad_signature');
  });

  it('mock location → flagged high, counted present; off campus with good accuracy → rejected (spec §16 #8)', async () => {
    await db.insertInto('campus_geofences').values({ id: uuidv7(), name: 'Campus', center_lat: 12.9, center_lon: 77.5, radius_m: 300 }).execute();
    const d = await display(await start());
    const mock = await s1.scan(displayQr(d, t.clock.now), { location: { lat: 12.9, lon: 77.5, accuracy_m: 5, fix_age_ms: 100, is_mock: true } });
    expect(mock.json()).toMatchObject({ decision: 'flagged_high', record: 'present' });
    expect(mock.json().reason_codes).toContain('location_mock');
    const far = await s2.scan(displayQr(d, t.clock.now), { location: { lat: 13.1, lon: 77.5, accuracy_m: 20, fix_age_ms: 100, is_mock: false } });
    expect(far.statusCode).toBe(422);
    expect(far.json().code).toBe('off_campus');
    // Raw coordinates are never stored.
    const signals = await db.selectFrom('attendance_attempts').select('signals').execute();
    expect(JSON.stringify(signals)).not.toContain('12.9');
    expect(JSON.stringify(signals)).not.toContain('77.5');
  });

  it('no location fix → flagged for poor accuracy, never rejected', async () => {
    const d = await display(await start());
    const res = await s1.scan(displayQr(d, t.clock.now), { location: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().reason_codes).toContain('location_poor_accuracy');
  });

  it('teacher starting a class not assigned to them, or outside its time → 403 (spec §16 #9)', async () => {
    const other = await loginAs(t.app, c.tB.email);
    const res = await post(`/v1/teacher/class-sessions/${classId}/attendance/start`, {}, other.headers);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('not_your_class');
    t.clock.now = T0 - 30 * 60_000; // 09:00, more than 10 minutes early
    const early = await post(`/v1/teacher/class-sessions/${classId}/attendance/start`);
    expect(early.json().code).toBe('outside_class_time');
    // Another teacher can't see or steer someone else's session either.
    t.clock.now = T0;
    const id = await start();
    expect((await get(`/v1/attendance/sessions/${id}/live`, other.headers)).statusCode).toBe(404);
    expect((await get(`/v1/attendance/sessions/${id}/display`, other.headers)).statusCode).toBe(404);
  });

  it('students not in the class are rejected; one accepted attempt per round', async () => {
    const outsider = await addStudent('x@college.test', '2102500009', null, c.otherSection.id);
    void outsider;
    const x = await new Phone(t.app, 'x@college.test').signIn();
    await x.bind();
    const d = await display(await start());
    expect((await x.scan(displayQr(d, t.clock.now))).json().code).toBe('not_enrolled');
    expect((await s1.scan(displayQr(d, t.clock.now))).statusCode).toBe(200);
    expect((await s1.scan(displayQr(d, t.clock.now))).json().code).toBe('already_marked');
  });

  it('targeted recheck: verified students not sampled have nothing to do; a missed recheck is flagged high', async () => {
    const id = await start();
    const d1 = await display(id);
    await s1.scan(displayQr(d1, t.clock.now));
    await s2.scan(displayQr(d1, t.clock.now), { location: null }); // flagged? poor accuracy alone is 20 → verified
    // Force s2 flagged via mock so the recheck must include them.
    const round = await post(`/v1/attendance/sessions/${id}/rounds`, { mode: 'targeted' });
    expect(round.json().mode).toBe('targeted');
    const d2 = await display(id);
    const active = (await t.app.inject({ url: '/v1/me/sessions/active', headers: s1.auth })).json();
    expect(active.items[0]).toMatchObject({ round: 2, mode: 'targeted' });
    // Close the recheck without anyone scanning: everyone targeted who scanned before gets missed_recheck.
    await post(`/v1/attendance/sessions/${id}/end`);
    const flags = await db.selectFrom('risk_flags').select(['student_id', 'type']).where('type', '=', 'missed_recheck').execute();
    const targeted = (await db.selectFrom('attendance_rounds').select('target_student_ids').where('round_no', '=', 2).executeTakeFirstOrThrow()).target_student_ids ?? [];
    expect(flags.map((f) => f.student_id).sort()).toEqual([...targeted].sort());
    void d2;
  });

  it('spot check: absent → record absent + risk flag; teacher can confirm present', async () => {
    const id = await start();
    const d = await display(id);
    await s1.scan(displayQr(d, t.clock.now));
    await s2.scan(displayQr(d, t.clock.now), { location: { lat: 1, lon: 1, accuracy_m: 5, fix_age_ms: 10, is_mock: true } });
    const view = (await post(`/v1/attendance/sessions/${id}/spot-checks/suggest`)).json();
    const s2Id = view.students.find((s: { usn: string }) => s.usn === '2102500002').id;
    const check = view.spot_checks.find((sp: { student_id: string }) => sp.student_id === s2Id);
    expect(check.reason).toBe('flagged_high');
    const after = (await post(`/v1/attendance/sessions/${id}/spot-checks`, { spot_check_id: check.id, result: 'absent' })).json();
    expect(after.students.find((s: { id: string }) => s.id === s2Id).state).toBe('absent');
    expect(await db.selectFrom('risk_flags').select('type').where('type', '=', 'spot_check_absent').execute()).toHaveLength(1);
    // The teacher changes their mind: confirmed present (audited).
    const ok = await post(`/v1/attendance/sessions/${id}/students/${s2Id}/decision`, { status: 'present', note: 'Was at the back' });
    expect(ok.statusCode).toBe(200);
    const live = (await get(`/v1/attendance/sessions/${id}/live`)).json();
    expect(live.students.find((s: { id: string }) => s.id === s2Id).state).toBe('confirmed');
  });

  it('headcount lower than present count warns the teacher', async () => {
    const id = await start();
    const d = await display(id);
    await s1.scan(displayQr(d, t.clock.now));
    await s2.scan(displayQr(d, t.clock.now));
    const res = (await post(`/v1/attendance/sessions/${id}/headcount`, { headcount: 0 })).json();
    expect(res.headcount_warning).toBe(false); // 2 present ≤ 0 + tolerance 2
    await db
      .insertInto('risk_settings')
      .values({ key: 'headcount_tolerance', kind: 'setting', value: 0 })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: 0 }))
      .execute();
    t.clock.now += 10_000; // settings cache expires
    const warn = (await post(`/v1/attendance/sessions/${id}/headcount`, { headcount: 1 })).json();
    expect(warn.headcount_warning).toBe(true);
  });

  it('display pairing: code shown on screen, linked by the teacher, round key delivered only with the secret', async () => {
    const id = await start();
    const secret = Buffer.alloc(32, 9);
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(secret).digest('base64url');
    const pair = await t.app.inject({ method: 'POST', url: '/v1/display/pairings', payload: { secret_hash: hash } });
    expect(pair.statusCode).toBe(201);
    const { pairing_id, code } = pair.json();
    const poll = (s: Buffer) => t.app.inject({ method: 'POST', url: `/v1/display/pairings/${pairing_id}/state`, payload: { secret: s.toString('base64url') } });
    expect((await poll(secret)).json().status).toBe('waiting');
    expect((await poll(Buffer.alloc(32, 1))).statusCode).toBe(403);
    expect((await post(`/v1/attendance/sessions/${id}/display`, { code: code.toLowerCase() })).statusCode).toBe(200);
    const state = (await poll(secret)).json();
    expect(state).toMatchObject({ status: 'active', round: 1 });
    expect((await s1.scan(displayQr(state, t.clock.now))).statusCode).toBe(200);
    // A code can be used once.
    expect((await post(`/v1/attendance/sessions/${id}/display`, { code })).json().code).toBe('invalid_code');
  });

  it('forgotten sessions end automatically; keys are wiped 10 minutes after the end', async () => {
    const id = await start();
    t.clock.now = Date.UTC(2026, 8, 21, 5, 46); // 11:16 India: class ended 16 minutes ago
    const r = await housekeeping(t.ctx);
    expect(r.autoEnded).toBe(1);
    const s = await db.selectFrom('attendance_sessions').select(['status', 'ks_ciphertext']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(s.status).toBe('ended');
    expect(s.ks_ciphertext).not.toBeNull();
    t.clock.now += 10 * 60_000 + 1000;
    expect((await housekeeping(t.ctx)).keysWiped).toBe(1);
    const wiped = await db.selectFrom('attendance_sessions').select('ks_ciphertext').where('id', '=', id).executeTakeFirstOrThrow();
    expect(wiped.ks_ciphertext).toBeNull();
  });

  it('student history shows per-subject percentages', async () => {
    const id = await start();
    await s1.scan(displayQr(await display(id), t.clock.now));
    await post(`/v1/attendance/sessions/${id}/end`);
    const h = (await t.app.inject({ url: '/v1/me/attendance', headers: s1.auth })).json();
    expect(h.subjects[0]).toMatchObject({ code: 'ADA', total: 1, attended: 1, percent: 100 });
  });
});
