import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, needAuth } from '../auth/guard.ts';
import type { AppContext } from '../context.ts';
import { idParams, parse, uuid } from '../validation.ts';
import { decideCorrection, listCorrections, requestCorrection } from './corrections.ts';
import {
  createSupportRequest,
  getMySupportRequest,
  listForVerifier,
  mySupportRequests,
  teacherConfirmation,
  teacherQuestions,
  verifierDecision,
  verifierDetail,
} from './service.ts';

/** Support requests, verifier console, teacher confirmations and corrections (spec §7, §10). */
export function registerSupportRoutes(app: FastifyInstance, ctx: AppContext): void {
  const student = { preHandler: needAuth('student') };
  const verifier = { preHandler: needAuth('verifier', 'admin') };
  const teacher = { preHandler: needAuth('teacher') };
  const ops = { preHandler: needAuth('acadops', 'admin') };
  const perUser = (max: number) => ({
    config: { rateLimit: { max, timeWindow: '1 minute', hook: 'preHandler' as const, keyGenerator: (req: FastifyRequest) => req.user?.id ?? req.ip } },
  });

  // ── Student ───────────────────────────────────────────────────────────────
  app.post('/v1/support-requests', { ...student, ...perUser(5), bodyLimit: 48 * 1024 }, async (req, reply) => {
    reply.status(201);
    return createSupportRequest(ctx, currentUser(req).id, req.body, req.ip);
  });
  app.get('/v1/me/support-requests', student, async (req) => mySupportRequests(ctx, currentUser(req).id));
  app.get('/v1/support-requests/:id', student, async (req) => getMySupportRequest(ctx, currentUser(req).id, parse(idParams, req.params).id));

  // ── Verifier ──────────────────────────────────────────────────────────────
  app.get('/v1/verifier/support-requests', verifier, async (req) => {
    const q = parse(z.object({ status: z.enum(['open', 'all', 'pending', 'asked_teacher', 'approved', 'rejected', 'expired']).default('open') }), req.query);
    return listForVerifier(ctx, q.status);
  });
  app.get('/v1/verifier/support-requests/:id', verifier, async (req) => verifierDetail(ctx, currentUser(req).id, parse(idParams, req.params).id, req.ip));
  app.post('/v1/verifier/support-requests/:id/decision', verifier, async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ action: z.enum(['approve', 'ask_teacher', 'reject']), reason: z.string().trim().max(300).nullable().optional() }), req.body);
    return verifierDecision(ctx, currentUser(req).id, id, b.action, b.reason ?? null, req.ip);
  });

  // ── Teacher ───────────────────────────────────────────────────────────────
  app.get('/v1/teacher/support-requests', teacher, async (req) => {
    const q = parse(z.object({ attendance_session_id: uuid.optional() }), req.query);
    return teacherQuestions(ctx, currentUser(req).id, q.attendance_session_id);
  });
  app.post('/v1/support-requests/:id/teacher-confirmation', teacher, async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ answer: z.enum(['present', 'absent', 'not_sure']) }), req.body);
    return teacherConfirmation(ctx, currentUser(req).id, id, b.answer, req.ip);
  });

  // ── Corrections (two people) ───────────────────────────────────────────────
  const correctionInput = z.object({
    student_id: uuid,
    class_session_id: uuid,
    new_status: z.enum(['present', 'late', 'absent', 'excused']),
    reason: z.string().trim().min(3, 'Please explain why').max(300),
  });
  app.post('/v1/teacher/attendance/corrections', teacher, async (req, reply) => {
    const u = currentUser(req);
    reply.status(201);
    return requestCorrection(ctx, { id: u.id, role: u.role }, parse(correctionInput, req.body), req.ip);
  });
  app.post('/v1/admin/attendance/corrections', ops, async (req, reply) => {
    const u = currentUser(req);
    reply.status(201);
    return requestCorrection(ctx, { id: u.id, role: u.role }, parse(correctionInput, req.body), req.ip);
  });
  app.get('/v1/admin/attendance/corrections', ops, async (req) => {
    const q = parse(z.object({ status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending') }), req.query);
    return listCorrections(ctx, q.status, currentUser(req).id);
  });
  app.post('/v1/admin/attendance/corrections/:id/approve', ops, async (req) => {
    const b = parse(z.object({ note: z.string().trim().max(300).nullable().optional() }), req.body ?? {});
    return decideCorrection(ctx, currentUser(req).id, parse(idParams, req.params).id, 'approve', b.note ?? null, req.ip);
  });
  app.post('/v1/admin/attendance/corrections/:id/reject', ops, async (req) => {
    const b = parse(z.object({ note: z.string().trim().max(300) }), req.body);
    return decideCorrection(ctx, currentUser(req).id, parse(idParams, req.params).id, 'reject', b.note, req.ip);
  });
}
