import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { appendAudit } from '../audit/audit.ts';
import type { AppContext } from '../context.ts';
import type { Role } from '../db/schema.ts';
import { ApiError } from '../errors.ts';
import { sha256Hex } from '../platform/crypto.ts';
import { POLICY_TEXT, POLICY_VERSION } from '../policy.ts';
import { b64url, parse } from '../validation.ts';
import { verifyP256, parseP256Spki } from './device-sig.ts';
import { currentUser, needAuth } from './guard.ts';
import { MOBILE_CODE_TTL_MS, newMobileCode } from './oidc.ts';
import { createWebSession, revokeWebSession, SESSION_TTL_MS, sessionCookieName } from './sessions.ts';
import { TokenService } from './tokens.ts';

export function roleHome(role: Role): string {
  switch (role) {
    case 'teacher':
      return '/teacher';
    case 'acadops':
    case 'admin':
      return '/admin';
    case 'verifier':
      return '/verify';
    case 'student':
      return '/student';
  }
}

/** Only same-site relative paths; blocks open redirects like //evil.com or /\evil.com. */
export function safeNextPath(p: unknown): string | null {
  if (typeof p !== 'string' || p.length > 200) return null;
  if (!p.startsWith('/') || p.startsWith('//') || p.startsWith('/\\') || p.includes('\n')) return null;
  return p;
}

const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');

const loginQuery = z.object({
  client: z.enum(['web', 'mobile']).default('web'),
  next: z.string().optional(),
  app_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  reauth: z.enum(['1', 'true']).optional(),
});

const exchangeBody = z.object({
  code: z.string().min(20).max(100),
  code_verifier: z.string().min(43).max(128),
  session_public_key: b64url.max(300),
  signature: b64url.max(200),
});

const refreshBody = z.object({
  refresh_token: z.string().min(20).max(100),
  ts: z.number().int(),
  signature: b64url.max(200),
});

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const cookieName = sessionCookieName(ctx.secureCookies);
  const rateLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  async function startWebSession(reply: FastifyReply, req: FastifyRequest, user: { id: string }, authAt: Date) {
    const s = await createWebSession(ctx.db, user.id, { ip: req.ip, userAgent: req.headers['user-agent'] ?? null, authAt, now: ctx.now() });
    reply.setCookie(cookieName, s.cookieValue, {
      httpOnly: true,
      secure: ctx.secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });
  }

  async function audit(req: FastifyRequest, actorId: string, action: string, after?: unknown) {
    await ctx.db.transaction().execute((tx) =>
      appendAudit(tx, { actorId, action, entityType: 'user', entityId: actorId, after, ip: req.ip }, new Date(ctx.now())),
    );
  }

  // ── SSO ────────────────────────────────────────────────────────────────────
  app.get('/v1/auth/oidc/login', rateLimit, async (req, reply) => {
    const q = parse(loginQuery, req.query);
    if (!ctx.oidc) {
      // This is a browser navigation: send people back to a page that explains, not a JSON error.
      if (q.client === 'mobile') {
        const target = new URL(ctx.config.mobileRedirectUri);
        target.searchParams.set('error', 'sso_not_configured');
        return reply.redirect(target.href, 302);
      }
      return reply.redirect('/login?error=sso_not_configured', 302);
    }
    if (q.client === 'mobile' && !q.app_challenge) {
      throw new ApiError(400, 'validation_failed', 'app_challenge is required for mobile sign-in.');
    }
    const url = await ctx.oidc.startLogin({
      client: q.client,
      nextPath: safeNextPath(q.next),
      appCodeChallenge: q.app_challenge ?? null,
      reauth: Boolean(q.reauth),
      now: ctx.now(),
    });
    return reply.redirect(url.href, 302);
  });

  app.get('/v1/auth/oidc/callback', rateLimit, async (req, reply) => {
    if (!ctx.oidc) throw new ApiError(503, 'sso_not_configured', 'College sign-in is not configured on this server.');
    const callbackUrl = new URL(req.url, ctx.config.publicUrl);
    // Which client started this sign-in decides where errors are sent back to.
    const stateParam = callbackUrl.searchParams.get('state');
    const started = stateParam
      ? await ctx.db.selectFrom('oidc_login_states').select('client').where('state', '=', stateParam).executeTakeFirst()
      : undefined;
    let login;
    try {
      login = await ctx.oidc.finishLogin(callbackUrl, ctx.now());
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'login_failed';
      if (!(err instanceof ApiError)) req.log.error({ err }, 'sso callback failed');
      if (started?.client === 'mobile') {
        const target = new URL(ctx.config.mobileRedirectUri);
        target.searchParams.set('error', code);
        return reply.redirect(target.href, 302);
      }
      return reply.redirect(`/login?error=${encodeURIComponent(code)}`, 302);
    }

    if (login.client === 'mobile') {
      const code = newMobileCode();
      await ctx.db
        .insertInto('mobile_auth_codes')
        .values({
          code_hash: sha256Hex(code),
          user_id: login.user.id,
          app_code_challenge: login.appCodeChallenge as string,
          expires_at: new Date(ctx.now() + MOBILE_CODE_TTL_MS),
        })
        .execute();
      const target = new URL(ctx.config.mobileRedirectUri);
      target.searchParams.set('code', code);
      return reply.redirect(target.href, 302);
    }

    await startWebSession(reply, req, login.user, login.authAt);
    await audit(req, login.user.id, 'auth.login', { client: 'web' });
    return reply.redirect(login.nextPath ?? roleHome(login.user.role), 302);
  });

  // ── Mobile ─────────────────────────────────────────────────────────────────
  app.post('/v1/auth/mobile/exchange', rateLimit, async (req) => {
    const b = parse(exchangeBody, req.body);
    try {
      parseP256Spki(b.session_public_key);
    } catch {
      throw new ApiError(400, 'validation_failed', 'session_public_key must be an EC P-256 public key.');
    }
    // Proof of possession of the device session key for this exact code.
    if (!verifyP256(b.session_public_key, Buffer.from(`argus/v1/exchange|${b.code}`), b.signature)) {
      throw new ApiError(401, 'bad_device_proof', 'Sign-in could not be verified. Please try again.');
    }
    const row = await ctx.db
      .updateTable('mobile_auth_codes')
      .set({ used_at: new Date(ctx.now()) })
      .where('code_hash', '=', sha256Hex(b.code))
      .where('used_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    if (!row || row.expires_at.getTime() <= ctx.now() || row.app_code_challenge !== s256(b.code_verifier)) {
      throw new ApiError(400, 'invalid_code', 'Sign-in expired. Please try again.');
    }
    const user = await ctx.db.selectFrom('users').select(['id', 'role', 'status']).where('id', '=', row.user_id).executeTakeFirstOrThrow();
    if (user.status !== 'active') throw new ApiError(403, 'account_disabled', 'Your Argus account is disabled.');
    if (user.role !== 'student') {
      throw new ApiError(403, 'students_only', 'The Argus app is for students. Staff please use the Argus website.');
    }
    const tokens = await ctx.tokens.issue(user, b.session_public_key, undefined, ctx.now());
    await audit(req, user.id, 'auth.login', { client: 'mobile' });
    return tokens;
  });

  app.post('/v1/auth/refresh', rateLimit, async (req) => {
    const b = parse(refreshBody, req.body);
    return ctx.tokens.rotate(b.refresh_token, b.ts, b.signature, ctx.now());
  });

  app.post('/v1/auth/logout', { preHandler: needAuth() }, async (req, reply) => {
    const u = currentUser(req);
    if (u.via === 'session' && u.session) {
      await revokeWebSession(ctx.db, u.session.idHash);
      reply.clearCookie(cookieName, { path: '/' });
    } else if (u.tokenFamily) {
      await ctx.tokens.revokeFamily(u.tokenFamily, ctx.now());
    }
    await audit(req, u.id, 'auth.logout');
    return { ok: true };
  });

  // ── Me + policy ────────────────────────────────────────────────────────────
  app.get('/v1/policy', async () => ({ version: POLICY_VERSION, text: POLICY_TEXT }));

  /** Which sign-in methods this server offers, so sign-in pages only show what works. */
  app.get('/v1/auth/methods', async () => ({ sso: ctx.oidc !== null, dev_login: ctx.config.devLogin, domains: ctx.config.oidc.hostedDomains }));

  app.get('/v1/me', { preHandler: needAuth() }, async (req) => {
    const u = currentUser(req);
    const accepted = await ctx.db
      .selectFrom('policy_acceptances')
      .select('accepted_at')
      .where('user_id', '=', u.id)
      .where('policy_version', '=', POLICY_VERSION)
      .executeTakeFirst();
    let student = null;
    if (u.role === 'student') {
      student =
        (await ctx.db
          .selectFrom('students as s')
          .leftJoin('sections as sec', 'sec.id', 's.section_id')
          .leftJoin('section_groups as g', 'g.id', 's.group_id')
          .innerJoin('programs as p', 'p.id', 's.program_id')
          .select(['s.usn', 'p.name as program', 'sec.name as section', 'g.name as batch'])
          .where('s.user_id', '=', u.id)
          .executeTakeFirst()) ?? null;
    }
    return {
      user: { id: u.id, role: u.role, name: u.name, email: u.email },
      home: roleHome(u.role),
      csrf_token: u.session?.csrfToken ?? null,
      policy: { version: POLICY_VERSION, accepted: Boolean(accepted) },
      student,
    };
  });

  app.post('/v1/me/policy-acceptance', { preHandler: needAuth() }, async (req) => {
    const u = currentUser(req);
    const b = parse(z.object({ version: z.string() }), req.body);
    if (b.version !== POLICY_VERSION) {
      throw new ApiError(409, 'policy_outdated', 'A newer policy is available. Please read it again.');
    }
    await ctx.db.transaction().execute(async (tx) => {
      const inserted = await tx
        .insertInto('policy_acceptances')
        .values({ user_id: u.id, policy_version: POLICY_VERSION })
        .onConflict((oc) => oc.doNothing())
        .returning('user_id')
        .executeTakeFirst();
      if (inserted) {
        await appendAudit(tx, { actorId: u.id, action: 'policy.accept', entityType: 'user', entityId: u.id, after: { version: POLICY_VERSION }, ip: req.ip }, new Date(ctx.now()));
      }
    });
    return { ok: true, version: POLICY_VERSION };
  });

  // ── Dev-only sign-in (ARGUS_DEV_LOGIN=true, refused outside ARGUS_ENV=dev) ──
  if (ctx.config.devLogin) {
    // Looks users up by email without linking an SSO identity to them.
    const devUser = async (email: string) => {
      const u = await ctx.db
        .selectFrom('users')
        .select(['id', 'role', 'name', 'email', 'status'])
        .where((eb) => eb(eb.fn('lower', ['email']), '=', email.toLowerCase()))
        .executeTakeFirst();
      if (!u || u.status !== 'active') throw new ApiError(403, 'not_provisioned', 'No active Argus user with that email.');
      return { id: u.id, role: u.role, name: u.name, email: u.email };
    };

    app.get('/v1/auth/dev/users', async (req) => {
      const q = parse(z.object({ q: z.string().max(100).optional() }), req.query);
      let query = ctx.db.selectFrom('users').select(['email', 'name', 'role']).where('status', '=', 'active').orderBy('role').orderBy('name').limit(50);
      if (q.q) query = query.where((eb) => eb.or([eb('name', 'ilike', `%${q.q}%`), eb('email', 'ilike', `%${q.q}%`)]));
      return { users: await query.execute() };
    });

    app.post('/v1/auth/dev/login', async (req, reply) => {
      const b = parse(z.object({ email: z.string().email() }), req.body);
      const user = await devUser(b.email);
      await startWebSession(reply, req, user, new Date(ctx.now()));
      await audit(req, user.id, 'auth.login', { client: 'web', dev: true });
      return { ok: true, home: roleHome(user.role) };
    });

    app.post('/v1/auth/dev/mobile-login', async (req) => {
      const b = parse(z.object({ email: z.string().email(), session_public_key: b64url.max(300), signature: b64url.max(200) }), req.body);
      if (!verifyP256(b.session_public_key, Buffer.from(`argus/v1/dev-login|${b.email}`), b.signature)) {
        throw new ApiError(401, 'bad_device_proof', 'Device proof failed.');
      }
      const user = await devUser(b.email);
      if (user.role !== 'student') throw new ApiError(403, 'students_only', 'The Argus app is for students.');
      await audit(req, user.id, 'auth.login', { client: 'mobile', dev: true });
      return ctx.tokens.issue(user, b.session_public_key, undefined, ctx.now());
    });
  }
}

// Re-exported for tests that build signed refresh requests.
export { TokenService };
