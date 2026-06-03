import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { AppContext } from '../context.ts';
import type { Role } from '../db/schema.ts';
import { ApiError } from '../errors.ts';
import { safeEqualStr } from '../platform/crypto.ts';
import { findWebSession, RECENT_AUTH_MS, sessionCookieName } from './sessions.ts';
import './types.ts';

/**
 * Resolves the caller on every /v1 request:
 *  - `Authorization: Bearer <access token>` (mobile), or
 *  - the staff session cookie (web).
 * The role is always read from the database, so role changes and disabled
 * accounts take effect immediately.
 */
export function registerAuthResolution(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('user', null);
  const cookieName = sessionCookieName(ctx.secureCookies);

  app.addHook('onRequest', async (req) => {
    req.user = null;
    if (!req.url.startsWith('/v1/')) return;

    const authz = req.headers.authorization;
    if (authz?.startsWith('Bearer ')) {
      const claims = await ctx.tokens.verifyAccess(authz.slice(7), ctx.now());
      if (!claims) return;
      const user = await ctx.db
        .selectFrom('users')
        .select(['id', 'role', 'name', 'email', 'status'])
        .where('id', '=', claims.sub)
        .executeTakeFirst();
      if (!user || user.status !== 'active' || !(await ctx.tokens.familyActive(claims.fam))) return;
      req.user = { id: user.id, role: user.role, name: user.name, email: user.email, via: 'bearer', tokenFamily: claims.fam };
      return;
    }

    const cookie = req.cookies[cookieName];
    if (cookie) {
      const s = await findWebSession(ctx.db, cookie, ctx.now());
      if (s) req.user = { ...s.user, via: 'session', session: { idHash: s.idHash, csrfToken: s.csrfToken, authAt: s.authAt } };
    }
  });
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Requires a signed-in user (optionally with one of `roles`), plus CSRF protection for cookie sessions. */
export function needAuth(...roles: Role[]): preHandlerAsyncHookHandler {
  return async function (req: FastifyRequest, _reply: FastifyReply) {
    const u = req.user;
    if (!u) throw new ApiError(401, 'unauthenticated', 'Please sign in.');
    if (roles.length > 0 && !roles.includes(u.role)) {
      throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');
    }
    if (u.via === 'session' && UNSAFE.has(req.method)) {
      const header = req.headers['x-argus-csrf'];
      if (typeof header !== 'string' || !u.session || !safeEqualStr(header, u.session.csrfToken)) {
        throw new ApiError(403, 'csrf_failed', 'Your page is out of date. Please reload and try again.');
      }
    }
  };
}

/** Sensitive actions: the user must have signed in at the IdP within the last 15 minutes. */
export function needRecentAuth(ctx: AppContext): preHandlerAsyncHookHandler {
  return async function (req: FastifyRequest) {
    assertRecentAuth(ctx, req);
  };
}

export function assertRecentAuth(ctx: AppContext, req: FastifyRequest): void {
  const u = req.user;
  if (!u) throw new ApiError(401, 'unauthenticated', 'Please sign in.');
  if (u.via !== 'session' || !u.session) throw new ApiError(403, 'forbidden', 'This action is only available on the web app.');
  if (ctx.now() - u.session.authAt.getTime() > RECENT_AUTH_MS) {
    throw new ApiError(401, 'reauth_required', 'Please confirm it is you by signing in again.');
  }
}

export function currentUser(req: FastifyRequest) {
  if (!req.user) throw new ApiError(401, 'unauthenticated', 'Please sign in.');
  return req.user;
}
