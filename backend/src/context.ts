import type { FastifyBaseLogger } from 'fastify';
import { KeyCache, LiveEvents } from './attendance/runtime.ts';
import { OidcService } from './auth/oidc.ts';
import { TokenService } from './auth/tokens.ts';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import { AttestationService, type AttestationDeps } from './devices/attestation/index.ts';
import { RiskSettingsStore } from './risk/settings.ts';

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
  /** Google/Apple device evidence checks (fakes in tests). */
  attestation: AttestationService;
  /** Decrypted session keys, in memory only. */
  keys: KeyCache;
  /** Live-panel change notifications. */
  events: LiveEvents;
  /** Cached risk settings (ADR-0014). */
  risk: RiskSettingsStore;
}

export function createContext(opts: {
  config: Config;
  db: Db;
  logger: FastifyBaseLogger;
  version: string;
  now?: () => number;
  oidc?: OidcService | null;
  attestation?: AttestationDeps;
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
              hostedDomains: config.oidc.hostedDomains,
              allowedEmails: config.oidc.allowedEmails,
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
    attestation: new AttestationService(config, opts.logger, { now: opts.now ?? Date.now, ...opts.attestation }),
    keys: new KeyCache(),
    events: new LiveEvents(),
    risk: new RiskSettingsStore(),
  };
}
