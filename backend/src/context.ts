import type { FastifyBaseLogger } from 'fastify';
import { OidcService } from './auth/oidc.ts';
import { TokenService } from './auth/tokens.ts';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';

/** Everything route handlers need, built once at startup (and by tests with fakes). */
export interface AppContext {
  config: Config;
  db: Db;
  logger: FastifyBaseLogger;
  version: string;
  /** Server clock in ms. Server time is authoritative everywhere. */
  now: () => number;
  tokens: TokenService;
  /** Null when SSO is not configured (allowed in dev, where dev login is used). */
  oidc: OidcService | null;
  secureCookies: boolean;
}

export function createContext(opts: {
  config: Config;
  db: Db;
  logger: FastifyBaseLogger;
  version: string;
  now?: () => number;
  oidc?: OidcService | null;
}): AppContext {
  const { config, db } = opts;
  const oidc =
    opts.oidc !== undefined
      ? opts.oidc
      : config.oidc.clientId && config.oidc.clientSecret
        ? new OidcService(
            {
              issuer: config.oidc.issuer,
              clientId: config.oidc.clientId,
              clientSecret: config.oidc.clientSecret,
              hostedDomain: config.oidc.hostedDomain,
              redirectUri: `${config.publicUrl}/v1/auth/oidc/callback`,
              allowInsecure: config.env === 'dev' || config.env === 'test',
            },
            db,
          )
        : null;
  return {
    config,
    db,
    logger: opts.logger,
    version: opts.version,
    now: opts.now ?? Date.now,
    tokens: new TokenService(config.masterKey, db),
    oidc,
    secureCookies: config.publicUrl.startsWith('https://'),
  };
}
