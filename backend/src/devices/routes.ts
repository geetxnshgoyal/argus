import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { appendAudit } from '../audit/audit.ts';
import { currentUser, needAuth } from '../auth/guard.ts';
import type { AppContext } from '../context.ts';
import { ApiError } from '../errors.ts';
import { idParams, parse, uuid } from '../validation.ts';
import { bindDevice, decideRebind, myDevices, newBindChallenge, presentDevice, revokeDevice } from './service.ts';
import { assertFresh, payloadBytes, peekJson, signedBody, verifyAndParse } from './signed.ts';

const cancelPayload = z.object({ v: z.literal(1), action: z.literal('cancel_rebind'), device_id: uuid, request_id: uuid, ts: z.number().int() });
const lostPayload = z.object({ v: z.literal(1), action: z.literal('report_lost'), device_id: uuid, ts: z.number().int() });

export function registerDeviceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const student = { preHandler: needAuth('student') };
  const ops = { preHandler: needAuth('acadops', 'admin') };
  const limited = { ...student, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  app.post('/v1/devices/bind/challenge', limited, async (req) => newBindChallenge(ctx, currentUser(req).id));

  app.post('/v1/devices/bind', { ...limited, bodyLimit: 64 * 1024 }, async (req) => {
    const u = currentUser(req);
    return bindDevice(ctx, { id: u.id, tokenFamily: u.tokenFamily }, req.body, req.ip);
  });

  app.get('/v1/devices/me', student, async (req) => {
    const u = currentUser(req);
    return myDevices(ctx, { id: u.id, tokenFamily: u.tokenFamily });
  });

  /** "This wasn't me": the active (old) phone cancels a pending rebind (ADR-0007). */
  app.post('/v1/devices/rebind/cancel', limited, async (req) => {
    const u = currentUser(req);
    const b = parse(signedBody, req.body);
    const bytes = payloadBytes(b.payload);
    const deviceId = String(peekJson(bytes).device_id ?? '');
    const device = await ctx.db.selectFrom('devices').selectAll().where('id', '=', deviceId).where('user_id', '=', u.id).executeTakeFirst();
    if (!device || device.state !== 'active') throw new ApiError(403, 'device_not_active', 'Only your currently registered phone can cancel a phone change.');
    const p = verifyAndParse(bytes, b.signature, device.attempt_key_spki, cancelPayload);
    assertFresh(p.ts, ctx.now());
    return ctx.db.transaction().execute(async (tx) => {
      const r = await tx.selectFrom('device_rebind_requests').selectAll().where('id', '=', p.request_id).where('user_id', '=', u.id).forUpdate().executeTakeFirst();
      if (!r || r.status !== 'pending') throw new ApiError(404, 'not_found', 'There is no pending phone change to cancel.');
      await revokeDevice(ctx, u.id, r.new_device_id, 'cancelled_by_owner', req.ip, tx);
      await appendAudit(tx, { actorId: u.id, action: 'device.rebind_cancel', entityType: 'device', entityId: r.new_device_id, after: { request_id: r.id }, ip: req.ip }, new Date(ctx.now()));
      return { ok: true };
    });
  });

  /** From the new (pending) phone: the old phone is lost, revoke it now. The new one still waits (ADR-0007). */
  app.post('/v1/devices/report-lost', limited, async (req) => {
    const u = currentUser(req);
    const b = parse(signedBody, req.body);
    const bytes = payloadBytes(b.payload);
    const deviceId = String(peekJson(bytes).device_id ?? '');
    const device = await ctx.db.selectFrom('devices').selectAll().where('id', '=', deviceId).where('user_id', '=', u.id).executeTakeFirst();
    if (!device || device.state !== 'pending') throw new ApiError(403, 'forbidden', 'Report a lost phone from your new phone.');
    const p = verifyAndParse(bytes, b.signature, device.attempt_key_spki, lostPayload);
    assertFresh(p.ts, ctx.now());
    const active = await ctx.db.selectFrom('devices').select('id').where('user_id', '=', u.id).where('state', '=', 'active').executeTakeFirst();
    if (!active) return { ok: true };
    await revokeDevice(ctx, u.id, active.id, 'reported_lost', req.ip);
    return { ok: true };
  });

  // ── Acad Ops ──────────────────────────────────────────────────────────────
  app.get('/v1/admin/rebind-requests', ops, async (req) => {
    const q = parse(z.object({ status: z.enum(['pending', 'completed', 'approved', 'rejected', 'cancelled']).optional() }), req.query);
    let query = ctx.db
      .selectFrom('device_rebind_requests as r')
      .innerJoin('users as u', 'u.id', 'r.user_id')
      .leftJoin('students as s', 's.user_id', 'r.user_id')
      .innerJoin('devices as nd', 'nd.id', 'r.new_device_id')
      .leftJoin('devices as od', 'od.id', 'r.old_device_id')
      .leftJoin('users as dec', 'dec.id', 'r.decided_by')
      .select([
        'r.id', 'r.status', 'r.eligible_at', 'r.needs_approval', 'r.approval_reason', 'r.created_at', 'r.decided_at', 'r.decision_note',
        'u.id as user_id', 'u.name as student_name', 's.usn',
        'nd.model as new_model', 'nd.platform as new_platform', 'od.model as old_model', 'dec.name as decided_by_name',
      ])
      .orderBy('r.created_at', 'desc')
      .limit(200);
    if (q.status) query = query.where('r.status', '=', q.status);
    const rows = await query.execute();
    return {
      items: rows.map((r) => ({
        ...r,
        eligible_at: r.eligible_at?.toISOString() ?? null,
        created_at: r.created_at.toISOString(),
        decided_at: r.decided_at?.toISOString() ?? null,
      })),
    };
  });

  const decision = z.object({ note: z.string().trim().min(3, 'Please add a short note (e.g. "ID card checked")').max(300) });
  app.post('/v1/admin/rebind-requests/:id/approve', ops, async (req) => {
    const { id } = parse(idParams, req.params);
    return decideRebind(ctx, currentUser(req).id, id, 'approve', parse(decision, req.body).note, req.ip);
  });
  app.post('/v1/admin/rebind-requests/:id/reject', ops, async (req) => {
    const { id } = parse(idParams, req.params);
    return decideRebind(ctx, currentUser(req).id, id, 'reject', parse(decision, req.body).note, req.ip);
  });

  app.get('/v1/admin/devices', ops, async (req) => {
    const q = parse(z.object({ user_id: uuid }), req.query);
    const rows = await ctx.db.selectFrom('devices').selectAll().where('user_id', '=', q.user_id).orderBy('bound_at', 'desc').execute();
    return { items: rows.map(presentDevice) };
  });

  app.post('/v1/admin/devices/:id/revoke', ops, async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    return revokeDevice(ctx, currentUser(req).id, id, b.reason, req.ip);
  });
}
