import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { appendAudit, verifyAuditChain } from '../audit/audit.ts';
import { currentUser, needAuth } from '../auth/guard.ts';
import type { AppContext } from '../context.ts';
import { parse, uuid } from '../validation.ts';

const query = z.object({
  entity_type: z.string().max(50).optional(),
  entity_id: z.string().max(100).optional(),
  actor_id: uuid.optional(),
  action: z.string().max(80).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  before_id: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export function registerAuditRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: needAuth('acadops', 'admin') };

  app.get('/v1/admin/audit', guard, async (req) => {
    const q = parse(query, req.query);
    let s = ctx.db.selectFrom('audit_log as a').leftJoin('users as u', 'u.id', 'a.actor_id');
    if (q.entity_type) s = s.where('a.entity_type', '=', q.entity_type);
    if (q.entity_id) s = s.where('a.entity_id', '=', q.entity_id);
    if (q.actor_id) s = s.where('a.actor_id', '=', q.actor_id);
    if (q.action) s = s.where('a.action', 'like', `${q.action.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    if (q.from) s = s.where('a.at', '>=', new Date(q.from));
    if (q.to) s = s.where('a.at', '<', new Date(q.to));
    if (q.before_id) s = s.where(sql<boolean>`a.id < ${q.before_id}::bigint`);
    const items = await s
      .select(['a.id', 'a.at', 'a.actor_id', 'u.name as actor_name', 'u.role as actor_role', 'a.action', 'a.entity_type', 'a.entity_id', 'a.before', 'a.after', 'a.ip', 'a.hash'])
      .orderBy('a.id', 'desc')
      .limit(q.limit)
      .execute();
    return { items: items.map((i) => ({ ...i, id: String(i.id) })), next_before_id: items.length === q.limit ? String(items.at(-1)?.id) : null };
  });

  app.post('/v1/admin/audit/verify', guard, async (req) => {
    const u = currentUser(req);
    const result = await verifyAuditChain(ctx.db);
    await ctx.db.transaction().execute((tx) =>
      appendAudit(tx, { actorId: u.id, action: 'audit.verify', entityType: 'audit_log', after: { ok: result.ok, checked: result.checked, problem: result.problem ?? null }, ip: req.ip }, new Date(ctx.now())),
    );
    return result;
  });
}
