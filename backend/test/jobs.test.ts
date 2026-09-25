import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AttestationService } from '../src/devices/attestation/index.ts';
import type { Db } from '../src/db/index.ts';
import { runDueJobs } from '../src/jobs.ts';
import { makeApp, testConfig, logSink, type TestApp } from './helpers/app.ts';
import { closeTestDb, hasDb, resetDb, testDb } from './helpers/db.ts';

// 2026-09-21 09:30 India.
const T0 = Date.UTC(2026, 8, 21, 4, 0, 0);

describe.skipIf(!hasDb)('background jobs without a daemon (ADR-0020)', () => {
  let db: Db;
  let t: TestApp;

  beforeEach(async () => {
    db = await testDb();
    await resetDb(db);
    // resetDb empties job_runs too; the migration seeds these rows.
    await db.insertInto('job_runs').values([{ name: 'housekeeping' }, { name: 'materialize' }]).execute();
    t = await makeApp({ db, now: T0, config: { cronSecret: 'a-cron-secret-of-16+' } });
  });
  afterAll(async () => {
    await t?.app.close();
    await closeTestDb();
  });

  it('each job runs once however many callers race for it', async () => {
    const results = await Promise.all([runDueJobs(t.ctx), runDueJobs(t.ctx), runDueJobs(t.ctx)]);
    const ran = results.flatMap((r) => r.ran).sort();
    expect(ran).toEqual(['housekeeping', 'materialize']);
    const rows = await db.selectFrom('job_runs').selectAll().orderBy('name').execute();
    expect(rows.every((r) => r.last_error === null && r.last_finished_at !== null)).toBe(true);
  });

  it('housekeeping repeats about every minute; materialize once per college day from 00:15', async () => {
    await runDueJobs(t.ctx);
    t.clock.now += 30_000;
    expect((await runDueJobs(t.ctx)).ran).toEqual([]);
    t.clock.now += 30_000;
    expect((await runDueJobs(t.ctx)).ran).toEqual(['housekeeping']);
    // Next day 00:10 India: too early for materialize.
    t.clock.now = Date.UTC(2026, 8, 21, 18, 40, 0);
    expect((await runDueJobs(t.ctx)).ran).toEqual(['housekeeping']);
    t.clock.now = Date.UTC(2026, 8, 21, 18, 50, 0); // 00:20 India
    expect((await runDueJobs(t.ctx)).ran).toEqual(['housekeeping', 'materialize']);
  });

  it('the cron endpoint needs the secret', async () => {
    expect((await t.app.inject('/v1/internal/cron')).statusCode).toBe(404);
    expect((await t.app.inject({ url: '/v1/internal/cron', headers: { authorization: 'Bearer wrong-secret-xxxxxxxx' } })).statusCode).toBe(404);
    const ok = await t.app.inject({ url: '/v1/internal/cron', headers: { authorization: 'Bearer a-cron-secret-of-16+' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().ran).toEqual(expect.arrayContaining(['housekeeping']));
  });
});

describe('Android pilot mode (ADR-0021)', () => {
  const device = { platform: 'android' as const, attestation_level: 'tee', app_attest_public_key: null, app_attest_counter: 0 };
  const svc = (over: Parameters<typeof testConfig>[0]) => new AttestationService(testConfig(over), logSink().logger, { play: null, revokedSerials: async () => new Set() });
  const android = (mode: 'required' | 'off', digests: string[]) => ({ packageName: 'app.argus.argus', signingCertDigests: digests, playIntegrityCredentialsPath: undefined, playIntegrityMode: mode });
  const ios = { appId: undefined, environment: 'production' as const, deviceCheckKeyId: undefined, deviceCheckKeyPath: undefined };

  it('production refuses Android registration without Play Integrity unless pilot mode is on', () => {
    expect(svc({ env: 'production', attestation: { android: android('required', ['ab'.repeat(32)]), ios } }).platformReady('android').ok).toBe(false);
    expect(svc({ env: 'production', attestation: { android: android('off', ['ab'.repeat(32)]), ios } }).platformReady('android').ok).toBe(true);
  });

  it('pilot mode still requires the app signing certificate', () => {
    expect(svc({ env: 'production', attestation: { android: android('off', []), ios } }).platformReady('android').ok).toBe(false);
  });

  it('pilot-mode scans are not flagged for the missing Play Integrity token', async () => {
    const r = await svc({ env: 'production', attestation: { android: android('off', ['ab'.repeat(32)]), ios } }).verifyRequest(device, Buffer.from('x'), { kind: 'none' });
    expect(r.result).toBe('not_required');
  });
});
