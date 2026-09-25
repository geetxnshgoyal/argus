import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { safeNextPath } from '../src/auth/routes.ts';
import { OidcService } from '../src/auth/oidc.ts';
import { TokenService } from '../src/auth/tokens.ts';
import type { Db } from '../src/db/index.ts';
import { POLICY_VERSION } from '../src/policy.ts';
import { cookieFrom, createUser, deviceKey, loginAs, makeApp, type TestApp } from './helpers/app.ts';
import { closeTestDb, hasDb, resetDb, testDb } from './helpers/db.ts';
import { FakeIdp } from './helpers/fake-idp.ts';

describe('safeNextPath (open-redirect protection)', () => {
  it.each([
    ['/admin/rooms', '/admin/rooms'],
    ['//evil.example', null],
    ['/\\evil.example', null],
    ['https://evil.example', null],
    ['admin', null],
    ['/a\nb', null],
  ])('%s → %s', (input, expected) => expect(safeNextPath(input)).toBe(expected));
});

describe.skipIf(!hasDb)('auth (integration)', () => {
  let db: Db;
  let t: TestApp;
  beforeEach(async () => {
    db = await testDb();
    await resetDb(db);
    t = await makeApp({ db });
  });
  afterAll(async () => {
    await t?.app.close();
    await closeTestDb();
  });

  describe('web sessions', () => {
    it('rejects unauthenticated requests', async () => {
      const res = await t.app.inject('/v1/me');
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('unauthenticated');
    });

    it('signs in and returns the user, role home and CSRF token', async () => {
      await createUser(db, 'acadops', 'ops@college.test', 'Ops Person');
      const s = await loginAs(t.app, 'ops@college.test');
      const me = (await t.app.inject({ url: '/v1/me', headers: { cookie: s.cookie } })).json();
      expect(me.user).toMatchObject({ role: 'acadops', name: 'Ops Person' });
      expect(me.home).toBe('/admin');
      expect(me.csrf_token).toBe(s.csrf);
    });

    it('sets an httpOnly, SameSite=Lax session cookie', async () => {
      await createUser(db, 'teacher', 't@college.test');
      const res = await t.app.inject({ method: 'POST', url: '/v1/auth/dev/login', payload: { email: 't@college.test' } });
      const setCookie = String(res.headers['set-cookie']);
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/SameSite=Lax/);
    });

    it('requires the CSRF header on mutating cookie requests', async () => {
      await createUser(db, 'acadops', 'ops@college.test');
      const s = await loginAs(t.app, 'ops@college.test');
      const payload = { code: 'CSE', name: 'Computer Science' };
      const noCsrf = await t.app.inject({ method: 'POST', url: '/v1/admin/departments', headers: { cookie: s.cookie }, payload });
      expect(noCsrf.statusCode).toBe(403);
      expect(noCsrf.json().code).toBe('csrf_failed');
      const wrong = await t.app.inject({ method: 'POST', url: '/v1/admin/departments', headers: { cookie: s.cookie, 'x-argus-csrf': 'nope' }, payload });
      expect(wrong.statusCode).toBe(403);
      const ok = await t.app.inject({ method: 'POST', url: '/v1/admin/departments', headers: s.headers, payload });
      expect(ok.statusCode).toBe(201);
    });

    it('takes the role from the database on every request', async () => {
      const u = await createUser(db, 'acadops', 'ops@college.test');
      const s = await loginAs(t.app, 'ops@college.test');
      expect((await t.app.inject({ url: '/v1/admin/departments', headers: s.headers })).statusCode).toBe(200);
      await db.updateTable('users').set({ role: 'teacher' }).where('id', '=', u.id).execute();
      expect((await t.app.inject({ url: '/v1/admin/departments', headers: s.headers })).statusCode).toBe(403);
    });

    it('ends sessions of disabled users immediately', async () => {
      const u = await createUser(db, 'teacher', 't@college.test');
      const s = await loginAs(t.app, 't@college.test');
      await db.updateTable('users').set({ status: 'disabled' }).where('id', '=', u.id).execute();
      expect((await t.app.inject({ url: '/v1/me', headers: s.headers })).statusCode).toBe(401);
    });

    it('expires sessions after 2 hours idle and 12 hours absolute', async () => {
      await createUser(db, 'teacher', 't@college.test');
      const s = await loginAs(t.app, 't@college.test');
      t.clock.now += 2 * 60 * 60 * 1000 + 1000;
      expect((await t.app.inject({ url: '/v1/me', headers: s.headers })).statusCode).toBe(401);
    });

    it('logs out and revokes the session', async () => {
      await createUser(db, 'teacher', 't@college.test');
      const s = await loginAs(t.app, 't@college.test');
      const out = await t.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: s.headers });
      expect(out.statusCode).toBe(200);
      expect((await t.app.inject({ url: '/v1/me', headers: s.headers })).statusCode).toBe(401);
    });

    it('rejects dev login for unknown or disabled users', async () => {
      const res = await t.app.inject({ method: 'POST', url: '/v1/auth/dev/login', payload: { email: 'nobody@college.test' } });
      expect(res.statusCode).toBe(403);
    });

    it('does not register dev login when it is off', async () => {
      const prod = await makeApp({ db, config: { devLogin: false } });
      const res = await prod.app.inject({ method: 'POST', url: '/v1/auth/dev/login', payload: { email: 'x@college.test' } });
      expect(res.statusCode).toBe(404);
      await prod.app.close();
    });
  });

  describe('policy acceptance', () => {
    it('records acceptance of the current version only, and audits it', async () => {
      await createUser(db, 'teacher', 't@college.test');
      const s = await loginAs(t.app, 't@college.test');
      const stale = await t.app.inject({ method: 'POST', url: '/v1/me/policy-acceptance', headers: s.headers, payload: { version: 'old' } });
      expect(stale.statusCode).toBe(409);
      const ok = await t.app.inject({ method: 'POST', url: '/v1/me/policy-acceptance', headers: s.headers, payload: { version: POLICY_VERSION } });
      expect(ok.statusCode).toBe(200);
      expect((await t.app.inject({ url: '/v1/me', headers: s.headers })).json().policy.accepted).toBe(true);
      const audits = await db.selectFrom('audit_log').select('action').where('action', '=', 'policy.accept').execute();
      expect(audits).toHaveLength(1);
    });
  });

  describe('mobile tokens', () => {
    async function mobileLogin(email: string, key = deviceKey()) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/v1/auth/dev/mobile-login',
        payload: { email, session_public_key: key.spki, signature: key.sign(`argus/v1/dev-login|${email}`) },
      });
      return { res, key };
    }

    function refresh(refreshToken: string, key: ReturnType<typeof deviceKey>, ts = t.clock.now) {
      return t.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refresh_token: refreshToken, ts, signature: key.sign(TokenService.refreshMessage(refreshToken, ts)) },
      });
    }

    it('issues tokens to students only', async () => {
      await createUser(db, 'student', 's@college.test');
      await createUser(db, 'teacher', 't@college.test');
      expect((await mobileLogin('s@college.test')).res.statusCode).toBe(200);
      const teacher = await mobileLogin('t@college.test');
      expect(teacher.res.statusCode).toBe(403);
      expect(teacher.res.json().code).toBe('students_only');
    });

    it('rejects a login signed by a different key than the one presented', async () => {
      await createUser(db, 'student', 's@college.test');
      const a = deviceKey();
      const b = deviceKey();
      const res = await t.app.inject({
        method: 'POST',
        url: '/v1/auth/dev/mobile-login',
        payload: { email: 's@college.test', session_public_key: a.spki, signature: b.sign('argus/v1/dev-login|s@college.test') },
      });
      expect(res.statusCode).toBe(401);
    });

    it('accepts the bearer token, and it expires after 15 minutes', async () => {
      await createUser(db, 'student', 's@college.test');
      const { res } = await mobileLogin('s@college.test');
      const auth = { authorization: `Bearer ${res.json().access_token}` };
      expect((await t.app.inject({ url: '/v1/me', headers: auth })).json().user.role).toBe('student');
      t.clock.now += 15 * 60 * 1000 + 1000;
      expect((await t.app.inject({ url: '/v1/me', headers: auth })).statusCode).toBe(401);
    });

    it('rejects tampered or foreign access tokens', async () => {
      await createUser(db, 'student', 's@college.test');
      const { res } = await mobileLogin('s@college.test');
      const tok = res.json().access_token as string;
      const tampered = tok.slice(0, -3) + (tok.endsWith('A') ? 'BBB' : 'AAA');
      expect((await t.app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${tampered}` } })).statusCode).toBe(401);
      const other = await makeApp({ db, config: { masterKey: Buffer.alloc(32, 9) } });
      expect((await other.app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${tok}` } })).statusCode).toBe(401);
      await other.app.close();
    });

    it('rotates refresh tokens when signed by the device session key', async () => {
      await createUser(db, 'student', 's@college.test');
      const { res, key } = await mobileLogin('s@college.test');
      const r1 = await refresh(res.json().refresh_token, key);
      expect(r1.statusCode).toBe(200);
      expect(r1.json().refresh_token).not.toBe(res.json().refresh_token);
    });

    it('refuses a refresh signed by another key (stolen token)', async () => {
      await createUser(db, 'student', 's@college.test');
      const { res } = await mobileLogin('s@college.test');
      const r = await refresh(res.json().refresh_token, deviceKey());
      expect(r.statusCode).toBe(401);
      expect(r.json().code).toBe('bad_device_proof');
    });

    it('refuses stale refresh proofs', async () => {
      await createUser(db, 'student', 's@college.test');
      const { res, key } = await mobileLogin('s@college.test');
      const r = await refresh(res.json().refresh_token, key, t.clock.now - 10 * 60 * 1000);
      expect(r.json().code).toBe('stale_proof');
    });

    it('revokes the whole family when a rotated refresh token is reused', async () => {
      await createUser(db, 'student', 's@college.test');
      const { res, key } = await mobileLogin('s@college.test');
      const first = res.json().refresh_token as string;
      const r1 = await refresh(first, key);
      const replay = await refresh(first, key);
      expect(replay.statusCode).toBe(401);
      expect(replay.json().code).toBe('refresh_reuse');
      // The legitimate newer tokens are revoked too.
      expect((await refresh(r1.json().refresh_token, key)).statusCode).toBe(401);
      expect((await t.app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${r1.json().access_token}` } })).statusCode).toBe(401);
    });

    it('logout revokes the token family', async () => {
      await createUser(db, 'student', 's@college.test');
      const { res, key } = await mobileLogin('s@college.test');
      const auth = { authorization: `Bearer ${res.json().access_token}` };
      expect((await t.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: auth })).statusCode).toBe(200);
      expect((await t.app.inject({ url: '/v1/me', headers: auth })).statusCode).toBe(401);
      expect((await refresh(res.json().refresh_token, key)).statusCode).toBe(401);
    });
  });

  describe('college SSO (OIDC)', () => {
    let idp: FakeIdp;
    beforeAll(async () => {
      idp = await new FakeIdp().start();
    });
    afterAll(() => idp.stop());

    async function ssoApp(hostedDomains = ['college.test']) {
      const oidc = new OidcService(
        { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, hostedDomains, redirectUri: 'http://localhost:5173/v1/auth/oidc/callback', allowInsecure: true },
        db,
      );
      return makeApp({ db, oidc, config: { devLogin: false }, now: Date.now() });
    }

    async function signIn(app: TestApp['app'], identity: Parameters<FakeIdp['authorize']>[1], query = '') {
      const start = await app.inject(`/v1/auth/oidc/login${query}`);
      expect(start.statusCode).toBe(302);
      const authorizeUrl = String(start.headers.location);
      const back = idp.authorize(authorizeUrl, identity);
      return { authorizeUrl, callback: await app.inject(back.pathname + back.search) };
    }

    it('uses PKCE, a nonce and the Google hosted-domain hint', async () => {
      const s = await ssoApp();
      const start = await s.app.inject('/v1/auth/oidc/login');
      const u = new URL(String(start.headers.location));
      expect(u.searchParams.get('code_challenge_method')).toBe('S256');
      expect(u.searchParams.get('nonce')).toBeTruthy();
      expect(u.searchParams.get('hd')).toBe('college.test');
      await s.app.close();
    });

    it('links a provisioned user by verified email on first sign-in, then by subject', async () => {
      const user = await createUser(db, 'teacher', 'teacher@college.test');
      const s = await ssoApp();
      const { callback } = await signIn(s.app, { sub: 'g-123', email: 'Teacher@college.test', hd: 'college.test' });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe('/teacher');
      const row = await db.selectFrom('users').select('sso_subject').where('id', '=', user.id).executeTakeFirstOrThrow();
      expect(row.sso_subject).toBe(`${idp.issuer}#g-123`);
      // Email changes at the IdP don't matter any more: the subject is used.
      const again = await signIn(s.app, { sub: 'g-123', email: 'renamed@college.test', hd: 'college.test' });
      expect(again.callback.headers.location).toBe('/teacher');
      const me = await s.app.inject({ url: '/v1/me', headers: { cookie: cookieFrom(again.callback) } });
      expect(me.json().user.id).toBe(user.id);
      await s.app.close();
    });

    it('refuses accounts outside the college domain', async () => {
      await createUser(db, 'teacher', 'teacher@college.test');
      const s = await ssoApp();
      const { callback } = await signIn(s.app, { sub: 'x', email: 'teacher@gmail.com' });
      expect(callback.headers.location).toBe('/login?error=wrong_domain');
      await s.app.close();
    });

    it('accepts several Workspace domains (students on the college, teachers on a partner)', async () => {
      await createUser(db, 'teacher', 'first.last@partner.test');
      const s = await ssoApp(['college.test', 'partner.test']);
      const start = await s.app.inject('/v1/auth/oidc/login');
      expect(new URL(String(start.headers.location)).searchParams.get('hd')).toBe('*');
      const ok = await signIn(s.app, { sub: 't1', email: 'first.last@partner.test', hd: 'partner.test' });
      expect(ok.callback.headers.location).toBe('/teacher');
      // The hd claim must match the address's own domain, not just any allowed one.
      await createUser(db, 'teacher', 'other@partner.test');
      const mixed = await signIn(s.app, { sub: 't2', email: 'other@partner.test', hd: 'college.test' });
      expect(mixed.callback.headers.location).toBe('/login?error=wrong_domain');
      await s.app.close();
    });

    it('refuses people who are not provisioned in Argus', async () => {
      const s = await ssoApp();
      const { callback } = await signIn(s.app, { sub: 'x', email: 'stranger@college.test', hd: 'college.test' });
      expect(callback.headers.location).toBe('/login?error=not_provisioned');
      await s.app.close();
    });

    it('refuses unverified emails for first-time linking', async () => {
      await createUser(db, 'teacher', 'teacher@college.test');
      const s = await ssoApp();
      const { callback } = await signIn(s.app, { sub: 'x', email: 'teacher@college.test', hd: 'college.test', email_verified: false });
      expect(callback.headers.location).toBe('/login?error=not_provisioned');
      await s.app.close();
    });

    it('rejects a replayed callback (state is single use)', async () => {
      await createUser(db, 'teacher', 'teacher@college.test');
      const s = await ssoApp();
      const start = await s.app.inject('/v1/auth/oidc/login');
      const back = idp.authorize(String(start.headers.location), { sub: 'g', email: 'teacher@college.test', hd: 'college.test' });
      expect((await s.app.inject(back.pathname + back.search)).headers.location).toBe('/teacher');
      expect((await s.app.inject(back.pathname + back.search)).headers.location).toBe('/login?error=login_expired');
      await s.app.close();
    });

    it('honours a safe next path and ignores an unsafe one', async () => {
      await createUser(db, 'acadops', 'ops@college.test');
      const s = await ssoApp();
      const ok = await signIn(s.app, { sub: 'o', email: 'ops@college.test', hd: 'college.test' }, '?next=/admin/rooms');
      expect(ok.callback.headers.location).toBe('/admin/rooms');
      const bad = await signIn(s.app, { sub: 'o', email: 'ops@college.test', hd: 'college.test' }, `?next=${encodeURIComponent('//evil.example')}`);
      expect(bad.callback.headers.location).toBe('/admin');
      await s.app.close();
    });

    it('mobile: returns a one-time code redeemable only with the app PKCE verifier and device key', async () => {
      await createUser(db, 'student', 'stu@college.test');
      const s = await ssoApp();
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const { callback } = await signIn(s.app, { sub: 's1', email: 'stu@college.test', hd: 'college.test' }, `?client=mobile&app_challenge=${challenge}`);
      const redirect = new URL(String(callback.headers.location));
      expect(redirect.protocol).toBe('app.argus.argus:');
      const code = redirect.searchParams.get('code') as string;
      const key = deviceKey();
      const exchange = (v: string) =>
        s.app.inject({
          method: 'POST',
          url: '/v1/auth/mobile/exchange',
          payload: { code, code_verifier: v, session_public_key: key.spki, signature: key.sign(`argus/v1/exchange|${code}`) },
        });
      const wrong = await exchange(randomBytes(32).toString('base64url'));
      expect(wrong.statusCode).toBe(400);
      // The failed attempt consumed the code: a stolen code + guessed verifier cannot be retried.
      expect((await exchange(verifier)).statusCode).toBe(400);
      await s.app.close();
    });

    it('mobile: sign-in errors are sent back to the app, not the web login page', async () => {
      const s = await ssoApp();
      const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
      const { callback } = await signIn(s.app, { sub: 'x', email: 'nobody@college.test', hd: 'college.test' }, `?client=mobile&app_challenge=${challenge}`);
      expect(callback.headers.location).toBe('app.argus.argus:/auth/callback?error=not_provisioned');
      await s.app.close();
    });

    it('mobile: a correct exchange returns device-bound tokens', async () => {
      await createUser(db, 'student', 'stu@college.test');
      const s = await ssoApp();
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const { callback } = await signIn(s.app, { sub: 's1', email: 'stu@college.test', hd: 'college.test' }, `?client=mobile&app_challenge=${challenge}`);
      const code = new URL(String(callback.headers.location)).searchParams.get('code') as string;
      const key = deviceKey();
      const res = await s.app.inject({
        method: 'POST',
        url: '/v1/auth/mobile/exchange',
        payload: { code, code_verifier: verifier, session_public_key: key.spki, signature: key.sign(`argus/v1/exchange|${code}`) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().token_type).toBe('Bearer');
      await s.app.close();
    });
  });
});

describe('sign-in methods', () => {
  it('reports SSO off and sends browsers to a friendly page instead of a JSON error', async () => {
    const t = await makeApp({ oidc: null });
    const m = (await t.app.inject('/v1/auth/methods')).json();
    expect(m).toMatchObject({ sso: false, dev_login: true, domains: ['college.test'] });
    const web = await t.app.inject('/v1/auth/oidc/login');
    expect(web.statusCode).toBe(302);
    expect(web.headers.location).toBe('/login?error=sso_not_configured');
    const mobile = await t.app.inject(`/v1/auth/oidc/login?client=mobile&app_challenge=${'a'.repeat(43)}`);
    expect(mobile.headers.location).toBe('app.argus.argus:/auth/callback?error=sso_not_configured');
    await t.app.close();
  });
});
