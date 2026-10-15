import type { FastifyInstance } from 'fastify';
import { currentUser, needAuth } from '../auth/guard.ts';
import type { AppContext } from '../context.ts';
import { ApiError } from '../errors.ts';
import { expectedStudents, loadClass } from '../attendance/service.ts';
import { idParams, parse } from '../validation.ts';
import { addScans, demoClassNow, demoDevices } from './seed.ts';

/**
 * Demo-only helpers (ARGUS_DEMO): a class to try right now, and students "scanning" it,
 * since a prospect has no class of phones at hand. Not registered on real deployments.
 */
export function registerDemoRoutes(app: FastifyInstance, ctx: AppContext): void {
  if (!ctx.config.demo) return;

  app.post('/v1/demo/class-now', { preHandler: needAuth('teacher') }, async (req) => {
    return { class_session_id: await demoClassNow(ctx, currentUser(req).id) };
  });

  // Most of the class scans on the first press; the next press brings the stragglers, and a
  // couple of students never turn up.
  app.post('/v1/demo/attendance-sessions/:id/simulate', { preHandler: needAuth('teacher') }, async (req) => {
    const { id } = parse(idParams, req.params);
    const s = await ctx.db.selectFrom('attendance_sessions').select(['class_session_id', 'started_by', 'status']).where('id', '=', id).executeTakeFirst();
    if (!s || s.started_by !== currentUser(req).id) throw new ApiError(404, 'not_found', 'Attendance session not found.');
    if (s.status !== 'active') throw new ApiError(409, 'session_ended', 'Attendance has already ended.');
    const expected = await expectedStudents(ctx.db, s.class_session_id);
    const marked = new Set(
      (await ctx.db.selectFrom('attendance_records').select('student_id').where('class_session_id', '=', s.class_session_id).execute()).map((r) => r.student_id),
    );
    const absentees = new Set(expected.slice(-2).map((e) => e.id));
    const waiting = expected.filter((e) => !marked.has(e.id) && !absentees.has(e.id)).map((e) => e.id);
    const batch = marked.size === 0 ? waiting.slice(0, Math.ceil(waiting.length * 0.75)) : waiting;
    const cls = await loadClass(ctx.db, s.class_session_id);
    const room = cls?.room_id ? (await ctx.db.selectFrom('rooms').select('code').where('id', '=', cls.room_id).executeTakeFirst())?.code : undefined;
    const added = await addScans(ctx, id, batch, await demoDevices(ctx, batch), Math.random, { roomCode: room ?? 'Room 101' });
    return { added, remaining: Math.max(0, waiting.length - batch.length) };
  });
}
