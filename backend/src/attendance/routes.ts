import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, needAuth } from '../auth/guard.ts';
import type { AppContext } from '../context.ts';
import { ApiError } from '../errors.ts';
import { todayIn } from '../timetable/service.ts';
import { idParams, parse, uuid } from '../validation.ts';
import { submitAttempt } from './attempts.ts';
import { createPairing, linkPairing, pairingState } from './display.ts';
import {
  activeForStudent,
  decideStudent,
  displayState,
  endAttendance,
  liveView,
  recordSpotCheck,
  setHeadcount,
  startAttendance,
  startRound,
  studentHistory,
  suggestSpotChecks,
} from './service.ts';

/**
 * Attendance API (spec §10; protocol §5).
 *   Teacher (web session): start, rounds, live panel (+ SSE), display link, spot checks, headcount, decisions, end.
 *   Display (no sign-in; holds an in-memory pairing secret): pairing and state.
 *   Student (app bearer token): active sessions, attempts, history.
 */
export function registerAttendanceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const teacher = { preHandler: needAuth('teacher') };
  const student = { preHandler: needAuth('student') };
  // Open live-panel streams, ended when the server shuts down.
  const streams = new Set<import('node:http').ServerResponse>();
  app.addHook('onClose', async () => {
    for (const s of streams) s.end();
    streams.clear();
  });
  const perUser = (max: number) => ({
    config: { rateLimit: { max, timeWindow: '1 minute', hook: 'preHandler' as const, keyGenerator: (req: FastifyRequest) => req.user?.id ?? req.ip } },
  });

  // ── Teacher ───────────────────────────────────────────────────────────────
  app.post('/v1/teacher/class-sessions/:id/attendance/start', teacher, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    reply.status(201);
    return startAttendance(ctx, id, currentUser(req).id, req.ip);
  });

  /** The teacher's attendance sessions for a day (default today), to show status on class cards. */
  app.get('/v1/teacher/attendance/sessions', teacher, async (req) => {
    const q = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.query);
    const date = q.date ?? todayIn(ctx);
    const rows = await ctx.db
      .selectFrom('attendance_sessions as a')
      .innerJoin('class_sessions as cs', 'cs.id', 'a.class_session_id')
      .select(['a.id', 'a.class_session_id', 'a.status', 'a.started_at', 'a.ended_at'])
      .where('a.started_by', '=', currentUser(req).id)
      .where('cs.date', '=', date)
      .orderBy('a.started_at')
      .execute();
    return { date, items: rows.map((r) => ({ ...r, started_at: r.started_at.toISOString(), ended_at: r.ended_at?.toISOString() ?? null })) };
  });

  app.get('/v1/attendance/sessions/:id/live', teacher, async (req) => {
    const { id } = parse(idParams, req.params);
    return liveView(ctx, id, currentUser(req).id);
  });

  /** Server-Sent Events: "changed" whenever an attempt, round or record changes; the page then refetches /live. */
  app.get('/v1/attendance/sessions/:id/events', teacher, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const s = await ctx.db.selectFrom('attendance_sessions').select(['started_by']).where('id', '=', id).executeTakeFirst();
    if (!s || s.started_by !== currentUser(req).id) throw new ApiError(404, 'not_found', 'Attendance session not found.');
    // Serverless (ADR-0020): no instance lives long enough, and events don't cross instances.
    // 204 tells EventSource to stop; the page polls instead.
    if (ctx.config.serverless) return reply.status(204).send();
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    res.write('retry: 3000\n\nevent: ready\ndata: {}\n\n');
    streams.add(res);
    let pending: NodeJS.Timeout | null = null;
    const unsubscribe = ctx.events.subscribe(id, (e) => {
      // Coalesce bursts (a whole class scanning at once) into one message per 300 ms.
      if (e.type === 'ended') res.write('event: ended\ndata: {}\n\n');
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        res.write(`event: changed\ndata: ${JSON.stringify({ type: e.type })}\n\n`);
      }, 300);
    });
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 20_000);
    req.raw.on('close', () => {
      streams.delete(res);
      clearInterval(heartbeat);
      if (pending) clearTimeout(pending);
      unsubscribe();
    });
  });

  app.post('/v1/attendance/sessions/:id/rounds', teacher, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ mode: z.enum(['targeted', 'full', 'end']).default('targeted') }), req.body ?? {});
    reply.status(201);
    return startRound(ctx, id, currentUser(req).id, b.mode, req.ip);
  });

  app.post('/v1/attendance/sessions/:id/end', teacher, async (req) => {
    const { id } = parse(idParams, req.params);
    return endAttendance(ctx, id, { teacherId: currentUser(req).id }, req.ip);
  });

  app.post('/v1/attendance/sessions/:id/display', { ...teacher, ...perUser(20) }, async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ code: z.string().trim().min(4).max(12) }), req.body);
    return linkPairing(ctx, currentUser(req).id, id, b.code, req.ip);
  });

  /** The teacher's own browser acting as the display (no pairing code needed). */
  app.get('/v1/attendance/sessions/:id/display', teacher, async (req) => {
    const { id } = parse(idParams, req.params);
    const s = await ctx.db.selectFrom('attendance_sessions').select(['started_by']).where('id', '=', id).executeTakeFirst();
    if (!s || s.started_by !== currentUser(req).id) throw new ApiError(404, 'not_found', 'Attendance session not found.');
    return displayState(ctx, id);
  });

  app.post('/v1/attendance/sessions/:id/headcount', teacher, async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ headcount: z.number().int().min(0).max(1000) }), req.body);
    return setHeadcount(ctx, id, currentUser(req).id, b.headcount, req.ip);
  });

  app.post('/v1/attendance/sessions/:id/spot-checks/suggest', teacher, async (req) => {
    const { id } = parse(idParams, req.params);
    return suggestSpotChecks(ctx, id, currentUser(req).id, req.ip);
  });

  app.post('/v1/attendance/sessions/:id/spot-checks', teacher, async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ spot_check_id: uuid, result: z.enum(['confirmed', 'absent', 'no_response']) }), req.body);
    return recordSpotCheck(ctx, id, currentUser(req).id, b.spot_check_id, b.result, req.ip);
  });

  app.post('/v1/attendance/sessions/:id/students/:student_id/decision', teacher, async (req) => {
    const p = parse(z.object({ id: uuid, student_id: uuid }), req.params);
    const b = parse(z.object({ status: z.enum(['present', 'absent']), note: z.string().trim().max(300).nullable().optional() }), req.body);
    return decideStudent(ctx, p.id, currentUser(req).id, p.student_id, b.status, b.note ?? null, req.ip);
  });

  // ── Display ───────────────────────────────────────────────────────────────
  const displayLimit = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
  app.post('/v1/display/pairings', displayLimit, async (req, reply) => {
    const b = parse(z.object({ secret_hash: z.string() }), req.body);
    reply.status(201);
    return createPairing(ctx, b.secret_hash);
  });

  app.post('/v1/display/pairings/:id/state', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }), req.body);
    return pairingState(ctx, id, b.secret);
  });

  // ── Student ───────────────────────────────────────────────────────────────
  app.get('/v1/me/sessions/active', student, async (req) => activeForStudent(ctx, currentUser(req).id));

  app.post('/v1/attendance/attempts', { ...student, ...perUser(10), bodyLimit: 48 * 1024 }, async (req) => submitAttempt(ctx, currentUser(req).id, req.body, req.ip));

  app.get('/v1/me/attendance', student, async (req) => studentHistory(ctx, currentUser(req).id));

}
