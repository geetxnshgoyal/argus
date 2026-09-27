/**
 * Load test (spec §15 M7): N classes × M students all scan within one window.
 * Target: p95 server-side attempt latency < 500 ms.
 *
 *   createdb -h localhost -p 55432 -U argus argus_load
 *   LOAD_DATABASE_URL=postgres://argus@localhost:55432/argus_load pnpm --filter backend loadtest
 *
 * Options (env): LOAD_CLASSES (100), LOAD_STUDENTS (60 per class), LOAD_WINDOW_S (60),
 * LOAD_PORT (18080), DATABASE_POOL_MAX (20).
 *
 * The database named by LOAD_DATABASE_URL is WIPED. The server runs as its own
 * process (dev mode, attestation bypass) so the load generator doesn't share
 * its event loop; server-side latency comes from the server's own access log.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { sql } from 'kysely';
import { computeTag, currentEpoch } from '../src/attendance/crypto.ts';
import { createDb } from '../src/db/index.ts';
import { migrateToLatest } from '../src/db/migrate.ts';
import { b64url, fromB64url } from '../src/platform/crypto.ts';
import { uuidv7 } from '../src/platform/ids.ts';
import { canonicalize } from '../src/platform/jcs.ts';
import { POLICY_VERSION } from '../src/policy.ts';
import { deviceKey, type DeviceKey } from '../test/helpers/app.ts';
import { resetDb } from '../test/helpers/db.ts';

const DB_URL = process.env.LOAD_DATABASE_URL;
if (!DB_URL || !/load/i.test(DB_URL)) {
  console.error('Set LOAD_DATABASE_URL to a throwaway database whose name contains "load" (it is wiped).');
  process.exit(2);
}
const CLASSES = Number(process.env.LOAD_CLASSES ?? 100);
const PER_CLASS = Number(process.env.LOAD_STUDENTS ?? 60);
const WINDOW_MS = Number(process.env.LOAD_WINDOW_S ?? 60) * 1000;
const PORT = Number(process.env.LOAD_PORT ?? 18080);
const BASE = `http://127.0.0.1:${PORT}`;
const TZ = 'Asia/Kolkata';
const DOMAIN = 'loadtest.test';

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] as number) : NaN;
};

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i] as T, i);
      }
    }),
  );
}

async function api(method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: () => JSON.parse(text), text, headers: res.headers };
}

// ── 1. Database with N sections, one class each, happening now ─────────────
const db = createDb(DB_URL);
{
  const { error } = await migrateToLatest(db);
  if (error) throw error;
}
await resetDb(db);
await db.insertInto('job_runs').values([{ name: 'housekeeping' }, { name: 'materialize' }, { name: 'retention' }]).execute();

const local = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
const minutes = local.getHours() * 60 + local.getMinutes() - 5;
if (minutes < 0 || minutes + 90 > 24 * 60) {
  console.error('Run the load test between 00:05 and 22:30 college time (a class must fit in today).');
  process.exit(2);
}
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const weekday = ((local.getDay() + 6) % 7) + 1;
const today = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;

log(`setting up ${CLASSES} classes × ${PER_CLASS} students (${hhmm(minutes)}–${hhmm(minutes + 90)} today)`);
const dept = { id: uuidv7(), code: 'LOAD', name: 'Load test' };
await db.insertInto('departments').values(dept).execute();
const program = { id: uuidv7(), code: 'LOADP', name: 'Load program', department_id: dept.id };
await db.insertInto('programs').values(program).execute();
const term = { id: uuidv7(), name: 'Load term', start_date: `${local.getFullYear()}-01-01`, end_date: `${local.getFullYear()}-12-31` };
await db.insertInto('terms').values(term).execute();
const subject = { id: uuidv7(), code: 'LOAD', name: 'Load subject', kind: 'lecture' as const };
await db.insertInto('subjects').values(subject).execute();
await db.insertInto('campus_geofences').values({ id: uuidv7(), name: 'Campus', center_lat: 12.9, center_lon: 77.5, radius_m: 500 }).execute();
await db.insertInto('users').values({ id: uuidv7(), role: 'acadops', email: `ops@${DOMAIN}`, name: 'Ops' }).execute();

interface Student { email: string; userId: string; session: DeviceKey; attempt: DeviceKey; deviceId: string; access: string; classIdx: number }
const teachers: { email: string; id: string }[] = [];
const sections: string[] = [];
const students: Student[] = [];
for (let c = 0; c < CLASSES; c++) {
  const section = { id: uuidv7(), program_id: program.id, term_id: term.id, name: `Section ${c + 1}` };
  await db.insertInto('sections').values(section).execute();
  sections.push(section.id);
  const offering = { id: uuidv7(), term_id: term.id, subject_id: subject.id, section_id: section.id };
  await db.insertInto('course_offerings').values(offering).execute();
  const t = { id: uuidv7(), email: `t${c}@${DOMAIN}` };
  await db.insertInto('users').values({ id: t.id, role: 'teacher', email: t.email, name: `Teacher ${c}` }).execute();
  await db.insertInto('teachers').values({ user_id: t.id, faculty_id: `LT${c}`, department_id: dept.id }).execute();
  teachers.push(t);
  await db
    .insertInto('timetable_entries')
    .values({ id: uuidv7(), term_id: term.id, offering_id: offering.id, weekday, start_time: hhmm(minutes), end_time: hhmm(minutes + 90), teacher_id: t.id })
    .execute();
  const users = Array.from({ length: PER_CLASS }, (_, s) => ({ id: uuidv7(), role: 'student' as const, email: `s${c}-${s}@${DOMAIN}`, name: `Student ${c}-${s}` }));
  await db.insertInto('users').values(users).execute();
  await db
    .insertInto('students')
    .values(users.map((u, s) => ({ user_id: u.id, usn: `L${String(c).padStart(3, '0')}${String(s).padStart(3, '0')}`, program_id: program.id, section_id: section.id, admission_year: 2025 })))
    .execute();
  const phones = users.map((u) => ({ email: u.email, userId: u.id, session: deviceKey(), attempt: deviceKey(), deviceId: uuidv7(), access: '', classIdx: c }));
  await db
    .insertInto('devices')
    .values(phones.map((p) => ({ id: p.deviceId, user_id: p.userId, state: 'active' as const, platform: 'android' as const, session_key_spki: p.session.spki, attempt_key_spki: p.attempt.spki, attestation_level: 'dev_bypass' as const, activated_at: new Date() })))
    .execute();
  students.push(...phones);
}
await db.insertInto('policy_acceptances').values(students.map((s) => ({ user_id: s.userId, policy_version: POLICY_VERSION }))).execute();

// ── 2. Server process ──────────────────────────────────────────────────────
log('starting server');
const server = spawn(process.execPath, ['src/main.ts', 'serve'], {
  env: {
    ...process.env,
    ARGUS_ENV: 'dev',
    DATABASE_URL: DB_URL,
    ARGUS_PORT: String(PORT),
    ARGUS_HOST: '127.0.0.1',
    ARGUS_DEV_LOGIN: 'true',
    ARGUS_ATTESTATION_BYPASS: 'true',
    ARGUS_LOG_LEVEL: 'info',
    ARGUS_TIMEZONE: TZ,
    DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX ?? '20',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const serverMs: number[] = [];
let measuring = false;
createInterface({ input: server.stdout }).on('line', (line) => {
  if (!measuring || !line.includes('/v1/attendance/attempts')) return;
  try {
    const j = JSON.parse(line) as { ms?: number; url?: string };
    if (j.url === '/v1/attendance/attempts' && typeof j.ms === 'number') serverMs.push(j.ms);
  } catch {
    /* not JSON */
  }
});
const stop = () => server.kill('SIGTERM');
process.on('exit', stop);
for (let i = 0; ; i++) {
  try {
    if ((await api('GET', '/v1/health')).status === 200) break;
  } catch {
    /* not up yet */
  }
  if (i > 100) throw new Error('server did not start');
  await new Promise((r) => setTimeout(r, 200));
}

// ── 3. Enrollments, sessions, sign-ins ─────────────────────────────────────
async function webLogin(email: string) {
  const res = await api('POST', '/v1/auth/dev/login', { body: { email } });
  if (res.status !== 200) throw new Error(`login ${email}: ${res.text}`);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
  const csrf = (await api('GET', '/v1/me', { headers: { cookie } })).json().csrf_token as string;
  return { cookie, 'x-argus-csrf': csrf };
}
const ops = await webLogin(`ops@${DOMAIN}`);
await pool(sections, 8, async (id) => {
  const r = await api('POST', `/v1/admin/sections/${id}/sync-enrollments`, { headers: ops, body: {} });
  if (r.status !== 200) throw new Error(`sync ${r.text}`);
});
const mat = await api('POST', '/v1/admin/timetable/materialize', { headers: ops, body: {} });
if (mat.status !== 200) throw new Error(`materialize ${mat.text}`);

log(`signing in ${students.length} phones`);
await pool(students, 32, async (s) => {
  const r = await api('POST', '/v1/auth/dev/mobile-login', { body: { email: s.email, session_public_key: s.session.spki, signature: s.session.sign(`argus/v1/dev-login|${s.email}`) } });
  if (r.status !== 200) throw new Error(`mobile login ${r.text}`);
  s.access = r.json().access_token;
});

log('teachers start attendance');
const classes = await db
  .selectFrom('class_sessions as cs')
  .innerJoin('course_offerings as o', 'o.id', 'cs.offering_id')
  .select(['cs.id', 'o.section_id'])
  .where('cs.date', '=', today)
  .execute();
if (classes.length !== CLASSES) throw new Error(`expected ${CLASSES} class sessions today, got ${classes.length}`);
const displays: { session_id: string; round: number; t0_ms: number; epoch_ms: number; k_qr: string }[] = new Array(CLASSES);
await pool(teachers, 8, async (t, c) => {
  const headers = await webLogin(t.email);
  const cls = classes.find((x) => x.section_id === sections[c]);
  const start = await api('POST', `/v1/teacher/class-sessions/${cls?.id}/attendance/start`, { headers, body: {} });
  if (start.status !== 201) throw new Error(`start ${start.text}`);
  const d = await api('GET', `/v1/attendance/sessions/${start.json().attendance_session_id}/display`, { headers });
  displays[c] = d.json();
});

// ── 4. Everyone scans within the window ────────────────────────────────────
log(`${students.length} scans over ${WINDOW_MS / 1000} s`);
const clientMs: number[] = [];
const outcomes = new Map<string, number>();
const count = (k: string) => outcomes.set(k, (outcomes.get(k) ?? 0) + 1);
measuring = true;
const t0 = Date.now();
await Promise.all(
  students.map(async (s) => {
    await new Promise((r) => setTimeout(r, Math.random() * WINDOW_MS));
    const d = displays[s.classIdx] as (typeof displays)[number];
    const now = Date.now();
    const epoch = currentEpoch(now, d.t0_ms, d.epoch_ms);
    const payload = Buffer.from(
      canonicalize({
        v: 1,
        session_id: d.session_id,
        round: d.round,
        epoch,
        tag: b64url(computeTag(fromB64url(d.k_qr), d.session_id, d.round, epoch)),
        device_id: s.deviceId,
        nonce: randomBytes(16).toString('base64url'),
        device_time: new Date(now).toISOString(),
        location: { lat: 12.9 + (Math.random() - 0.5) * 0.001, lon: 77.5, accuracy_m: 15, fix_age_ms: 1200, is_mock: false },
        signals: {},
        app_version: '1.0.0',
        offline_queued: false,
      }),
    );
    const started = performance.now();
    try {
      const r = await api('POST', '/v1/attendance/attempts', {
        headers: { authorization: `Bearer ${s.access}` },
        body: { payload: b64url(payload), signature: s.attempt.sign(payload), attestation: { kind: 'none' } },
      });
      clientMs.push(performance.now() - started);
      count(r.status === 200 ? String(r.json().decision) : `${r.status} ${r.json().code ?? ''}`);
    } catch (err) {
      count(`network error: ${(err as Error).message}`);
    }
  }),
);
const elapsed = Date.now() - t0;
await new Promise((r) => setTimeout(r, 500)); // let the last access-log lines arrive
measuring = false;

// ── 5. Report ──────────────────────────────────────────────────────────────
const marked = await db.selectFrom('attendance_records').select(sql<number>`count(*)::int`.as('n')).where('status', 'in', ['present', 'late']).executeTakeFirstOrThrow();
const p95 = pct(serverMs, 95);
console.log(`
Load test: ${CLASSES} classes × ${PER_CLASS} students = ${students.length} scans in ${(elapsed / 1000).toFixed(1)} s (${(students.length / (elapsed / 1000)).toFixed(0)}/s average)
Outcomes:  ${[...outcomes].map(([k, v]) => `${k}: ${v}`).join(', ')}
Marked present in the database: ${marked.n}
Server-side latency (ms, from the access log, n=${serverMs.length}):  p50 ${pct(serverMs, 50)}  p95 ${p95}  p99 ${pct(serverMs, 99)}  max ${Math.max(...serverMs)}
Client-observed latency (ms):  p50 ${pct(clientMs, 50).toFixed(0)}  p95 ${pct(clientMs, 95).toFixed(0)}  p99 ${pct(clientMs, 99).toFixed(0)}
Target p95 < 500 ms server-side: ${p95 < 500 ? 'PASS' : 'FAIL'}
`);
stop();
await db.destroy();
process.exit(p95 < 500 && marked.n === students.length ? 0 : 1);
