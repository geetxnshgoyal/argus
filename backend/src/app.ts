import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { registerAuditRoutes } from './admin/audit-routes.ts';
import { registerCrud } from './admin/crud.ts';
import { RESOURCES } from './admin/resources.ts';
import { registerStudentImport } from './admin/students-import.ts';
import { registerUserRoutes } from './admin/users.ts';
import { registerAuthResolution } from './auth/guard.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import type { AppContext } from './context.ts';
import { pingDb } from './db/index.ts';
import { ApiError, type ErrorBody } from './errors.ts';
import { registerSystemRoutes } from './routes/system.ts';
import { registerAttendanceRoutes } from './attendance/routes.ts';
import { registerDeviceRoutes } from './devices/routes.ts';
import { registerAdminAttendanceRoutes } from './admin/attendance-routes.ts';
import { registerSupportRoutes } from './support/routes.ts';
import { registerTimetableRoutes } from './timetable/routes.ts';

export interface AppOptions {
  /** Resolves if the database answers, rejects otherwise. Defaults to a real ping. */
  checkDb?: () => Promise<void>;
  /** Directory with the built web app (index.html, display.html). Omit in dev (Vite serves it). */
  webDir?: string | undefined;
}

export interface BuiltApp {
  app: FastifyInstance;
  /** Every registered /v1 route as "METHOD /path/{param}"; used to keep OpenAPI in sync. */
  apiRoutes: string[];
}

/** Strips the query string so tokens or codes passed in URLs never reach logs. */
function safeUrl(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export async function buildApp(ctx: AppContext, opts: AppOptions = {}): Promise<BuiltApp> {
  const deps = { ...opts, logger: ctx.logger, version: ctx.version, now: ctx.now, checkDb: opts.checkDb ?? (() => pingDb(ctx.db)) };
  const app = Fastify({
    loggerInstance: deps.logger,
    trustProxy: ctx.config.trustProxy,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    // We write our own access log line (below) that omits query strings.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 256 * 1024,
    // Long-lived streams (the teacher's live panel uses Server-Sent Events) must not block shutdown.
    forceCloseConnections: true,
  });

  const apiRoutes: string[] = [];
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/v1/')) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const path = route.url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    for (const m of methods) if (m !== 'HEAD') apiRoutes.push(`${m} ${path}`);
  });

  // One access-log line per request, without query strings, headers or bodies.
  app.addHook('onResponse', async (req, reply) => {
    req.log.info(
      { method: req.method, url: safeUrl(req.url), status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      'request',
    );
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    if (req.url.startsWith('/v1/')) {
      reply.header('cache-control', 'no-store');
    } else {
      reply.header('x-frame-options', 'DENY');
      reply.header(
        'content-security-policy',
        "default-src 'self'; img-src 'self' data:; connect-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    }
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ApiError) {
      const body: ErrorBody = { code: err.code, message: err.message };
      if (err.details) body.details = err.details;
      return reply.status(err.statusCode).send(body);
    }
    const e = err as { validation?: unknown; statusCode?: number; message?: string };
    if (e.validation) {
      return reply.status(400).send({ code: 'validation_failed', message: e.message ?? 'Invalid request' });
    }
    if (e.statusCode === 429) return reply.status(429).send(err);
    if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ code: 'bad_request', message: e.message ?? 'Bad request' });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ code: 'internal', message: 'Internal server error' });
  });

  await app.register(fastifyCookie);
  // Opt-in per route (config.rateLimit). In-memory: Argus runs as one process (ADR-0003).
  await app.register(fastifyRateLimit, {
    global: false,
    errorResponseBuilder: (_req, c) => ({ statusCode: 429, code: 'rate_limited', message: `Too many requests. Try again in ${Math.ceil(c.ttl / 1000)} s.` }),
  });
  registerAuthResolution(app, ctx);

  const hasWeb = deps.webDir !== undefined && existsSync(deps.webDir);
  if (hasWeb) {
    await app.register(fastifyStatic, { root: deps.webDir as string, index: false, wildcard: true });
  }

  app.setNotFoundHandler((req: FastifyRequest, reply) => {
    const url = safeUrl(req.url);
    if (hasWeb && req.method === 'GET' && !url.startsWith('/v1/')) {
      // Single-page apps: the display has its own small bundle; everything else is the main app.
      const page = url === '/display' || url.startsWith('/display/') ? 'display.html' : 'index.html';
      return reply.type('text/html').sendFile(page);
    }
    return reply.status(404).send({ code: 'not_found', message: 'Not found' });
  });

  registerSystemRoutes(app, { version: deps.version, checkDb: deps.checkDb, now: deps.now });
  registerAuthRoutes(app, ctx);
  for (const r of RESOURCES) registerCrud(app, ctx, r);
  registerUserRoutes(app, ctx);
  registerStudentImport(app, ctx);
  registerAuditRoutes(app, ctx);
  registerTimetableRoutes(app, ctx);
  registerDeviceRoutes(app, ctx);
  registerAttendanceRoutes(app, ctx);
  registerSupportRoutes(app, ctx);
  registerAdminAttendanceRoutes(app, ctx);

  await app.ready();
  return { app, apiRoutes };
}
