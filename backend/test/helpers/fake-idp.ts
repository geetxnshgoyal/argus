import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';

/**
 * Minimal OpenID provider for tests: discovery, JWKS and the token endpoint
 * (with PKCE verification). "Signing in" is simulated by `authorize()`, which
 * plays the user approving the request and returns the callback URL.
 */
export interface FakeIdentity {
  sub: string;
  email: string;
  email_verified?: boolean;
  hd?: string;
  name?: string;
  auth_time?: number;
}

export class FakeIdp {
  issuer = '';
  private server: Server | undefined;
  private privateKey: CryptoKey | undefined;
  private jwk: Record<string, unknown> | undefined;
  private readonly codes = new Map<string, { identity: FakeIdentity; nonce: string; challenge: string; clientId: string; used: boolean }>();
  clientId = 'argus-test-client';
  clientSecret = 'test-secret';
  tokenRequests = 0;

  async start(): Promise<this> {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    this.privateKey = privateKey;
    this.jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
    this.server = createServer((req, res) => void this.handle(req.url ?? '/', req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  /** Simulates the user signing in at the IdP; returns the redirect back to Argus. */
  authorize(authorizationUrl: string, identity: FakeIdentity): URL {
    const u = new URL(authorizationUrl);
    const code = `code-${Math.random().toString(36).slice(2)}`;
    this.codes.set(code, {
      identity,
      nonce: u.searchParams.get('nonce') ?? '',
      challenge: u.searchParams.get('code_challenge') ?? '',
      clientId: u.searchParams.get('client_id') ?? '',
      used: false,
    });
    const back = new URL(u.searchParams.get('redirect_uri') ?? '');
    back.searchParams.set('code', code);
    back.searchParams.set('state', u.searchParams.get('state') ?? '');
    back.searchParams.set('iss', this.issuer);
    return back;
  }

  private async handle(path: string, req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (path === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['ES256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      });
    }
    if (path === '/jwks') return json(200, { keys: [this.jwk] });
    if (path === '/token' && req.method === 'POST') {
      this.tokenRequests++;
      let body = '';
      for await (const chunk of req) body += chunk;
      const p = new URLSearchParams(body);
      const entry = this.codes.get(p.get('code') ?? '');
      const verifier = p.get('code_verifier') ?? '';
      const challengeOk = entry && createHash('sha256').update(verifier).digest('base64url') === entry.challenge;
      if (!entry || entry.used || !challengeOk || p.get('client_secret') !== this.clientSecret) {
        return json(400, { error: 'invalid_grant' });
      }
      entry.used = true;
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({
        email: entry.identity.email,
        email_verified: entry.identity.email_verified ?? true,
        hd: entry.identity.hd,
        name: entry.identity.name,
        nonce: entry.nonce,
        auth_time: entry.identity.auth_time ?? now,
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
        .setIssuer(this.issuer)
        .setAudience(entry.clientId)
        .setSubject(entry.identity.sub)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(this.privateKey!);
      return json(200, { access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }
    json(404, {});
  }
}
