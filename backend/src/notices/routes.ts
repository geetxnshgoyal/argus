import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { appendAudit } from '../audit/audit.ts';
import { currentUser, needAuth } from '../auth/guard.ts';
import type { AppContext } from '../context.ts';
import { ApiError } from '../errors.ts';
import { idParams, parse, uuid } from '../validation.ts';
import { noticePush, pushToUsers } from '../notify/push.ts';
import { audienceSchema, listForOps, markRead, myNotices, postNotice, resolveAudience, withdrawNotice } from './service.ts';

const noticeInput = z.object({
  title: z.string().trim().min(3, 'Please add a short title').max(120),
  body: z.string().trim().max(2000).default(''),
  audience: audienceSchema,
});

/** Notices from Academic Operations (ADR-0023). */
export function registerNoticeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const signedIn = { preHandler: needAuth() };
  const ops = { preHandler: needAuth('acadops', 'admin') };
  const at = () => new Date(ctx.now());

  // ── Students (app) and teachers (web) ───────────────────────────────────────
  app.get('/v1/me/notices', signedIn, async (req) => myNotices(ctx, currentUser(req).id));
  app.post('/v1/me/notices/read', signedIn, async (req, reply) => {
    const b = parse(z.object({ ids: z.array(uuid).max(200).optional() }), req.body ?? {});
    await markRead(ctx, currentUser(req).id, b.ids);
    return reply.status(204).send();
  });

  // Phone notification address for this app install (ADR-0025). A token moves to whoever signs in last.
  const tokenBody = z.object({ token: z.string().min(20).max(4096), platform: z.enum(['android', 'ios']) });
  app.post('/v1/me/push-token', { preHandler: needAuth('student', 'teacher') }, async (req, reply) => {
    const b = parse(tokenBody, req.body);
    const at = new Date(ctx.now());
    await ctx.db
      .insertInto('push_tokens')
      .values({ token: b.token, user_id: currentUser(req).id, platform: b.platform, created_at: at, last_seen_at: at })
      .onConflict((oc) => oc.column('token').doUpdateSet({ user_id: currentUser(req).id, platform: b.platform, last_seen_at: at }))
      .execute();
    return reply.status(204).send();
  });
  app.post('/v1/me/push-token/remove', signedIn, async (req, reply) => {
    const b = parse(z.object({ token: z.string().min(1).max(4096) }), req.body);
    await ctx.db.deleteFrom('push_tokens').where('token', '=', b.token).where('user_id', '=', currentUser(req).id).execute();
    return reply.status(204).send();
  });

  // ── Acad Ops ─────────────────────────────────────────────────────────────────
  app.get('/v1/admin/notices', ops, async () => listForOps(ctx));

  app.post('/v1/admin/notices/audience', ops, async (req) => {
    const r = await resolveAudience(ctx.db, parse(z.object({ audience: audienceSchema }), req.body).audience);
    return { label: r.label, students: r.students.length, teachers: r.teachers.length };
  });

  app.post('/v1/admin/notices', ops, async (req, reply) => {
    const u = currentUser(req);
    const b = parse(noticeInput, req.body);
    const created = await ctx.db.transaction().execute(async (tx) => {
      const reach = await resolveAudience(tx, b.audience);
      const recipients = [...reach.students, ...reach.teachers];
      if (!recipients.length) throw new ApiError(400, 'no_recipients', 'Nobody is in this audience yet.');
      const n = await postNotice(tx, ctx, { kind: 'announcement', title: b.title, body: b.body, audience: b.audience, label: reach.label, recipients, createdBy: u.id });
      await appendAudit(tx, { actorId: u.id, action: 'notice.post', entityType: 'notice', entityId: n.id, after: { title: b.title, audience: reach.label, recipients: n.recipients }, ip: req.ip }, at());
      return { n, out: { id: n.id, recipients: n.recipients, students: reach.students.length, teachers: reach.teachers.length } };
    });
    ctx.background(pushToUsers(ctx, created.n.users, noticePush(created.n)));
    return reply.status(201).send(created.out);
  });

  app.delete('/v1/admin/notices/:id', ops, async (req, reply) => {
    const u = currentUser(req);
    const { id } = parse(idParams, req.params);
    await ctx.db.transaction().execute(async (tx) => {
      const n = await withdrawNotice(tx, ctx, id, u.id);
      if (!n) throw new ApiError(404, 'not_found', 'Not found');
      await appendAudit(tx, { actorId: u.id, action: 'notice.withdraw', entityType: 'notice', entityId: id, before: { title: n.title }, ip: req.ip }, at());
    });
    return reply.status(204).send();
  });
}
