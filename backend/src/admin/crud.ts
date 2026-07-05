import type { FastifyInstance } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import { z, type ZodType } from 'zod';
import { appendAudit } from '../audit/audit.ts';
import { currentUser, needAuth } from '../auth/guard.ts';
import type { AppContext } from '../context.ts';
import { mapDbError } from '../db/errors.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../platform/ids.ts';
import { idParams, parse } from '../validation.ts';

/* eslint-disable @typescript-eslint/no-explicit-any -- generic over table names */
type AnyDb = Kysely<any>;
type AnyTx = Transaction<any>;

export interface ResourceDef {
  /** URL segment under /v1/admin/ */
  path: string;
  table: string;
  /** Optional view used for list/get (e.g. with human-readable labels); writes always use `table`. */
  readTable?: string;
  entityType: string;
  create: ZodType<Record<string, unknown>>;
  update: ZodType<Record<string, unknown>>;
  /** Query-string filters allowed on list: param name → column. */
  filters?: Record<string, string>;
  /** Columns searched by ?q= (case-insensitive contains). */
  search?: string[];
  orderBy: string[];
  /** Extra cross-row checks run inside the write transaction. */
  check?: (tx: AnyTx, row: Record<string, unknown>) => Promise<void>;
  /** Converts values for storage (e.g. JSON columns). */
  toDb?: (row: Record<string, unknown>) => Record<string, unknown>;
}

const listQuery = z.object({
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export function registerCrud(app: FastifyInstance, ctx: AppContext, def: ResourceDef): void {
  const db = ctx.db as unknown as AnyDb;
  const base = `/v1/admin/${def.path}`;
  const guard = { preHandler: needAuth('acadops', 'admin') };
  const toDb = def.toDb ?? ((r) => r);
  const readTable = def.readTable ?? def.table;

  app.get(base, guard, async (req) => {
    const raw = req.query as Record<string, unknown>;
    const q = parse(listQuery, raw);
    let query = db.selectFrom(readTable);
    for (const [param, column] of Object.entries(def.filters ?? {})) {
      const v = raw[param];
      if (typeof v === 'string' && v.length > 0) {
        parse(z.string().uuid(), v);
        query = query.where(column, '=', v);
      }
    }
    if (q.q && def.search?.length) {
      const term = `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      query = query.where((eb) => eb.or(def.search!.map((c) => eb(c, 'ilike', term))));
    }
    const [{ total }] = (await query.select((eb) => eb.fn.countAll<string>().as('total')).execute()) as [{ total: string }];
    let rows = query.selectAll();
    for (const c of def.orderBy) rows = rows.orderBy(c);
    const items = await rows.limit(q.limit).offset(q.offset).execute();
    return { items, total: Number(total) };
  });

  app.get(`${base}/:id`, guard, async (req) => {
    const { id } = parse(idParams, req.params);
    const row = await db.selectFrom(readTable).selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new ApiError(404, 'not_found', 'Not found');
    return row;
  });

  app.post(base, guard, async (req, reply) => {
    const u = currentUser(req);
    const data = parse(def.create, req.body);
    const row = { id: uuidv7(ctx.now()), ...data };
    try {
      const created = await db.transaction().execute(async (tx) => {
        await def.check?.(tx, row);
        const r = await tx.insertInto(def.table).values(toDb(row)).returningAll().executeTakeFirstOrThrow();
        await appendAudit(tx, { actorId: u.id, action: `${def.entityType}.create`, entityType: def.entityType, entityId: row.id, after: r, ip: req.ip }, new Date(ctx.now()));
        return r;
      });
      return reply.status(201).send(created);
    } catch (err) {
      mapDbError(err, 'create');
    }
  });

  app.patch(`${base}/:id`, guard, async (req) => {
    const u = currentUser(req);
    const { id } = parse(idParams, req.params);
    const patch = parse(def.update, req.body);
    if (Object.keys(patch).length === 0) throw new ApiError(400, 'validation_failed', 'Nothing to change.');
    try {
      return await db.transaction().execute(async (tx) => {
        const before = await tx.selectFrom(def.table).selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!before) throw new ApiError(404, 'not_found', 'Not found');
        await def.check?.(tx, { ...before, ...patch });
        const after = await tx.updateTable(def.table).set(toDb(patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
        await appendAudit(tx, { actorId: u.id, action: `${def.entityType}.update`, entityType: def.entityType, entityId: id, before, after, ip: req.ip }, new Date(ctx.now()));
        return after;
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      mapDbError(err, 'update');
    }
  });

  app.delete(`${base}/:id`, guard, async (req, reply) => {
    const u = currentUser(req);
    const { id } = parse(idParams, req.params);
    try {
      await db.transaction().execute(async (tx) => {
        const before = await tx.deleteFrom(def.table).where('id', '=', id).returningAll().executeTakeFirst();
        if (!before) throw new ApiError(404, 'not_found', 'Not found');
        await appendAudit(tx, { actorId: u.id, action: `${def.entityType}.delete`, entityType: def.entityType, entityId: id, before, ip: req.ip }, new Date(ctx.now()));
      });
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      mapDbError(err, 'delete');
    }
  });
}
