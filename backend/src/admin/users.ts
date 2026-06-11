import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { appendAudit } from '../audit/audit.ts';
import { assertRecentAuth, currentUser, needAuth } from '../auth/guard.ts';
import { revokeAllUserSessions } from '../auth/sessions.ts';
import type { AppContext } from '../context.ts';
import type { Tx } from '../db/index.ts';
import { mapDbError } from '../db/errors.ts';
import { ROLES, type Role } from '../db/schema.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../platform/ids.ts';
import { idParams, parse, uuid } from '../validation.ts';

const STAFF_ROLES: Role[] = ['acadops', 'verifier', 'admin'];

const studentProfile = z.object({
  usn: z.string().trim().min(3).max(30),
  program_id: uuid,
  section_id: uuid.nullable().optional(),
  group_id: uuid.nullable().optional(),
  admission_year: z.number().int().min(1990).max(2100),
});
const teacherProfile = z.object({ faculty_id: z.string().trim().min(1).max(30), department_id: uuid });

function emailSchema(ctx: AppContext) {
  const domain = ctx.config.oidc.hostedDomain;
  return z
    .string()
    .trim()
    .toLowerCase()
    .email()
    .refine((e) => !domain || e.endsWith(`@${domain}`), `Must be an @${domain ?? ''} address`);
}

const listQuery = z.object({
  role: z.enum(ROLES as [Role, ...Role[]]).optional(),
  q: z.string().max(100).optional(),
  section_id: uuid.optional(),
  status: z.enum(['active', 'disabled']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

async function loadUser(tx: Tx | AppContext['db'], id: string) {
  return tx
    .selectFrom('users as u')
    .leftJoin('students as s', 's.user_id', 'u.id')
    .leftJoin('teachers as t', 't.user_id', 'u.id')
    .select([
      'u.id', 'u.role', 'u.name', 'u.email', 'u.status', 'u.created_at', 'u.updated_at',
      (eb) => eb('u.sso_subject', 'is not', null).as('sso_linked'),
      's.usn', 's.program_id', 's.section_id', 's.group_id', 's.admission_year',
      't.faculty_id', 't.department_id',
    ])
    .where('u.id', '=', id)
    .executeTakeFirst();
}

async function upsertStudent(tx: Tx, userId: string, p: z.infer<typeof studentProfile>) {
  if (p.group_id && !p.section_id) throw new ApiError(400, 'invalid_group', 'Choose a section before choosing a batch.');
  await tx
    .insertInto('students')
    .values({ user_id: userId, usn: p.usn, program_id: p.program_id, section_id: p.section_id ?? null, group_id: p.group_id ?? null, admission_year: p.admission_year })
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet({ usn: p.usn, program_id: p.program_id, section_id: p.section_id ?? null, group_id: p.group_id ?? null, admission_year: p.admission_year }),
    )
    .execute();
}

export function registerUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = needAuth('acadops', 'admin');
  const email = emailSchema(ctx);

  /** Granting or changing staff roles is an admin-only, recently-authenticated action. */
  function checkRoleChange(req: FastifyRequest, from: Role | null, to: Role) {
    const u = currentUser(req);
    const touchesStaff = STAFF_ROLES.includes(to) || (from !== null && STAFF_ROLES.includes(from));
    if (touchesStaff || (from !== null && from !== to)) {
      if (u.role !== 'admin') throw new ApiError(403, 'forbidden', 'Only an administrator can grant or change staff roles.');
      assertRecentAuth(ctx, req);
    }
  }

  app.get('/v1/admin/users', { preHandler: guard }, async (req) => {
    const q = parse(listQuery, req.query);
    let query = ctx.db.selectFrom('users as u').leftJoin('students as s', 's.user_id', 'u.id').leftJoin('teachers as t', 't.user_id', 'u.id');
    if (q.role) query = query.where('u.role', '=', q.role);
    if (q.status) query = query.where('u.status', '=', q.status);
    if (q.section_id) query = query.where('s.section_id', '=', q.section_id);
    if (q.q) {
      const term = `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      query = query.where((eb) => eb.or([eb('u.name', 'ilike', term), eb('u.email', 'ilike', term), eb('s.usn', 'ilike', term), eb('t.faculty_id', 'ilike', term)]));
    }
    const { total } = await query.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow();
    const items = await query
      .select([
        'u.id', 'u.role', 'u.name', 'u.email', 'u.status',
        (eb) => eb('u.sso_subject', 'is not', null).as('sso_linked'),
        's.usn', 's.program_id', 's.section_id', 's.group_id', 's.admission_year', 't.faculty_id', 't.department_id',
      ])
      .orderBy('u.role')
      .orderBy('s.usn')
      .orderBy('u.name')
      .limit(q.limit)
      .offset(q.offset)
      .execute();
    return { items, total: Number(total) };
  });

  app.get('/v1/admin/users/:id', { preHandler: guard }, async (req) => {
    const { id } = parse(idParams, req.params);
    const u = await loadUser(ctx.db, id);
    if (!u) throw new ApiError(404, 'not_found', 'Not found');
    return u;
  });

  app.post('/v1/admin/users', { preHandler: guard }, async (req, reply) => {
    const actor = currentUser(req);
    const b = parse(
      z.object({
        role: z.enum(ROLES as [Role, ...Role[]]),
        name: z.string().trim().min(1).max(200),
        email,
        status: z.enum(['active', 'disabled']).optional(),
        student: studentProfile.optional(),
        teacher: teacherProfile.optional(),
      }),
      req.body,
    );
    checkRoleChange(req, null, b.role);
    if (b.role === 'student' && !b.student) throw new ApiError(400, 'validation_failed', 'Student details are required.', { fields: { student: 'Required' } });
    if (b.role === 'teacher' && !b.teacher) throw new ApiError(400, 'validation_failed', 'Teacher details are required.', { fields: { teacher: 'Required' } });
    const id = uuidv7(ctx.now());
    try {
      const created = await ctx.db.transaction().execute(async (tx) => {
        await tx.insertInto('users').values({ id, role: b.role, name: b.name, email: b.email, status: b.status ?? 'active' }).execute();
        if (b.role === 'student' && b.student) await upsertStudent(tx, id, b.student);
        if (b.role === 'teacher' && b.teacher) await tx.insertInto('teachers').values({ user_id: id, ...b.teacher }).execute();
        const after = await loadUser(tx, id);
        await appendAudit(tx, { actorId: actor.id, action: 'user.create', entityType: 'user', entityId: id, after, ip: req.ip }, new Date(ctx.now()));
        return after;
      });
      return reply.status(201).send(created);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      mapDbError(err, 'create');
    }
  });

  app.patch('/v1/admin/users/:id', { preHandler: guard }, async (req) => {
    const actor = currentUser(req);
    const { id } = parse(idParams, req.params);
    const b = parse(
      z.object({
        role: z.enum(ROLES as [Role, ...Role[]]).optional(),
        name: z.string().trim().min(1).max(200).optional(),
        email: email.optional(),
        status: z.enum(['active', 'disabled']).optional(),
        reset_sso: z.literal(true).optional(),
        student: studentProfile.optional(),
        teacher: teacherProfile.optional(),
      }),
      req.body,
    );
    const before = await loadUser(ctx.db, id);
    if (!before) throw new ApiError(404, 'not_found', 'Not found');
    if (actor.id === id && b.status === 'disabled') throw new ApiError(400, 'cannot_disable_self', 'You cannot disable your own account.');
    const nextRole = b.role ?? before.role;
    if (b.role) checkRoleChange(req, before.role, b.role);
    else if (STAFF_ROLES.includes(before.role) && actor.role !== 'admin') {
      throw new ApiError(403, 'forbidden', 'Only an administrator can change staff accounts.');
    }
    try {
      const after = await ctx.db.transaction().execute(async (tx) => {
        const set: Record<string, unknown> = {};
        if (b.role) set.role = b.role;
        if (b.name) set.name = b.name;
        if (b.email) set.email = b.email;
        if (b.status) set.status = b.status;
        if (b.reset_sso) set.sso_subject = null;
        if (Object.keys(set).length) await tx.updateTable('users').set(set).where('id', '=', id).execute();
        if (b.student) {
          if (nextRole !== 'student') throw new ApiError(400, 'validation_failed', 'Only students have student details.');
          await upsertStudent(tx, id, b.student);
        }
        if (b.teacher) {
          if (nextRole !== 'teacher') throw new ApiError(400, 'validation_failed', 'Only teachers have teacher details.');
          await tx.insertInto('teachers').values({ user_id: id, ...b.teacher }).onConflict((oc) => oc.column('user_id').doUpdateSet(b.teacher!)).execute();
        }
        const a = await loadUser(tx, id);
        await appendAudit(tx, { actorId: actor.id, action: 'user.update', entityType: 'user', entityId: id, before, after: a, ip: req.ip }, new Date(ctx.now()));
        return a;
      });
      if (b.status === 'disabled' || (b.role && b.role !== before.role) || b.reset_sso) await revokeAllUserSessions(ctx.db, id);
      return after;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      mapDbError(err, 'update');
    }
  });
}
