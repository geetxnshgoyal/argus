import type { Role } from '../db/schema.ts';

/** The authenticated caller, resolved by the auth guard. Role always comes from the DB. */
export interface AuthUser {
  id: string;
  role: Role;
  name: string;
  email: string;
  via: 'session' | 'bearer';
  /** Present for cookie (web) sessions. */
  session?: { idHash: string; csrfToken: string; authAt: Date };
  /** Present for bearer (mobile) tokens: refresh-token family, revoked on logout. */
  tokenFamily?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}
