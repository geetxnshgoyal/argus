import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, needAuth } from '../auth/guard.ts';
import type { AppContext } from '../context.ts';
import { ApiError } from '../errors.ts';
import { isoDate, parse, uuid } from '../validation.ts';
import { pilotMetrics, setShadowMode, shadowMode } from './service.ts';

/** Pilot support (spec §15 M8, ADR-0026). Acad Ops read; only admins switch shadow mode. */
export function registerPilotRoutes(app: FastifyInstance, ctx: AppContext): void {
  const ops = { preHandler: needAuth('acadops', 'admin') };
  const adminOnly = { preHandler: needAuth('admin') };

  app.get('/v1/admin/pilot/shadow-mode', ops, async () => shadowMode(ctx.db));

  app.put('/v1/admin/pilot/shadow-mode', adminOnly, async (req) => {
    const b = parse(z.object({ on: z.boolean() }), req.body);
    return setShadowMode(ctx, currentUser(req).id, b.on, req.ip);
  });

  app.get('/v1/admin/pilot/metrics', ops, async (req) => {
    const q = parse(z.object({ from: isoDate, to: isoDate, section_id: uuid.optional() }), req.query);
    if (q.from > q.to) throw new ApiError(400, 'validation_failed', '"From" must be on or before "to".');
    const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
    if (days > 370) throw new ApiError(400, 'validation_failed', 'Choose a range of a year or less.');
    return pilotMetrics(ctx, { from: q.from, to: q.to, sectionId: q.section_id });
  });
}
