import * as oidc from 'openid-client';
import type { Db } from '../db/index.ts';
import type { Role } from '../db/schema.ts';
import { ApiError } from '../errors.ts';
import { randomToken } from '../platform/crypto.ts';

/**
 * College SSO via OpenID Connect (auth code + PKCE). The college uses Google
 * Workspace, so the defaults target Google; any OIDC provider works.
 *
 * Users are provisioned by Acad Ops beforehand. On first sign-in a user is
 * matched by verified email and their SSO subject is recorded; afterwards
 * only the subject is used. Role always comes from the DB.
 */

export const LOGIN_STATE_TTL_MS = 10 * 60 * 1000;

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  hostedDomain: string | undefined;
  redirectUri: string;
  /** Allow http:// issuers (tests and local dev only). */
  allowInsecure: boolean;
}

export interface ResolvedLogin {
  user: { id: string; role: Role; name: string; email: string };
  client: 'web' | 'mobile';
  nextPath: string | null;
  appCodeChallenge: string | null;
  authAt: Date;
}

export class OidcService {
  private configPromise: Promise<oidc.Configuration> | undefined;
  private readonly settings: OidcSettings;
  private readonly db: Db;

  constructor(settings: OidcSettings, db: Db) {
    this.settings = settings;
    this.db = db;
  }

  private config(): Promise<oidc.Configuration> {
    this.configPromise ??= oidc
      .discovery(
        new URL(this.settings.issuer),
        this.settings.clientId,
        undefined,
        oidc.ClientSecretPost(this.settings.clientSecret),
        this.settings.allowInsecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
      )
      .catch((err: unknown) => {
        this.configPromise = undefined; // retry discovery on the next attempt
        throw err;
      });
    return this.configPromise;
  }

  async startLogin(opts: {
    client: 'web' | 'mobile';
    nextPath: string | null;
    appCodeChallenge: string | null;
    reauth: boolean;
    now?: number;
  }): Promise<URL> {
    const config = await this.config();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    await this.db
      .insertInto('oidc_login_states')
      .values({
        state,
        nonce,
        code_verifier: codeVerifier,
        client: opts.client,
        next_path: opts.nextPath,
        app_code_challenge: opts.appCodeChallenge,
        reauth: opts.reauth,
        expires_at: new Date((opts.now ?? Date.now()) + LOGIN_STATE_TTL_MS),
      })
      .execute();
    const params: Record<string, string> = {
      redirect_uri: this.settings.redirectUri,
      scope: 'openid email profile',
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      nonce,
      prompt: opts.reauth ? 'login' : 'select_account',
    };
    if (opts.reauth) params.max_age = '0';
    if (this.settings.hostedDomain) params.hd = this.settings.hostedDomain;
    return oidc.buildAuthorizationUrl(config, params);
  }

  /** Completes the code exchange and maps the identity to an Argus user. */
  async finishLogin(callbackUrl: URL, now = Date.now()): Promise<ResolvedLogin> {
    const stateParam = callbackUrl.searchParams.get('state');
    if (!stateParam) throw new ApiError(400, 'login_failed', 'Sign-in failed. Please try again.');
    // Single use: the state row is deleted as it is read.
    const st = await this.db.deleteFrom('oidc_login_states').where('state', '=', stateParam).returningAll().executeTakeFirst();
    if (!st || st.expires_at.getTime() <= now) {
      throw new ApiError(400, 'login_expired', 'The sign-in took too long. Please try again.');
    }
    if (callbackUrl.searchParams.get('error')) {
      throw new ApiError(400, 'login_cancelled', 'Sign-in was cancelled.');
    }

    const config = await this.config();
    let claims: oidc.IDToken | undefined;
    try {
      const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: st.code_verifier,
        expectedState: st.state,
        expectedNonce: st.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch {
      throw new ApiError(400, 'login_failed', 'Sign-in failed. Please try again.');
    }
    if (!claims) throw new ApiError(400, 'login_failed', 'Sign-in failed. Please try again.');

    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
    const emailVerified = claims.email_verified === true;
    if (this.settings.hostedDomain) {
      const domainOk = email?.endsWith(`@${this.settings.hostedDomain}`) && claims.hd === this.settings.hostedDomain;
      if (!domainOk) throw new ApiError(403, 'wrong_domain', `Please sign in with your @${this.settings.hostedDomain} account.`);
    }

    const user = await resolveUser(this.db, { issuer: config.serverMetadata().issuer, subject: claims.sub, email, emailVerified });
    const authTime = typeof claims.auth_time === 'number' ? claims.auth_time * 1000 : now;
    if (st.reauth && now - authTime > 5 * 60 * 1000) {
      throw new ApiError(401, 'reauth_failed', 'Please sign in again to confirm it is you.');
    }
    return {
      user,
      client: st.client,
      nextPath: st.next_path,
      appCodeChallenge: st.app_code_challenge,
      authAt: new Date(Math.min(authTime, now)),
    };
  }
}

export async function resolveUser(
  db: Db,
  id: { issuer: string; subject: string; email: string | null; emailVerified: boolean },
): Promise<{ id: string; role: Role; name: string; email: string }> {
  const ssoSubject = `${id.issuer}#${id.subject}`;
  let user = await db
    .selectFrom('users')
    .select(['id', 'role', 'name', 'email', 'status'])
    .where('sso_subject', '=', ssoSubject)
    .executeTakeFirst();

  if (!user && id.email && id.emailVerified) {
    // First sign-in: link the pre-provisioned account with this email.
    const linked = await db
      .updateTable('users')
      .set({ sso_subject: ssoSubject })
      .where((eb) => eb(eb.fn('lower', ['email']), '=', id.email))
      .where('sso_subject', 'is', null)
      .returning(['id', 'role', 'name', 'email', 'status'])
      .executeTakeFirst();
    user = linked;
  }
  if (!user) {
    throw new ApiError(403, 'not_provisioned', 'Your account is not set up in Argus yet. Please contact Academic Operations.');
  }
  if (user.status !== 'active') {
    throw new ApiError(403, 'account_disabled', 'Your Argus account is disabled. Please contact Academic Operations.');
  }
  return { id: user.id, role: user.role, name: user.name, email: user.email };
}

/** One-time code handed to the mobile app after SSO; redeemed with the app's PKCE verifier. */
export const MOBILE_CODE_TTL_MS = 2 * 60 * 1000;

export function newMobileCode(): string {
  return randomToken(32);
}
