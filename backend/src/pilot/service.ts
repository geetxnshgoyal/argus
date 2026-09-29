import { sql } from 'kysely';
import { appendAudit } from '../audit/audit.ts';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/index.ts';

/**
 * Pilot support (spec §15 M8, §17; ADR-0026): the shadow-mode switch and the
 * pilot metrics. Everything is computed from data Argus already stores; no
 * extra tracking.
 */

export async function shadowMode(db: DbOrTx): Promise<{ on: boolean; updated_at: string | null; updated_by_name: string | null }> {
  const row = await db
    .selectFrom('app_settings as s')
    .leftJoin('users as u', 'u.id', 's.updated_by')
    .select(['s.value', 's.updated_at', 's.updated_by', 'u.name'])
    .where('s.key', '=', 'shadow_mode')
    .executeTakeFirst();
  return { on: row?.value === true, updated_at: row?.updated_by ? row.updated_at.toISOString() : null, updated_by_name: row?.name ?? null };
}

export async function setShadowMode(ctx: AppContext, actorId: string, on: boolean, ip: string) {
  await ctx.db.transaction().execute(async (tx) => {
    const before = await tx.selectFrom('app_settings').select('value').where('key', '=', 'shadow_mode').forUpdate().executeTakeFirst();
    await tx
      .insertInto('app_settings')
      .values({ key: 'shadow_mode', value: JSON.stringify(on), updated_by: actorId, updated_at: new Date(ctx.now()) })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(on), updated_by: actorId, updated_at: new Date(ctx.now()) }))
      .execute();
    await appendAudit(tx, { actorId, action: 'pilot.shadow_mode', entityType: 'app_setting', entityId: 'shadow_mode', before: { on: before?.value === true }, after: { on }, ip }, new Date(ctx.now()));
  });
  return shadowMode(ctx.db);
}

// ── Metrics ────────────────────────────────────────────────────────────────

/** Spec §17 pilot acceptance targets. */
export const TARGETS = {
  false_reject_rate: 0.02,
  median_time_to_mark_s: 10,
  support_request_rate: 0.03,
  teacher_minutes: 2,
} as const;

/** Rejections that aren't a genuine student being turned away (a duplicate or no-op scan). */
const NOT_A_FALSE_REJECT = ['already_marked', 'not_targeted', 'replayed_nonce'];
/** Device clocks can be wrong; outside this window the scan-to-mark time is ignored. */
const MAX_SANE_DELAY_MS = 5 * 60_000;

export interface MetricsQuery {
  from: string;
  to: string;
  sectionId?: string | undefined;
}

export async function pilotMetrics(ctx: AppContext, q: MetricsQuery) {
  const db = ctx.db;
  const section = q.sectionId ? sql`and o.section_id = ${q.sectionId}` : sql``;
  // Attendance sessions in scope, with how many students were expected at each.
  const scope = sql`
    select a.id, a.class_session_id, a.shadow, a.started_at, cs.date, cs.offering_id, cs.group_id
    from attendance_sessions a
    join class_sessions cs on cs.id = a.class_session_id
    join course_offerings o on o.id = cs.offering_id
    where cs.date between ${q.from}::date and ${q.to}::date ${section}`;

  const totals = await sql<{ sessions: number; shadow_sessions: number; expected: number; present: number }>`
    with s as (${scope})
    select count(*)::int as sessions,
      count(*) filter (where s.shadow)::int as shadow_sessions,
      coalesce(sum((select count(*) from enrollments e join users u on u.id = e.student_id and u.status = 'active'
                    where e.offering_id = s.offering_id and (s.group_id is null or e.group_id = s.group_id))), 0)::int as expected,
      coalesce(sum((select count(*) from attendance_records r where r.class_session_id = s.class_session_id and r.status in ('present','late'))), 0)::int as present
    from s`.execute(db);

  const decisions = await sql<{ decision: string; n: number }>`
    with s as (${scope})
    select a.decision, count(*)::int as n from attendance_attempts a join s on s.id = a.session_id group by a.decision`.execute(db);

  // False rejects: a rejected scan from a student whose record for that class ended up
  // present, late or excused (they were there), over all scans from such students.
  const falseRejects = await sql<{ genuine_attempts: number; false_rejects: number; students_affected: number }>`
    with s as (${scope}),
    genuine as (
      select a.* from attendance_attempts a
      join s on s.id = a.session_id
      join attendance_records r on r.class_session_id = s.class_session_id and r.student_id = a.student_id
      where r.status in ('present','late','excused')
        and not (a.decision = 'rejected' and a.reason_codes && ${NOT_A_FALSE_REJECT}::text[])
    )
    select count(*)::int as genuine_attempts,
      count(*) filter (where decision = 'rejected')::int as false_rejects,
      count(distinct (student_id, session_id)) filter (where decision = 'rejected')::int as students_affected
    from genuine`.execute(db);

  const rejectCodes = await sql<{ code: string; n: number }>`
    with s as (${scope})
    select a.reason_codes[1] as code, count(*)::int as n
    from attendance_attempts a join s on s.id = a.session_id
    where a.decision = 'rejected' and array_length(a.reason_codes, 1) > 0
    group by 1 order by 2 desc`.execute(db);

  const flagReasons = await sql<{ code: string; n: number }>`
    with s as (${scope})
    select code, count(*)::int as n
    from attendance_attempts a join s on s.id = a.session_id, unnest(a.reason_codes) as code
    where a.decision in ('flagged','flagged_high')
    group by code order by n desc`.execute(db);

  // Scan to marked: the phone's clock at scan vs the server receiving it (includes the upload).
  const timing = await sql<{ n: number; median_ms: number | null; p90_ms: number | null }>`
    with s as (${scope}),
    d as (
      select extract(epoch from (a.received_at - a.device_time)) * 1000 as ms
      from attendance_attempts a join s on s.id = a.session_id
      where a.decision <> 'rejected' and not a.offline_queued and a.device_time is not null
    )
    select count(*)::int as n,
      percentile_cont(0.5) within group (order by ms) as median_ms,
      percentile_cont(0.9) within group (order by ms) as p90_ms
    from d where ms between 0 and ${MAX_SANE_DELAY_MS}`.execute(db);

  // Teacher time: from starting attendance until 90% of the class's accepted first-round scans are in.
  const teacher = await sql<{ n: number; median_s: number | null }>`
    with s as (${scope}),
    per as (
      select s.id, percentile_cont(0.9) within group (order by extract(epoch from (a.received_at - s.started_at))) as secs
      from s join attendance_attempts a on a.session_id = s.id
      join attendance_rounds r on r.id = a.round_id and r.round_no = 1
      where a.decision <> 'rejected'
      group by s.id
    )
    select count(*)::int as n, percentile_cont(0.5) within group (order by secs) as median_s from per`.execute(db);

  const support = await sql<{ n: number; approved: number; rejected: number; open: number }>`
    with s as (${scope})
    select count(*)::int as n,
      count(*) filter (where sr.status = 'approved')::int as approved,
      count(*) filter (where sr.status = 'rejected')::int as rejected,
      count(*) filter (where sr.status in ('pending','asked_teacher'))::int as open
    from support_requests sr join s on s.id = sr.attendance_session_id`.execute(db);

  const spot = await sql<{ recorded: number; confirmed: number; absent: number; no_response: number; not_recorded: number }>`
    with s as (${scope})
    select count(*) filter (where sc.result is not null)::int as recorded,
      count(*) filter (where sc.result = 'confirmed')::int as confirmed,
      count(*) filter (where sc.result = 'absent')::int as absent,
      count(*) filter (where sc.result = 'no_response')::int as no_response,
      count(*) filter (where sc.result is null)::int as not_recorded
    from spot_checks sc join s on s.id = sc.session_id`.execute(db);

  const flags = await sql<{ type: string; severity: string; n: number }>`
    with s as (${scope})
    select f.type, f.severity, count(*)::int as n from risk_flags f join s on s.id = f.session_id
    group by f.type, f.severity order by n desc`.execute(db);

  const days = await sql<{ date: string; sessions: number; attempts: number; rejected: number; support: number }>`
    with s as (${scope})
    select s.date::text as date, count(distinct s.id)::int as sessions,
      count(a.id)::int as attempts,
      count(a.id) filter (where a.decision = 'rejected')::int as rejected,
      (select count(*) from support_requests sr where sr.attendance_session_id in (select id from s s2 where s2.date = s.date))::int as support
    from s left join attendance_attempts a on a.session_id = s.id
    group by s.date order by s.date`.execute(db);

  const t = totals.rows[0] ?? { sessions: 0, shadow_sessions: 0, expected: 0, present: 0 };
  const fr = falseRejects.rows[0] ?? { genuine_attempts: 0, false_rejects: 0, students_affected: 0 };
  const tm = timing.rows[0] ?? { n: 0, median_ms: null, p90_ms: null };
  const tt = teacher.rows[0] ?? { n: 0, median_s: null };
  const sp = support.rows[0] ?? { n: 0, approved: 0, rejected: 0, open: 0 };
  const sc = spot.rows[0] ?? { recorded: 0, confirmed: 0, absent: 0, no_response: 0, not_recorded: 0 };
  const rate = (a: number, b: number) => (b > 0 ? a / b : null);
  const round = (x: number | null, d = 1) => (x === null ? null : Math.round(Number(x) * 10 ** d) / 10 ** d);

  const falseRejectRate = rate(fr.false_rejects, fr.genuine_attempts);
  const medianS = tm.median_ms === null ? null : Number(tm.median_ms) / 1000;
  const supportRate = rate(sp.n, t.expected);
  const teacherMin = tt.median_s === null ? null : Number(tt.median_s) / 60;
  const verdict = (value: number | null, target: number) => (value === null ? 'no_data' : value < target ? 'pass' : 'fail');

  return {
    from: q.from,
    to: q.to,
    shadow_mode: (await shadowMode(db)).on,
    totals: { sessions: t.sessions, shadow_sessions: t.shadow_sessions, expected_students: t.expected, marked_present: t.present },
    targets: [
      { key: 'false_reject_rate', label: 'False rejects', value: round(falseRejectRate === null ? null : falseRejectRate * 100, 2), unit: '%', target: TARGETS.false_reject_rate * 100, verdict: verdict(falseRejectRate, TARGETS.false_reject_rate), detail: `${fr.false_rejects} of ${fr.genuine_attempts} scans by students who were there (${fr.students_affected} students affected)` },
      { key: 'median_time_to_mark', label: 'Median time from scan to marked', value: round(medianS), unit: 's', target: TARGETS.median_time_to_mark_s, verdict: verdict(medianS, TARGETS.median_time_to_mark_s), detail: `${tm.n} scans; 90% within ${round(tm.p90_ms === null ? null : Number(tm.p90_ms) / 1000) ?? '–'} s. Uses the phone's clock, so treat it as approximate.` },
      { key: 'support_request_rate', label: 'Support requests', value: round(supportRate === null ? null : supportRate * 100, 2), unit: '%', target: TARGETS.support_request_rate * 100, verdict: verdict(supportRate, TARGETS.support_request_rate), detail: `${sp.n} requests for ${t.expected} expected students (${sp.approved} approved, ${sp.rejected} rejected, ${sp.open} open)` },
      { key: 'teacher_minutes', label: 'Teacher time on attendance', value: round(teacherMin), unit: 'min', target: TARGETS.teacher_minutes, verdict: verdict(teacherMin, TARGETS.teacher_minutes), detail: `Median time from starting attendance until 90% of first-round scans were in, over ${tt.n} classes` },
    ],
    decisions: Object.fromEntries(decisions.rows.map((d) => [d.decision, d.n])),
    reject_reasons: rejectCodes.rows,
    flag_reasons: flagReasons.rows,
    spot_checks: { ...sc, miss_rate: round(rate(sc.absent + sc.no_response, sc.recorded) === null ? null : rate(sc.absent + sc.no_response, sc.recorded)! * 100, 1) },
    risk_flags: flags.rows,
    days: days.rows,
  };
}
