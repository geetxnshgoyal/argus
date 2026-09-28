import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.ts';
import type { Db } from '../src/db/index.ts';
import { uuidv7 } from '../src/platform/ids.ts';
import { createUser, loginAs, makeApp, type TestApp } from './helpers/app.ts';
import { closeTestDb, hasDb, resetDb, testDb } from './helpers/db.ts';
import { collegeFixture, type College } from './helpers/fixtures.ts';
import { displayQr, Phone } from './helpers/phone.ts';
import { androidChain, ecKey } from './helpers/x509.ts';

/**
 * Attacker clients against production-like pilot settings (ADR-0021, ADR-0024):
 * a script with software keys (no phone, no Argus app) that has the student's
 * sign-in. Spec §16 #7, plus the pilot-mode gap found in the M7 review.
 */
const T0 = Date.UTC(2026, 8, 21, 4, 0, 0); // Monday 09:30 India; ADA runs 09:30–11:00

const pilot = (over: Partial<Config> = {}): Partial<Config> => ({
  env: 'production',
  attestationBypass: false,
  attestation: {
    android: { packageName: 'app.argus.argus', signingCertDigests: ['ab'.repeat(32)], playIntegrityCredentialsPath: undefined, playIntegrityMode: 'off' },
    ios: { appId: undefined, environment: 'development', attestMode: 'off', deviceCheckKeyId: undefined, deviceCheckKeyPath: undefined },
  },
  ...over,
});

describe.skipIf(!hasDb)('scripted attacker clients (pilot settings)', () => {
  let db: Db;
  let t: TestApp;
  let c: College;
  let classId: string;

  async function student(email: string, usn: string) {
    const u = await createUser(db, 'student', email, email.split('@')[0]);
    await db.insertInto('students').values({ user_id: u.id, usn, program_id: c.program.id, section_id: c.section.id, group_id: c.b1.id, admission_year: 2025 }).execute();
  }

  beforeEach(async () => {
    db = await testDb();
    await resetDb(db);
    c = await collegeFixture(db);
    t = await makeApp({ db, now: T0, config: pilot() });
    await createUser(db, 'acadops', 'ops@college.test', 'Ops');
    const ops = await loginAs(t.app, 'ops@college.test');
    await c.entry({ offering: c.off.ada.id, weekday: 1, start: '09:30', end: '11:00', teacher: c.tA.id });
    await db.insertInto('campus_geofences').values({ id: uuidv7(), name: 'Campus', center_lat: 12.9, center_lon: 77.5, radius_m: 300 }).execute();
    await student('bot@college.test', '2102500001');
    await t.app.inject({ method: 'POST', url: `/v1/admin/sections/${c.section.id}/sync-enrollments`, headers: ops.headers });
    await t.app.inject({ method: 'POST', url: '/v1/admin/timetable/materialize', headers: ops.headers });
    classId = (await db.selectFrom('class_sessions').select('id').where('offering_id', '=', c.off.ada.id).executeTakeFirstOrThrow()).id;
  });
  afterAll(async () => {
    await t?.app.close();
    await closeTestDb();
  });

  async function liveQr() {
    const teacher = await loginAs(t.app, c.tA.email);
    const start = await t.app.inject({ method: 'POST', url: `/v1/teacher/class-sessions/${classId}/attendance/start`, headers: teacher.headers });
    const d = await t.app.inject({ url: `/v1/attendance/sessions/${start.json().attendance_session_id}/display`, headers: teacher.headers });
    return displayQr(d.json(), t.clock.now);
  }

  it('Android pilot: a script cannot register (no dev bypass, no Google-rooted hardware key)', async () => {
    const bot = await new Phone(t.app, 'bot@college.test').signIn();
    expect((await bot.bind()).json()).toMatchObject({ code: 'attestation_failed' }); // dev_bypass
    const fake = androidChain({ challenge: randomBytes(32), leafKey: ecKey(), now: new Date(T0) }); // self-made "Google" chain
    const res = await bot.bind({ evidence: { kind: 'android', attempt_key_chain: fake.chain } });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/could not be verified/);
    expect(await db.selectFrom('devices').select('id').execute()).toHaveLength(0);
  });

  it('iPhone pilot: a script posing as an iPhone waits for Acad Ops and cannot scan until approved', async () => {
    const bot = await new Phone(t.app, 'bot@college.test').signIn();
    const bound = await bot.bind({ platform: 'ios', evidence: { kind: 'ios_unattested', error: 'unsupported' } });
    expect(bound.statusCode).toBe(200);
    expect(bound.json()).toMatchObject({ state: 'pending', needs_approval: true });

    // Relayed code + faked campus location, sent from anywhere: refused, the phone is not active.
    const qr = await liveQr();
    const scan = await bot.scan(qr, { location: { lat: 12.9, lon: 77.5, accuracy_m: 5, fix_age_ms: 100, is_mock: false } });
    expect(scan.statusCode).toBe(403);
    expect(scan.json().code).toBe('device_not_active');
  });

  it('iPhone pilot: once approved, every scan from the unverified phone is flagged for spot checks', async () => {
    const phone = await new Phone(t.app, 'bot@college.test').signIn();
    await phone.bind({ platform: 'ios', evidence: { kind: 'ios_unattested' } });
    const ops = await loginAs(t.app, 'ops@college.test');
    const req = await db.selectFrom('device_rebind_requests').select('id').executeTakeFirstOrThrow();
    const approve = await t.app.inject({ method: 'POST', url: `/v1/admin/rebind-requests/${req.id}/approve`, headers: ops.headers, payload: { note: 'Saw the phone and ID card' } });
    expect(approve.statusCode).toBe(200);

    const scan = await phone.scan(await liveQr());
    expect(scan.statusCode).toBe(200);
    expect(scan.json()).toMatchObject({ decision: 'flagged', record: 'present' });
    expect(scan.json().reason_codes).toContain('phone_unverified');
  });

  it('with iPhone pilot mode off, unverified iPhones are refused outright', async () => {
    await t.app.close();
    t = await makeApp({ db, now: T0, config: pilot({ attestation: { ...pilot().attestation!, ios: { ...pilot().attestation!.ios, attestMode: 'required', appId: 'TEAM123456.app.argus.argus' } } }) });
    const bot = await new Phone(t.app, 'bot@college.test').signIn();
    const res = await bot.bind({ platform: 'ios', evidence: { kind: 'ios_unattested' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('attestation_failed');
  });
});
