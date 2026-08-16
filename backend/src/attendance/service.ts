import { sql } from 'kysely';
import { appendAudit } from '../audit/audit.ts';
import type { AppContext } from '../context.ts';
import type { DbOrTx, Tx } from '../db/index.ts';
import type { RecordStatus, RoundMode } from '../db/schema.ts';
import { ApiError } from '../errors.ts';
import { b64url } from '../platform/crypto.ts';
import { uuidv7 } from '../platform/ids.ts';
import { num } from '../risk/settings.ts';
import { REASON_TEXT } from '../risk/scorers.ts';
import { presentSession, sessionsView } from '../timetable/service.ts';
import { decryptKs, DEFAULT_EPOCH_MS, deriveKqr, encryptKs, generateKs } from './crypto.ts';

/**
 * Attendance sessions, rounds, records, spot checks (spec §4, §6; protocol §5;
 * ADR-0004, ADR-0010, ADR-0011).
 */

export const START_EARLY_MS = 10 * 60_000;
export const KEY_RETENTION_MS = 10 * 60_000;
export const AUTO_END_AFTER_MS = 15 * 60_000;

type SessionRow = {
  id: string;
  class_session_id: string;
  started_by: string;
  status: 'active' | 'ended';
  t0_ms: string;
  epoch_ms: number;
  ks_ciphertext: Buffer | null;
  headcount: number | null;
  started_at: Date;
  ended_at: Date | null;
};

interface ClassInfo {
  id: string;
  teacher_id: string | null;
  status: string;
  offering_id: string;
  group_id: string | null;
  room_id: string | null;
  starts_at: Date;
  ends_at: Date;
}

export async function loadClass(db: DbOrTx, classSessionId: string): Promise<ClassInfo | undefined> {
  const r = await db
    .selectFrom('class_sessions')
    .select(['id', 'teacher_id', 'status', 'offering_id', 'group_id', 'room_id', sql<Date>`lower(time_range)`.as('starts_at'), sql<Date>`upper(time_range)`.as('ends_at')])
    .where('id', '=', classSessionId)
    .executeTakeFirst();
  return r ? { ...r, starts_at: new Date(r.starts_at), ends_at: new Date(r.ends_at) } : undefined;
}

/** Students expected at a class: actively enrolled in the offering, in the right batch. */
export async function expectedStudents(db: DbOrTx, classSessionId: string) {
  const r = await sql<{ id: string; name: string; usn: string | null; batch: string | null }>`
    select u.id, u.name, s.usn, g.name as batch
    from class_sessions cs
    join enrollments e on e.offering_id = cs.offering_id
    join users u on u.id = e.student_id and u.status = 'active'
    left join students s on s.user_id = u.id
    left join section_groups g on g.id = e.group_id
    where cs.id = ${classSessionId} and (cs.group_id is null or e.group_id = cs.group_id)
    order by u.name`.execute(db);
  return r.rows;
}

export async function isExpected(db: DbOrTx, classSessionId: string, studentId: string): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`
    select exists(
      select 1 from class_sessions cs
      join enrollments e on e.offering_id = cs.offering_id and e.student_id = ${studentId}
      join users u on u.id = e.student_id and u.status = 'active'
      where cs.id = ${classSessionId} and (cs.group_id is null or e.group_id = cs.group_id)) as ok`.execute(db);
  return Boolean(r.rows[0]?.ok);
}

/** Decrypted K_s from the in-memory cache, or null once wiped (10 min after end). */
export function sessionKey(ctx: AppContext, s: Pick<SessionRow, 'id' | 'ks_ciphertext'>): Buffer | null {
  const cached = ctx.keys.get(s.id);
  if (cached) return cached;
  if (!s.ks_ciphertext) return null;
  const ks = decryptKs(ctx.config.masterKey, s.id, s.ks_ciphertext);
  ctx.keys.set(s.id, ks);
  return ks;
}

async function mySession(db: DbOrTx, sessionId: string, teacherId: string): Promise<SessionRow> {
  const s = await db.selectFrom('attendance_sessions').selectAll().where('id', '=', sessionId).executeTakeFirst();
  // Another teacher's session looks exactly like a missing one.
  if (!s || s.started_by !== teacherId) throw new ApiError(404, 'not_found', 'Attendance session not found.');
  return s;
}

async function openRound(db: DbOrTx, sessionId: string) {
  return db.selectFrom('attendance_rounds').selectAll().where('session_id', '=', sessionId).where('closed_at', 'is', null).executeTakeFirst();
}

// ── Start ────────────────────────────────────────────────────────────────────

export async function startAttendance(ctx: AppContext, classSessionId: string, teacherId: string, ip: string) {
  const cls = await loadClass(ctx.db, classSessionId);
  if (!cls || cls.teacher_id !== teacherId) throw new ApiError(403, 'not_your_class', 'You can only start attendance for your own classes.');
  if (cls.status === 'cancelled') throw new ApiError(409, 'class_cancelled', 'This class is cancelled.');
  if (cls.status !== 'scheduled') throw new ApiError(409, 'already_started', 'Attendance for this class has already been taken.');
  const now = ctx.now();
  if (now < cls.starts_at.getTime() - START_EARLY_MS || now > cls.ends_at.getTime()) {
    throw new ApiError(403, 'outside_class_time', 'Attendance can be started from 10 minutes before the class until it ends.');
  }

  const id = uuidv7(now);
  const ks = generateKs();
  try {
    await ctx.db.transaction().execute(async (tx) => {
      await tx
        .insertInto('attendance_sessions')
        .values({ id, class_session_id: cls.id, started_by: teacherId, t0_ms: now, epoch_ms: DEFAULT_EPOCH_MS, ks_ciphertext: encryptKs(ctx.config.masterKey, id, ks), started_at: new Date(now) })
        .execute();
      await tx.insertInto('attendance_rounds').values({ id: uuidv7(now), session_id: id, round_no: 1, mode: 'full', opened_at: new Date(now), opened_by: teacherId }).execute();
      const upd = await tx
        .updateTable('class_sessions')
        .set({ status: 'in_progress', attendance_locked: true })
        .where('id', '=', cls.id)
        .where('status', '=', 'scheduled')
        .executeTakeFirst();
      if (upd.numUpdatedRows === 0n) throw new ApiError(409, 'already_started', 'Attendance for this class has already been taken.');
      await appendAudit(tx, { actorId: teacherId, action: 'attendance.start', entityType: 'attendance_session', entityId: id, after: { class_session_id: cls.id }, ip }, new Date(now));
    });
  } catch (err) {
    ks.fill(0);
    if ((err as { code?: string }).code === '23505') throw new ApiError(409, 'already_started', 'Attendance for this class is already running.');
    throw err;
  }
  ctx.keys.set(id, ks);
  return { attendance_session_id: id, round: 1, t0_ms: now, epoch_ms: DEFAULT_EPOCH_MS };
}

// ── Rounds ───────────────────────────────────────────────────────────────────

function sample<T>(items: T[], k: number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a.slice(0, Math.max(0, k));
}

/** Latest accepted decision per student in this session. */
async function acceptedByStudent(db: DbOrTx, sessionId: string) {
  const rows = await sql<{ student_id: string; decision: string; round_no: number; risk_score: number }>`
    select distinct on (a.student_id) a.student_id, a.decision, r.round_no, a.risk_score
    from attendance_attempts a join attendance_rounds r on r.id = a.round_id
    where a.session_id = ${sessionId} and a.decision <> 'rejected'
    order by a.student_id, r.round_no desc`.execute(db);
  return new Map(rows.rows.map((r) => [r.student_id, r]));
}

/**
 * Closes a round. For rechecks (round ≥ 2), students who were asked to scan
 * again, had scanned in an earlier round, and did not scan now get a
 * missed_recheck flag at high severity; the teacher decides (ADR-0010).
 */
async function closeRound(tx: Tx, ctx: AppContext, sessionId: string, now: Date): Promise<void> {
  const round = await openRound(tx, sessionId);
  if (!round) return;
  await tx.updateTable('attendance_rounds').set({ closed_at: now }).where('id', '=', round.id).execute();
  if (round.round_no < 2) return;
  const r = await sql<{ student_id: string }>`
    select distinct a.student_id
    from attendance_attempts a join attendance_rounds r on r.id = a.round_id
    where a.session_id = ${sessionId} and a.decision <> 'rejected' and r.round_no < ${round.round_no}
      and (${round.target_student_ids}::uuid[] is null or a.student_id = any(${round.target_student_ids}::uuid[]))
      and not exists (
        select 1 from attendance_attempts b where b.round_id = ${round.id} and b.student_id = a.student_id and b.decision <> 'rejected')`.execute(tx);
  for (const { student_id } of r.rows) {
    await tx
      .insertInto('risk_flags')
      .values({ id: uuidv7(now.getTime()), student_id, session_id: sessionId, type: 'missed_recheck', severity: 'high', details: JSON.stringify({ round: round.round_no, mode: round.mode }) })
      .execute();
  }
}

export async function startRound(ctx: AppContext, sessionId: string, teacherId: string, mode: Exclude<RoundMode, 'full'> | 'full', ip: string) {
  const s = await mySession(ctx.db, sessionId, teacherId);
  if (s.status !== 'active') throw new ApiError(409, 'session_ended', 'Attendance has already ended.');
  const settings = await ctx.risk.load(ctx.db, ctx.now());
  const now = new Date(ctx.now());
  const result = await ctx.db.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${`round:${sessionId}`}))`.execute(tx);
    const last = await tx.selectFrom('attendance_rounds').select(['round_no']).where('session_id', '=', sessionId).orderBy('round_no', 'desc').limit(1).executeTakeFirstOrThrow();

    let targets: string[] | null = null;
    if (mode === 'targeted') {
      // Unmarked + flagged + a random sample of verified students (spec §6).
      const expected = await expectedStudents(tx, s.class_session_id);
      const accepted = await acceptedByStudent(tx, sessionId);
      const unmarkedOrFlagged = expected.filter((e) => accepted.get(e.id)?.decision !== 'verified').map((e) => e.id);
      const verified = expected.filter((e) => accepted.get(e.id)?.decision === 'verified').map((e) => e.id);
      targets = [...unmarkedOrFlagged, ...sample(verified, num(settings, 'recheck_random_sample', 3))];
    }
    await closeRound(tx, ctx, sessionId, now);
    const roundNo = last.round_no + 1;
    await tx.insertInto('attendance_rounds').values({ id: uuidv7(now.getTime()), session_id: sessionId, round_no: roundNo, mode, opened_at: now, opened_by: teacherId, target_student_ids: targets }).execute();
    await appendAudit(tx, { actorId: teacherId, action: 'attendance.round', entityType: 'attendance_session', entityId: sessionId, after: { round: roundNo, mode, targets: targets?.length ?? null }, ip }, now);
    return { round: roundNo, mode, targeted: targets?.length ?? null };
  });
  ctx.events.publish({ type: 'round', sessionId });
  return result;
}

// ── End ──────────────────────────────────────────────────────────────────────

export async function endAttendance(ctx: AppContext, sessionId: string, actor: { teacherId: string } | 'system', ip: string | null) {
  const s = actor === 'system'
    ? await ctx.db.selectFrom('attendance_sessions').selectAll().where('id', '=', sessionId).executeTakeFirstOrThrow()
    : await mySession(ctx.db, sessionId, actor.teacherId);
  if (s.status !== 'active') throw new ApiError(409, 'session_ended', 'Attendance has already ended.');
  const now = new Date(ctx.now());
  const actorId = actor === 'system' ? null : actor.teacherId;
  const summary = await ctx.db.transaction().execute(async (tx) => {
    const ended = await tx
      .updateTable('attendance_sessions')
      .set({ status: 'ended', ended_at: now, ended_by: actorId, key_wipe_at: new Date(now.getTime() + KEY_RETENTION_MS) })
      .where('id', '=', sessionId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (ended.numUpdatedRows === 0n) throw new ApiError(409, 'session_ended', 'Attendance has already ended.');
    await closeRound(tx, ctx, sessionId, now);
    // Everyone expected without a record is absent (spec §6 End).
    const absent = await sql<{ n: number }>`
      with ins as (
        insert into attendance_records (student_id, class_session_id, attendance_session_id, status, basis)
        select e.student_id, cs.id, ${sessionId}, 'absent', 'system'
        from class_sessions cs
        join enrollments e on e.offering_id = cs.offering_id
        join users u on u.id = e.student_id and u.status = 'active'
        where cs.id = ${s.class_session_id} and (cs.group_id is null or e.group_id = cs.group_id)
        on conflict (student_id, class_session_id) do nothing
        returning 1)
      select count(*)::int as n from ins`.execute(tx);
    await tx.updateTable('class_sessions').set({ status: 'completed' }).where('id', '=', s.class_session_id).execute();
    const counts = await recordCounts(tx, s.class_session_id);
    await appendAudit(tx, { actorId, action: actor === 'system' ? 'attendance.auto_end' : 'attendance.end', entityType: 'attendance_session', entityId: sessionId, after: { ...counts, marked_absent: absent.rows[0]?.n ?? 0 }, ip }, now);
    return counts;
  });
  ctx.events.publish({ type: 'ended', sessionId });
  return summary;
}

async function recordCounts(db: DbOrTx, classSessionId: string): Promise<Record<RecordStatus, number>> {
  const rows = await db.selectFrom('attendance_records').select(['status', (eb) => eb.fn.countAll<string>().as('n')]).where('class_session_id', '=', classSessionId).groupBy('status').execute();
  const out: Record<RecordStatus, number> = { present: 0, late: 0, absent: 0, excused: 0, pending: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

/** Housekeeping: end sessions whose class ended 15+ min ago, and wipe keys past retention. */
export async function housekeeping(ctx: AppContext): Promise<{ autoEnded: number; keysWiped: number; noncesPurged: number }> {
  const stale = await sql<{ id: string }>`
    select a.id from attendance_sessions a join class_sessions cs on cs.id = a.class_session_id
    where a.status = 'active' and upper(cs.time_range) < ${new Date(ctx.now() - AUTO_END_AFTER_MS)}`.execute(ctx.db);
  let autoEnded = 0;
  for (const { id } of stale.rows) {
    try {
      await endAttendance(ctx, id, 'system', null);
      autoEnded++;
    } catch (err) {
      if (!(err instanceof ApiError)) ctx.logger.error({ err, sessionId: id }, 'auto-end failed');
    }
  }
  const wiped = await ctx.db
    .updateTable('attendance_sessions')
    .set({ ks_ciphertext: null })
    .where('key_wipe_at', '<=', new Date(ctx.now()))
    .where('ks_ciphertext', 'is not', null)
    .returning('id')
    .execute();
  for (const w of wiped) ctx.keys.wipe(w.id);
  const purged = await ctx.db.deleteFrom('used_nonces').where('expires_at', '<', new Date(ctx.now())).executeTakeFirst();
  await ctx.db.deleteFrom('display_pairings').where('session_id', 'is', null).where('expires_at', '<', new Date(ctx.now() - 3600_000)).execute();
  await ctx.db.deleteFrom('device_bind_challenges').where('expires_at', '<', new Date(ctx.now() - 3600_000)).execute();
  return { autoEnded, keysWiped: wiped.length, noncesPurged: Number(purged.numDeletedRows) };
}

// ── Display ─────────────────────────────────────────────────────────────────

/** What a paired classroom screen may know: the current round's QR key only (ADR-0004). */
export async function displayState(ctx: AppContext, sessionId: string) {
  const s = await ctx.db.selectFrom('attendance_sessions').selectAll().where('id', '=', sessionId).executeTakeFirst();
  if (!s || s.status !== 'active') return { status: 'ended' as const };
  const round = await openRound(ctx.db, sessionId);
  const ks = sessionKey(ctx, s);
  if (!round || !ks) return { status: 'ended' as const };
  const cls = await sessionsView(ctx.db, ctx.config.timeZone).where('cs.id', '=', s.class_session_id).executeTakeFirstOrThrow();
  return {
    status: 'active' as const,
    session_id: s.id,
    round: round.round_no,
    mode: round.mode,
    t0_ms: Number(s.t0_ms),
    epoch_ms: s.epoch_ms,
    k_qr: b64url(deriveKqr(ks, s.id, round.round_no)),
    server_time_ms: ctx.now(),
    // No student data on the display (spec §6); subject and room help people find the right screen.
    label: `${cls.subject_code}${cls.room ? ` · ${cls.room}` : ''}`,
    ends_at: new Date(cls.ends_at).toISOString(),
  };
}

// ── Live panel ───────────────────────────────────────────────────────────────

export type StudentState = 'verified' | 'flagged' | 'flagged_high' | 'pending' | 'confirmed' | 'unmarked' | 'absent' | 'late' | 'excused';

export async function liveView(ctx: AppContext, sessionId: string, teacherId: string) {
  const s = await mySession(ctx.db, sessionId, teacherId);
  const cls = await sessionsView(ctx.db, ctx.config.timeZone).where('cs.id', '=', s.class_session_id).executeTakeFirstOrThrow();
  const settings = await ctx.risk.load(ctx.db, ctx.now());
  const [expected, rounds, attempts, records, flags, spots] = await Promise.all([
    expectedStudents(ctx.db, s.class_session_id),
    ctx.db.selectFrom('attendance_rounds').selectAll().where('session_id', '=', sessionId).orderBy('round_no').execute(),
    ctx.db
      .selectFrom('attendance_attempts as a')
      .leftJoin('attendance_rounds as r', 'r.id', 'a.round_id')
      .select(['a.id', 'a.student_id', 'a.decision', 'a.reason_codes', 'a.risk_score', 'a.received_at', 'a.offline_queued', 'r.round_no'])
      .where('a.session_id', '=', sessionId)
      .orderBy('a.received_at')
      .execute(),
    ctx.db.selectFrom('attendance_records').selectAll().where('class_session_id', '=', s.class_session_id).execute(),
    ctx.db.selectFrom('risk_flags').selectAll().where('session_id', '=', sessionId).execute(),
    ctx.db.selectFrom('spot_checks').selectAll().where('session_id', '=', sessionId).orderBy('suggested_at').execute(),
  ]);
  const current = rounds.find((r) => !r.closed_at) ?? rounds[rounds.length - 1];
  const recordBy = new Map(records.map((r) => [r.student_id, r]));

  const students = expected.map((e) => {
    const mine = attempts.filter((a) => a.student_id === e.id);
    const accepted = mine.filter((a) => a.decision !== 'rejected');
    const latest = accepted[accepted.length - 1];
    const lastRejected = [...mine].reverse().find((a) => a.decision === 'rejected');
    const openFlags = flags.filter((f) => f.student_id === e.id && !f.resolved_at);
    const record = recordBy.get(e.id);
    let state: StudentState = 'unmarked';
    if (record?.basis === 'teacher' || record?.basis === 'verifier' || record?.basis === 'correction') {
      state = record.status === 'absent' ? 'absent' : record.status === 'excused' ? 'excused' : 'confirmed';
    } else if (record?.status === 'pending') state = 'pending';
    else if (latest) {
      state = latest.decision as StudentState;
      if (openFlags.some((f) => f.severity === 'high')) state = 'flagged_high';
    } else if (record?.status === 'absent') state = 'absent';
    const reasons = new Set<string>();
    for (const a of accepted) for (const c of a.reason_codes) reasons.add(c);
    for (const f of openFlags) reasons.add(f.type);
    return {
      id: e.id,
      name: e.name,
      usn: e.usn,
      batch: e.batch,
      state,
      record: record?.status ?? null,
      late: record?.status === 'late',
      score: latest?.risk_score ?? null,
      reasons: [...reasons].map((c) => REASON_TEXT[c] ?? c),
      last_rejection: lastRejected && !latest ? { code: lastRejected.reason_codes[0] ?? 'rejected', at: lastRejected.received_at.toISOString() } : null,
      targeted: current?.target_student_ids ? current.target_student_ids.includes(e.id) : true,
      scanned_this_round: Boolean(current && accepted.some((a) => a.round_no === current.round_no)),
    };
  });

  const present = students.filter((st) => ['verified', 'flagged', 'flagged_high', 'confirmed'].includes(st.state)).length;
  const tolerance = num(settings, 'headcount_tolerance', 2);
  return {
    session: {
      id: s.id,
      status: s.status,
      started_at: s.started_at.toISOString(),
      ended_at: s.ended_at?.toISOString() ?? null,
      headcount: s.headcount,
      class: presentSession(cls),
    },
    round: current ? { no: current.round_no, mode: current.mode, opened_at: current.opened_at.toISOString(), closed: Boolean(current.closed_at), targets: current.target_student_ids?.length ?? null } : null,
    counts: {
      expected: expected.length,
      present,
      flagged: students.filter((st) => st.state === 'flagged').length,
      flagged_high: students.filter((st) => st.state === 'flagged_high').length,
      pending: students.filter((st) => st.state === 'pending').length,
      unmarked: students.filter((st) => st.state === 'unmarked').length,
      absent: students.filter((st) => st.state === 'absent').length,
    },
    headcount_warning: s.headcount !== null && present > s.headcount + tolerance,
    students,
    spot_checks: spots.map((sp) => ({
      id: sp.id,
      student_id: sp.student_id,
      name: expected.find((e) => e.id === sp.student_id)?.name ?? 'Student',
      reason: sp.selected_reason,
      result: sp.result,
    })),
  };
}

// ── Teacher decisions ───────────────────────────────────────────────────────

async function assertCanDecide(ctx: AppContext, s: SessionRow) {
  const cls = await loadClass(ctx.db, s.class_session_id);
  // After class ends, changes go through corrections (spec §7), unless attendance is still running.
  if (s.status !== 'active' && cls && ctx.now() > cls.ends_at.getTime()) {
    throw new ApiError(409, 'class_over', 'The class is over. Ask Academic Operations for a correction.');
  }
}

export async function decideStudent(ctx: AppContext, sessionId: string, teacherId: string, studentId: string, status: 'present' | 'absent', note: string | null, ip: string) {
  const s = await mySession(ctx.db, sessionId, teacherId);
  await assertCanDecide(ctx, s);
  if (!(await isExpected(ctx.db, s.class_session_id, studentId))) throw new ApiError(404, 'not_found', 'This student is not in this class.');
  const now = new Date(ctx.now());
  await ctx.db.transaction().execute(async (tx) => {
    const before = await tx.selectFrom('attendance_records').selectAll().where('student_id', '=', studentId).where('class_session_id', '=', s.class_session_id).executeTakeFirst();
    await tx
      .insertInto('attendance_records')
      .values({ student_id: studentId, class_session_id: s.class_session_id, attendance_session_id: sessionId, status, basis: 'teacher', updated_by: teacherId, note })
      .onConflict((oc) => oc.columns(['student_id', 'class_session_id']).doUpdateSet({ status, basis: 'teacher', updated_by: teacherId, note }))
      .execute();
    await tx
      .updateTable('risk_flags')
      .set({ resolved_by: teacherId, resolved_at: now, resolution: status === 'present' ? 'confirmed_present' : 'marked_absent' })
      .where('session_id', '=', sessionId)
      .where('student_id', '=', studentId)
      .where('resolved_at', 'is', null)
      .execute();
    await appendAudit(tx, { actorId: teacherId, action: 'attendance.teacher_decision', entityType: 'attendance_record', entityId: `${studentId}:${s.class_session_id}`, before: before ? { status: before.status, basis: before.basis } : null, after: { status, note }, ip }, now);
  });
  ctx.events.publish({ type: 'record', sessionId });
  return { ok: true };
}

export async function setHeadcount(ctx: AppContext, sessionId: string, teacherId: string, headcount: number, ip: string) {
  const s = await mySession(ctx.db, sessionId, teacherId);
  if (s.status !== 'active') throw new ApiError(409, 'session_ended', 'Attendance has already ended.');
  await ctx.db.transaction().execute(async (tx) => {
    await tx.updateTable('attendance_sessions').set({ headcount }).where('id', '=', sessionId).execute();
    await appendAudit(tx, { actorId: teacherId, action: 'attendance.headcount', entityType: 'attendance_session', entityId: sessionId, after: { headcount }, ip }, new Date(ctx.now()));
  });
  ctx.events.publish({ type: 'record', sessionId });
  return liveView(ctx, sessionId, teacherId);
}

// ── Spot checks (spec §6, ADR-0010) ─────────────────────────────────────────

function weightedPick<T extends { weight: number }>(items: T[], k: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < k && pool.length > 0) {
    const total = pool.reduce((a, b) => a + b.weight, 0);
    let x = Math.random() * total;
    const i = pool.findIndex((p) => (x -= p.weight) <= 0);
    out.push(...pool.splice(i === -1 ? pool.length - 1 : i, 1));
  }
  return out;
}

export async function suggestSpotChecks(ctx: AppContext, sessionId: string, teacherId: string, ip: string) {
  const view = await liveView(ctx, sessionId, teacherId);
  if (view.session.status !== 'active') throw new ApiError(409, 'session_ended', 'Attendance has already ended.');
  const settings = await ctx.risk.load(ctx.db, ctx.now());
  const already = new Set(view.spot_checks.filter((sp) => !sp.result).map((sp) => sp.student_id));
  const eligible = view.students.filter((st) => !already.has(st.id));
  const high = eligible.filter((st) => st.state === 'flagged_high').map((st) => ({ st, reason: 'flagged_high' as const, weight: 1 }));
  const flagged = weightedPick(eligible.filter((st) => st.state === 'flagged').map((st) => ({ st, reason: 'flagged' as const, weight: (st.score ?? 0) + 1 })), num(settings, 'spot_check_flagged_max', 5));
  const random = weightedPick(eligible.filter((st) => st.state === 'verified').map((st) => ({ st, reason: 'random' as const, weight: (st.score ?? 0) + 1 })), num(settings, 'spot_check_random', 3));
  const picks = [...high, ...flagged, ...random];
  const now = new Date(ctx.now());
  const round = view.round;
  await ctx.db.transaction().execute(async (tx) => {
    const roundRow = round ? await tx.selectFrom('attendance_rounds').select('id').where('session_id', '=', sessionId).where('round_no', '=', round.no).executeTakeFirst() : undefined;
    for (const p of picks) {
      await tx.insertInto('spot_checks').values({ id: uuidv7(now.getTime()), session_id: sessionId, round_id: roundRow?.id ?? null, student_id: p.st.id, selected_reason: p.reason, teacher_id: teacherId, suggested_at: now }).execute();
    }
    await appendAudit(tx, { actorId: teacherId, action: 'attendance.spot_check_suggest', entityType: 'attendance_session', entityId: sessionId, after: { count: picks.length }, ip }, now);
  });
  ctx.events.publish({ type: 'record', sessionId });
  return liveView(ctx, sessionId, teacherId);
}

export async function recordSpotCheck(ctx: AppContext, sessionId: string, teacherId: string, spotCheckId: string, result: 'confirmed' | 'absent' | 'no_response', ip: string) {
  const s = await mySession(ctx.db, sessionId, teacherId);
  await assertCanDecide(ctx, s);
  const now = new Date(ctx.now());
  await ctx.db.transaction().execute(async (tx) => {
    const sp = await tx.selectFrom('spot_checks').selectAll().where('id', '=', spotCheckId).where('session_id', '=', sessionId).forUpdate().executeTakeFirst();
    if (!sp) throw new ApiError(404, 'not_found', 'Spot check not found.');
    await tx.updateTable('spot_checks').set({ result, recorded_at: now }).where('id', '=', sp.id).execute();
    if (result === 'confirmed') {
      await tx
        .updateTable('risk_flags')
        .set({ resolved_by: teacherId, resolved_at: now, resolution: 'confirmed_present' })
        .where('session_id', '=', sessionId)
        .where('student_id', '=', sp.student_id)
        .where('resolved_at', 'is', null)
        .execute();
    } else {
      // absent → record absent + flag visible to Acad Ops; no_response → flag only, record unchanged (ADR-0010).
      await tx
        .insertInto('risk_flags')
        .values({ id: uuidv7(now.getTime()), student_id: sp.student_id, session_id: sessionId, type: result === 'absent' ? 'spot_check_absent' : 'spot_check_no_response', severity: 'high', details: JSON.stringify({ spot_check_id: sp.id, reason: sp.selected_reason }) })
        .execute();
      if (result === 'absent') {
        await tx
          .insertInto('attendance_records')
          .values({ student_id: sp.student_id, class_session_id: s.class_session_id, attendance_session_id: sessionId, status: 'absent', basis: 'teacher', updated_by: teacherId, note: 'Not in the room at spot check' })
          .onConflict((oc) => oc.columns(['student_id', 'class_session_id']).doUpdateSet({ status: 'absent', basis: 'teacher', updated_by: teacherId, note: 'Not in the room at spot check' }))
          .execute();
      }
    }
    await appendAudit(tx, { actorId: teacherId, action: 'attendance.spot_check', entityType: 'spot_check', entityId: sp.id, after: { student_id: sp.student_id, result }, ip }, now);
  });
  ctx.events.publish({ type: 'record', sessionId });
  return liveView(ctx, sessionId, teacherId);
}

// ── Student views ───────────────────────────────────────────────────────────

/** Active attendance for classes this student is expected at, with what they need to do. */
export async function activeForStudent(ctx: AppContext, studentId: string) {
  const rows = await sql<{ session_id: string; class_session_id: string; round_no: number; mode: RoundMode; target_student_ids: string[] | null }>`
    select a.id as session_id, a.class_session_id, r.round_no, r.mode, r.target_student_ids
    from attendance_sessions a
    join class_sessions cs on cs.id = a.class_session_id
    join enrollments e on e.offering_id = cs.offering_id and e.student_id = ${studentId}
    join attendance_rounds r on r.session_id = a.id and r.closed_at is null
    where a.status = 'active' and (cs.group_id is null or e.group_id = cs.group_id)`.execute(ctx.db);
  const out = [];
  for (const r of rows.rows) {
    const cls = await sessionsView(ctx.db, ctx.config.timeZone).where('cs.id', '=', r.class_session_id).executeTakeFirstOrThrow();
    const marked = await ctx.db
      .selectFrom('attendance_attempts as a')
      .innerJoin('attendance_rounds as rd', 'rd.id', 'a.round_id')
      .select(['a.decision', 'rd.round_no'])
      .where('a.session_id', '=', r.session_id)
      .where('a.student_id', '=', studentId)
      .where('a.decision', '<>', 'rejected')
      .orderBy('rd.round_no', 'desc')
      .execute();
    const thisRound = marked.find((m) => m.round_no === r.round_no);
    const targeted = !r.target_student_ids || r.target_student_ids.includes(studentId);
    out.push({
      attendance_session_id: r.session_id,
      class: presentSession(cls),
      round: r.round_no,
      mode: r.mode,
      // scan: you need to scan now; done: this round is marked; nothing_to_do: a recheck that doesn't include you.
      action: thisRound ? ('done' as const) : targeted ? ('scan' as const) : ('nothing_to_do' as const),
      decision: thisRound?.decision ?? marked[0]?.decision ?? null,
    });
  }
  return { items: out };
}

/** Per-subject attendance with percentages (spec §11 student history). */
export async function studentHistory(ctx: AppContext, studentId: string) {
  const rows = await sql<{ offering_id: string; code: string; name: string; total: number; attended: number; late: number; absent: number }>`
    select o.id as offering_id, s.code, s.name,
      count(ar.*)::int as total,
      count(*) filter (where ar.status in ('present','late','excused'))::int as attended,
      count(*) filter (where ar.status = 'late')::int as late,
      count(*) filter (where ar.status = 'absent')::int as absent
    from attendance_records ar
    join class_sessions cs on cs.id = ar.class_session_id
    join course_offerings o on o.id = cs.offering_id
    join subjects s on s.id = o.subject_id
    where ar.student_id = ${studentId} and ar.status <> 'pending'
    group by o.id, s.code, s.name
    order by s.code`.execute(ctx.db);
  const recent = await sql<{ date: string; code: string; status: string; start: string }>`
    select cs.date::text as date, s.code, ar.status, to_char(lower(cs.time_range) at time zone ${ctx.config.timeZone}, 'HH24:MI') as start
    from attendance_records ar
    join class_sessions cs on cs.id = ar.class_session_id
    join course_offerings o on o.id = cs.offering_id
    join subjects s on s.id = o.subject_id
    where ar.student_id = ${studentId}
    order by lower(cs.time_range) desc limit 30`.execute(ctx.db);
  return {
    subjects: rows.rows.map((r) => ({ ...r, percent: r.total ? Math.round((r.attended / r.total) * 1000) / 10 : null })),
    recent: recent.rows,
  };
}
