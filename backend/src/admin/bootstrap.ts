import { appendAudit } from '../audit/audit.ts';
import type { AppContext } from '../context.ts';
import { uuidv7 } from '../platform/ids.ts';

/**
 * Creates the first administrators from ARGUS_BOOTSTRAP_ADMIN_EMAILS. Without it a
 * production server (no developer sign-in) has nobody who can sign in: accounts
 * must exist before their first Google sign-in (ADR-0016). Existing users are
 * never changed, so leaving the setting in place is harmless.
 */
export async function bootstrapAdmins(ctx: AppContext): Promise<string[]> {
  const created: string[] = [];
  for (const email of ctx.config.bootstrapAdminEmails) {
    const domain = email.split('@')[1] ?? '';
    const domains = ctx.config.oidc.hostedDomains;
    if (domains.length > 0 && !domains.includes(domain)) {
      ctx.logger.warn({ domain }, 'bootstrap admin email is outside the sign-in domains; skipped');
      continue;
    }
    await ctx.db.transaction().execute(async (tx) => {
      const exists = await tx.selectFrom('users').select('id').where((eb) => eb(eb.fn('lower', ['email']), '=', email)).executeTakeFirst();
      if (exists) return;
      const id = uuidv7(ctx.now());
      const name = email.split('@')[0] ?? 'Administrator';
      await tx.insertInto('users').values({ id, role: 'admin', email, name }).execute();
      await appendAudit(tx, { actorId: null, action: 'user.bootstrap_admin', entityType: 'user', entityId: id, after: { email, role: 'admin' } }, new Date(ctx.now()));
      created.push(email);
    });
  }
  if (created.length) ctx.logger.info({ count: created.length }, 'bootstrap administrators created');
  return created;
}
