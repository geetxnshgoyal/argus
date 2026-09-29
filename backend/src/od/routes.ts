import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, needAuth } from '../auth/guard.ts';
import type { AppContext } from '../context.ts';
import { idParams, isoDate, parse, uuid } from '../validation.ts';
import { answerIssue, cancelIssue, listIssues, opsIssueDecision, raiseIssue } from './issues.ts';
import { cancelOdRequest, createOdRequest, decideOdRequest, myOdRequests, odQueue } from './service.ts';

/** OD requests and student attendance issues (ADR-0027). */
export function registerOdRoutes(app: FastifyInstance, ctx: AppContext): void {
  const student = { preHandler: needAuth('student') };
  const teacher = { preHandler: needAuth('teacher') };
  const cm = { preHandler: needAuth('community_manager', 'admin') };
  const ops = { preHandler: needAuth('acadops', 'admin') };
  const limited = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  const odStatus = z.enum(['pending_cm', 'pending_ops', 'approved', 'rejected', 'cancelled', 'all']);
  const issueStatus = z.enum(['pending_teacher', 'pending_ops', 'resolved', 'declined', 'cancelled', 'all']);
  const newStatus = z.enum(['present', 'late', 'absent', 'excused']);
  const note = z.string().trim().max(500).nullable().optional();

  // ── Student ───────────────────────────────────────────────────────────────
  app.get('/v1/me/od-requests', student, async (req) => myOdRequests(ctx, currentUser(req).id));
  app.post('/v1/me/od-requests', { ...student, ...limited }, async (req, reply) => {
    const b = parse(
      z.object({
        kind: z.enum(['days', 'classes']),
        dates: z.array(isoDate).max(31).optional(),
        class_session_ids: z.array(uuid).max(60).optional(),
        event: z.string().trim().min(3, 'Name the event or duty').max(120),
        reason: z.string().trim().min(3, 'Please explain').max(500),
      }),
      req.body,
    );
    reply.status(201);
    return createOdRequest(ctx, currentUser(req).id, b, req.ip);
  });
  app.post('/v1/me/od-requests/:id/cancel', student, async (req) => cancelOdRequest(ctx, currentUser(req).id, parse(idParams, req.params).id, req.ip));

  app.get('/v1/me/attendance-issues', student, async (req) => listIssues(ctx, { studentId: currentUser(req).id }));
  app.post('/v1/me/attendance-issues', { ...student, ...limited }, async (req, reply) => {
    const b = parse(
      z.object({
        class_session_id: uuid,
        reason: z.enum(['marked_absent_but_present', 'marked_late_but_on_time', 'wrong_record', 'other']),
        note: z.string().trim().min(3, 'Please explain what happened').max(500),
      }),
      req.body,
    );
    reply.status(201);
    return raiseIssue(ctx, currentUser(req).id, b, req.ip);
  });
  app.post('/v1/me/attendance-issues/:id/cancel', student, async (req) => cancelIssue(ctx, currentUser(req).id, parse(idParams, req.params).id, req.ip));

  // ── Community manager (step 1 of OD) ──────────────────────────────────────
  app.get('/v1/community/od-requests', cm, async (req) => {
    const q = parse(z.object({ status: odStatus.default('pending_cm') }), req.query);
    return odQueue(ctx, q.status);
  });
  app.post('/v1/community/od-requests/:id/decision', cm, async (req) => {
    const b = parse(z.object({ decision: z.enum(['approve', 'reject']), note }), req.body);
    const u = currentUser(req);
    // An admin acting here takes the community manager's step.
    return decideOdRequest(ctx, { id: u.id, role: 'community_manager' }, parse(idParams, req.params).id, b.decision, b.note ?? null, req.ip);
  });

  // ── Acad Ops (step 2 of OD; issues without a teacher) ─────────────────────
  app.get('/v1/admin/od-requests', ops, async (req) => {
    const q = parse(z.object({ status: odStatus.default('pending_ops') }), req.query);
    return odQueue(ctx, q.status);
  });
  app.post('/v1/admin/od-requests/:id/decision', ops, async (req) => {
    const b = parse(z.object({ decision: z.enum(['approve', 'reject']), note }), req.body);
    return decideOdRequest(ctx, { id: currentUser(req).id, role: 'acadops' }, parse(idParams, req.params).id, b.decision, b.note ?? null, req.ip);
  });
  app.get('/v1/admin/attendance-issues', ops, async (req) => {
    const q = parse(z.object({ status: issueStatus.default('pending_ops') }), req.query);
    return listIssues(ctx, { status: q.status });
  });
  app.post('/v1/admin/attendance-issues/:id/decision', ops, async (req) => {
    const b = parse(z.object({ decision: z.enum(['correct', 'decline']), new_status: newStatus.optional(), note }), req.body);
    return opsIssueDecision(ctx, currentUser(req).id, parse(idParams, req.params).id, { decision: b.decision, new_status: b.new_status, note: b.note ?? null }, req.ip);
  });

  // ── Teacher ───────────────────────────────────────────────────────────────
  app.get('/v1/teacher/attendance-issues', teacher, async (req) => {
    const q = parse(z.object({ status: issueStatus.default('pending_teacher') }), req.query);
    return listIssues(ctx, { teacherId: currentUser(req).id, status: q.status });
  });
  app.post('/v1/teacher/attendance-issues/:id/answer', teacher, async (req) => {
    const b = parse(z.object({ decision: z.enum(['confirm', 'decline']), new_status: newStatus.optional(), note }), req.body);
    return answerIssue(ctx, currentUser(req).id, parse(idParams, req.params).id, { decision: b.decision, new_status: b.new_status, note: b.note ?? null }, req.ip);
  });
}
