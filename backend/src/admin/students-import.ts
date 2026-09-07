import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { appendAudit } from '../audit/audit.ts';
import { currentUser, needAuth } from '../auth/guard.ts';
import { revokeAllUserSessions } from '../auth/sessions.ts';
import type { AppContext } from '../context.ts';
import type { Tx } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../platform/ids.ts';
import { syncSectionEnrollments } from '../timetable/service.ts';
import { parse, uuid } from '../validation.ts';

/**
 * Student roster import with a dry-run report (spec §8 importer style).
 *
 * The web app parses the uploaded file (CSV, or the existing system's JSON
 * export) in the browser and sends only the fields Argus needs: usn, name,
 * email, batch, status. Everything else in the file (phone numbers,
 * birthdays, photos, ...) never leaves the browser (DPDP data minimization).
 */

const MAX_ROWS = 5000;

const rowSchema = z.object({
  usn: z.string().max(40).optional().nullable(),
  name: z.string().max(200).optional().nullable(),
  email: z.string().max(200).optional().nullable(),
  batch: z.string().max(100).optional().nullable(),
  status: z.string().max(40).optional().nullable(),
});

const bodySchema = z.object({
  program_id: uuid,
  section_id: uuid,
  admission_year: z.number().int().min(1990).max(2100),
  rows: z.array(rowSchema).min(1).max(MAX_ROWS),
});

export type ImportAction = 'create' | 'update' | 'unchanged' | 'error';

export interface ImportRowReport {
  line: number;
  usn: string;
  name: string;
  action: ImportAction;
  status: 'active' | 'disabled';
  changes?: string[];
  errors?: string[];
}

export interface ImportReport {
  dry_run: boolean;
  summary: Record<ImportAction, number> & { disabled: number };
  groups_to_create: string[];
  rows: ImportRowReport[];
}

const USN_RE = /^[A-Za-z0-9]{4,30}$/;
const LEFT_STATUSES = new Set(['left', 'inactive', 'disabled', 'dropped', 'alumni']);

interface Planned {
  report: ImportRowReport;
  userId?: string;
  email?: string;
  batch?: string | null;
}

export function registerStudentImport(app: FastifyInstance, ctx: AppContext): void {
  const domains = ctx.config.oidc.hostedDomains;

  app.post('/v1/admin/students/import', { preHandler: needAuth('acadops', 'admin'), bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const actor = currentUser(req);
    const dryRun = (req.query as { dry_run?: string }).dry_run !== 'false';
    const b = parse(bodySchema, req.body);

    const section = await ctx.db
      .selectFrom('sections')
      .select(['id', 'program_id'])
      .where('id', '=', b.section_id)
      .executeTakeFirst();
    if (!section) throw new ApiError(400, 'invalid_reference', 'Section not found.');
    if (section.program_id !== b.program_id) throw new ApiError(400, 'invalid_section', 'The section must belong to the selected program.');

    const groups = await ctx.db.selectFrom('section_groups').select(['id', 'name']).where('section_id', '=', b.section_id).execute();
    const groupByName = new Map(groups.map((g) => [g.name.toLowerCase(), g]));

    const usns = b.rows.map((r) => r.usn?.trim() ?? '').filter(Boolean);
    const emails = b.rows.map((r) => r.email?.trim().toLowerCase() ?? '').filter(Boolean);
    const existingStudents = usns.length
      ? await ctx.db
          .selectFrom('students as s')
          .innerJoin('users as u', 'u.id', 's.user_id')
          .select(['s.user_id', 's.usn', 's.section_id', 's.group_id', 's.program_id', 's.admission_year', 'u.name', 'u.email', 'u.status'])
          .where('s.usn', 'in', usns)
          .execute()
      : [];
    const byUsn = new Map(existingStudents.map((s) => [s.usn, s]));
    const emailOwners = emails.length
      ? await ctx.db
          .selectFrom('users')
          .select(['id', 'email'])
          .where((eb) => eb(eb.fn('lower', ['email']), 'in', emails))
          .execute()
      : [];
    const emailOwner = new Map(emailOwners.map((u) => [u.email.toLowerCase(), u.id]));

    const seenUsn = new Set<string>();
    const seenEmail = new Set<string>();
    const groupsToCreate = new Set<string>();
    const planned: Planned[] = b.rows.map((r, i) => {
      const usn = r.usn?.trim() ?? '';
      const name = r.name?.trim().replace(/\s+/g, ' ') ?? '';
      const email = r.email?.trim().toLowerCase() ?? '';
      const batch = r.batch?.trim() || null;
      const status: 'active' | 'disabled' = r.status && LEFT_STATUSES.has(r.status.trim().toLowerCase()) ? 'disabled' : 'active';
      const errors: string[] = [];
      if (!USN_RE.test(usn)) errors.push('USN is missing or has invalid characters');
      if (!name) errors.push('Name is missing');
      if (!z.string().email().safeParse(email).success) errors.push('College email is missing or invalid');
      else if (domains.length > 0 && !domains.includes(email.split('@')[1] ?? '')) errors.push(`Email must be an ${domains.map((d) => `@${d}`).join(' or ')} address`);
      if (usn && seenUsn.has(usn)) errors.push('USN appears more than once in the file');
      if (email && seenEmail.has(email)) errors.push('Email appears more than once in the file');
      seenUsn.add(usn);
      seenEmail.add(email);

      const existing = byUsn.get(usn);
      const owner = emailOwner.get(email);
      if (owner && owner !== existing?.user_id) errors.push('This email already belongs to another Argus user');
      if (batch && !groupByName.has(batch.toLowerCase())) groupsToCreate.add(batch);

      const report: ImportRowReport = { line: i + 1, usn, name, action: 'error', status };
      if (errors.length) return { report: { ...report, errors } };
      if (!existing) return { report: { ...report, action: 'create' }, email, batch };

      const changes: string[] = [];
      if (existing.name !== name) changes.push('name');
      if (existing.email.toLowerCase() !== email) changes.push('email');
      if (existing.status !== status) changes.push('status');
      if (existing.section_id !== b.section_id || existing.program_id !== b.program_id) changes.push('section');
      const currentGroup = groups.find((g) => g.id === existing.group_id)?.name ?? null;
      if ((currentGroup?.toLowerCase() ?? null) !== (batch?.toLowerCase() ?? null)) changes.push('batch');
      return {
        report: { ...report, action: changes.length ? 'update' : 'unchanged', ...(changes.length ? { changes } : {}) },
        userId: existing.user_id,
        email,
        batch,
      };
    });

    const summary = { create: 0, update: 0, unchanged: 0, error: 0, disabled: 0 };
    for (const p of planned) {
      summary[p.report.action]++;
      if (p.report.status === 'disabled' && p.report.action !== 'error') summary.disabled++;
    }
    const report: ImportReport = { dry_run: dryRun, summary, groups_to_create: [...groupsToCreate].sort(), rows: planned.map((p) => p.report) };
    if (dryRun) return report;
    if (summary.error > 0) {
      throw new ApiError(400, 'import_has_errors', 'Fix the rows with errors, then import again.', { summary });
    }

    const toRevoke: string[] = [];
    await ctx.db.transaction().execute(async (tx: Tx) => {
      const at = new Date(ctx.now());
      for (const name of report.groups_to_create) {
        const g = { id: uuidv7(ctx.now()), section_id: b.section_id, name };
        await tx.insertInto('section_groups').values(g).execute();
        groupByName.set(name.toLowerCase(), g);
        await appendAudit(tx, { actorId: actor.id, action: 'section_group.create', entityType: 'section_group', entityId: g.id, after: g, ip: req.ip }, at);
      }
      for (const p of planned) {
        if (p.report.action === 'unchanged' || p.report.action === 'error') continue;
        const groupId = p.batch ? (groupByName.get(p.batch.toLowerCase())?.id ?? null) : null;
        const student = { usn: p.report.usn, program_id: b.program_id, section_id: b.section_id, group_id: groupId, admission_year: b.admission_year };
        if (p.report.action === 'create') {
          const id = uuidv7(ctx.now());
          await tx.insertInto('users').values({ id, role: 'student', name: p.report.name, email: p.email!, status: p.report.status }).execute();
          await tx.insertInto('students').values({ user_id: id, ...student }).execute();
          await appendAudit(tx, { actorId: actor.id, action: 'user.create', entityType: 'user', entityId: id, after: { role: 'student', name: p.report.name, email: p.email, status: p.report.status, ...student }, ip: req.ip }, at);
        } else {
          await tx.updateTable('users').set({ name: p.report.name, email: p.email!, status: p.report.status }).where('id', '=', p.userId!).execute();
          await tx.updateTable('students').set({ program_id: b.program_id, section_id: b.section_id, group_id: groupId }).where('user_id', '=', p.userId!).execute();
          await appendAudit(tx, { actorId: actor.id, action: 'user.update', entityType: 'user', entityId: p.userId!, after: { changes: p.report.changes, name: p.report.name, email: p.email, status: p.report.status, ...student }, ip: req.ip }, at);
          if (p.report.status === 'disabled') toRevoke.push(p.userId!);
        }
      }
      await appendAudit(tx, { actorId: actor.id, action: 'students.import', entityType: 'section', entityId: b.section_id, after: { summary, groups_created: report.groups_to_create }, ip: req.ip }, at);
      // Students join their section's subjects (with their lab batch) straight away.
      await syncSectionEnrollments(tx, b.section_id);
    });
    for (const id of toRevoke) await revokeAllUserSessions(ctx.db, id);
    return report;
  });
}
