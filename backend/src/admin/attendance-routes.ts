import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { appendAudit } from '../audit/audit.ts';
import { currentUser, needAuth } from '../auth/guard.ts';
import type { AppContext } from '../context.ts';
import { expectedStudents } from '../attendance/service.ts';
import { ApiError } from '../errors.ts';
import { REASON_TEXT } from '../risk/scorers.ts';
import { RISK_DEFAULTS, RISK_META } from '../risk/settings.ts';
import { presentSession, sessionsView, todayIn } from '../timetable/service.ts';
import { idParams, isoDate, parse } from '../validation.ts';

/**
 * Acad Ops views (spec §10–§11): attendance sessions browser, risk flag report,
 * and risk settings (ADR-0014: admins edit weights, kill switches, thresholds).
 */
export function registerAdminAttendanceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const ops = { preHandler: needAuth('acadops', 'admin') };
  const adminOnly = { preHandler: needAuth('admin') };

  app.get('/v1/admin/attendance/sessions', ops, async (req) => {
    const q = parse(z.object({ date: isoDate.optional() }), req.query);
    const date = q.date ?? todayIn(ctx);
    const rows = await sessionsView(ctx.db, ctx.config.timeZone)
      .innerJoin('attendance_sessions as a', 'a.class_session_id', 'cs.id')
      .leftJoin('users as sb', 'sb.id', 'a.started_by')
      .select(['a.id as attendance_session_id', 'a.status as attendance_status', 'a.started_at', 'a.ended_at', 'sb.name as started_by_name'])
      .where('cs.date', '=', date)
      .execute();
    const counts = rows.length
      ? await ctx.db
          .selectFrom('attendance_records')
          .select(['class_session_id', 'status', (eb) => eb.fn.countAll<string>().as('n')])
          .where('class_session_id', 'in', rows.map((r) => r.id))
          .groupBy(['class_session_id', 'status'])
          .execute()
      : [];
    return {
      date,
      items: rows.map((r) => {
        const c: Record<string, number> = { present: 0, late: 0, absent: 0, excused: 0, pending: 0 };
        for (const x of counts.filter((k) => k.class_session_id === r.id)) c[x.status] = Number(x.n);
        return {
          id: r.attendance_session_id,
          status: r.attendance_status,
          started_at: r.started_at.toISOString(),
          ended_at: r.ended_at?.toISOString() ?? null,
          started_by: r.started_by_name,
          class: presentSession(r),
          counts: c,
        };
      }),
    };
  });

  app.get('/v1/admin/attendance/sessions/:id', ops, async (req) => {
    const { id } = parse(idParams, req.params);
    const s = await ctx.db.selectFrom('attendance_sessions as a').leftJoin('users as u', 'u.id', 'a.started_by').selectAll('a').select('u.name as started_by_name').where('a.id', '=', id).executeTakeFirst();
    if (!s) throw new ApiError(404, 'not_found', 'Attendance session not found.');
    const cls = await sessionsView(ctx.db, ctx.config.timeZone).where('cs.id', '=', s.class_session_id).executeTakeFirstOrThrow();
    const [students, records, attempts, rounds, flags, spots, support, corrections] = await Promise.all([
      expectedStudents(ctx.db, s.class_session_id),
      ctx.db.selectFrom('attendance_records as r').leftJoin('users as u', 'u.id', 'r.updated_by').selectAll('r').select('u.name as updated_by_name').where('r.class_session_id', '=', s.class_session_id).execute(),
      ctx.db.selectFrom('attendance_attempts').select(['student_id', 'decision', 'reason_codes', 'received_at', 'risk_score']).where('session_id', '=', id).orderBy('received_at').execute(),
      ctx.db.selectFrom('attendance_rounds').selectAll().where('session_id', '=', id).orderBy('round_no').execute(),
      ctx.db.selectFrom('risk_flags').selectAll().where('session_id', '=', id).execute(),
      ctx.db.selectFrom('spot_checks').selectAll().where('session_id', '=', id).execute(),
      ctx.db.selectFrom('support_requests').select(['id', 'student_id', 'status', 'reason', 'decided_role']).where('attendance_session_id', '=', id).execute(),
      ctx.db.selectFrom('attendance_corrections').select(['id', 'student_id', 'status', 'new_status']).where('class_session_id', '=', s.class_session_id).execute(),
    ]);
    return {
      session: {
        id: s.id,
        status: s.status,
        started_at: s.started_at.toISOString(),
        ended_at: s.ended_at?.toISOString() ?? null,
        started_by: s.started_by_name,
        ended_automatically: s.status === 'ended' && !s.ended_by,
        headcount: s.headcount,
        class: presentSession(cls),
      },
      rounds: rounds.map((r) => ({ no: r.round_no, mode: r.mode, opened_at: r.opened_at.toISOString(), closed_at: r.closed_at?.toISOString() ?? null, targets: r.target_student_ids?.length ?? null })),
      students: students.map((st) => {
        const rec = records.find((r) => r.student_id === st.id);
        const mine = attempts.filter((a) => a.student_id === st.id);
        const last = mine[mine.length - 1];
        return {
          ...st,
          record: rec ? { status: rec.status, basis: rec.basis, updated_by: rec.updated_by_name, note: rec.note } : null,
          attempts: mine.length,
          last_attempt: last ? { decision: last.decision, reasons: last.reason_codes.map((c) => REASON_TEXT[c] ?? c.replace(/_/g, ' ')), at: last.received_at.toISOString(), score: last.risk_score } : null,
          flags: flags.filter((f) => f.student_id === st.id).map((f) => ({ type: f.type, text: REASON_TEXT[f.type] ?? f.type, severity: f.severity, resolution: f.resolution })),
          spot_checks: spots.filter((sp) => sp.student_id === st.id).map((sp) => ({ reason: sp.selected_reason, result: sp.result })),
          support: support.filter((sr) => sr.student_id === st.id).map((sr) => ({ id: sr.id, status: sr.status, decided_by: sr.decided_role })),
          corrections: corrections.filter((c) => c.student_id === st.id).map((c) => ({ id: c.id, status: c.status, new_status: c.new_status })),
        };
      }),
    };
  });

  // ── Risk flags report ─────────────────────────────────────────────────────
  app.get('/v1/admin/risk/flags', ops, async (req) => {
    const q = parse(z.object({ status: z.enum(['open', 'all']).default('open'), days: z.coerce.number().int().min(1).max(180).default(14) }), req.query);
    let query = ctx.db
      .selectFrom('risk_flags as f')
      .innerJoin('users as u', 'u.id', 'f.student_id')
      .leftJoin('students as st', 'st.user_id', 'f.student_id')
      .leftJoin('attendance_sessions as a', 'a.id', 'f.session_id')
      .leftJoin('class_sessions as cs', 'cs.id', 'a.class_session_id')
      .leftJoin('course_offerings as o', 'o.id', 'cs.offering_id')
      .leftJoin('subjects as s', 's.id', 'o.subject_id')
      .leftJoin('users as rb', 'rb.id', 'f.resolved_by')
      .select([
        'f.id', 'f.type', 'f.severity', 'f.created_at', 'f.resolved_at', 'f.resolution', 'f.session_id',
        'u.name as student_name', 'st.usn', 's.code as subject_code', 'cs.date', 'rb.name as resolved_by_name',
      ])
      .where('f.created_at', '>=', new Date(ctx.now() - q.days * 24 * 3600_000))
      .orderBy('f.created_at', 'desc')
      .limit(500);
    if (q.status === 'open') query = query.where('f.resolved_at', 'is', null);
    const rows = await query.execute();
    return { items: rows.map((r) => ({ ...r, text: REASON_TEXT[r.type] ?? r.type.replace(/_/g, ' '), created_at: r.created_at.toISOString(), resolved_at: r.resolved_at?.toISOString() ?? null })) };
  });

  app.post('/v1/admin/risk/flags/:id/resolve', ops, async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ resolution: z.string().trim().min(3, 'Please describe what you found').max(300) }), req.body);
    const u = currentUser(req);
    await ctx.db.transaction().execute(async (tx) => {
      const upd = await tx.updateTable('risk_flags').set({ resolved_by: u.id, resolved_at: new Date(ctx.now()), resolution: b.resolution }).where('id', '=', id).where('resolved_at', 'is', null).executeTakeFirst();
      if (upd.numUpdatedRows === 0n) throw new ApiError(409, 'already_resolved', 'This flag is already resolved.');
      await appendAudit(tx, { actorId: u.id, action: 'risk_flag.resolve', entityType: 'risk_flag', entityId: id, after: b, ip: req.ip }, new Date(ctx.now()));
    });
    return { ok: true };
  });

  // ── Risk settings (ADR-0014) ──────────────────────────────────────────────
  app.get('/v1/admin/risk-settings', ops, async () => {
    const rows = await ctx.db
      .selectFrom('risk_settings as r')
      .leftJoin('users as u', 'u.id', 'r.updated_by')
      .select(['r.key', 'r.kind', 'r.value', 'r.enabled', 'r.description', 'r.updated_at', 'u.name as updated_by_name'])
      .orderBy(sql`case r.kind when 'scorer' then 0 when 'threshold' then 1 else 2 end`)
      .orderBy('r.key')
      .execute();
    // Every known setting is listed; ones never saved show their built-in default.
    const known = Object.entries(RISK_META)
      .filter(([key]) => !rows.some((r) => r.key === key))
      .map(([key, m]) => ({ key, kind: m.kind, value: m.value, enabled: true, description: m.description, updated_at: null, updated_by_name: null }));
    const order = { scorer: 0, threshold: 1, setting: 2 } as const;
    return {
      items: [...rows.map((r) => ({ ...r, updated_at: r.updated_at.toISOString() })), ...known]
        .sort((a, b) => order[a.kind] - order[b.kind] || a.key.localeCompare(b.key))
        .map((r) => ({ ...r, default_value: RISK_DEFAULTS[r.key] ?? null })),
    };
  });

  app.patch('/v1/admin/risk-settings/:key', adminOnly, async (req) => {
    const { key } = parse(z.object({ key: z.string().regex(/^[a-z_]{3,60}$/) }), req.params);
    const b = parse(z.object({ value: z.number().int().min(0).max(1000).optional(), enabled: z.boolean().optional() }).refine((x) => x.value !== undefined || x.enabled !== undefined, 'Nothing to change'), req.body);
    const u = currentUser(req);
    const result = await ctx.db.transaction().execute(async (tx) => {
      let before = await tx.selectFrom('risk_settings').selectAll().where('key', '=', key).forUpdate().executeTakeFirst();
      if (!before) {
        const meta = RISK_META[key];
        if (!meta) throw new ApiError(404, 'not_found', 'Unknown setting.');
        before = await tx.insertInto('risk_settings').values({ key, kind: meta.kind, value: meta.value, description: meta.description }).returningAll().executeTakeFirstOrThrow();
      }
      if (b.enabled === false && before.kind !== 'scorer') throw new ApiError(400, 'validation_failed', 'Only signals can be switched off.');
      const after = await tx
        .updateTable('risk_settings')
        .set({ ...(b.value !== undefined ? { value: b.value } : {}), ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), updated_by: u.id, updated_at: new Date(ctx.now()) })
        .where('key', '=', key)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (after.kind === 'threshold') {
        const t = await tx.selectFrom('risk_settings').select(['key', 'value']).where('key', 'in', ['threshold_flagged', 'threshold_flagged_high']).execute();
        const flagged = t.find((x) => x.key === 'threshold_flagged')?.value ?? 30;
        const high = t.find((x) => x.key === 'threshold_flagged_high')?.value ?? 70;
        if (flagged >= high) throw new ApiError(400, 'validation_failed', 'The "flagged" threshold must be lower than the "flagged high" threshold.');
      }
      await appendAudit(tx, { actorId: u.id, action: 'risk_settings.update', entityType: 'risk_setting', entityId: key, before: { value: before.value, enabled: before.enabled }, after: { value: after.value, enabled: after.enabled }, ip: req.ip }, new Date(ctx.now()));
      return after;
    });
    ctx.risk.invalidate();
    return { ...result, updated_at: result.updated_at.toISOString() };
  });
}
