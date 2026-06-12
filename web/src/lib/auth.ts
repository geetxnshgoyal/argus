import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend, ApiRequestError, setCsrfToken, type Schemas } from './api.ts';

export type Me = Schemas['Me'];
export type Role = Schemas['Role'];

/** The signed-in user, or null when signed out. */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async (): Promise<Me | null> => {
      try {
        const me = await apiGet<Me>('/v1/me');
        setCsrfToken(me.csrf_token);
        return me;
      } catch (e) {
        if (e instanceof ApiRequestError && e.status === 401) {
          setCsrfToken(null);
          return null;
        }
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

export function loginUrl(next?: string, reauth = false): string {
  const p = new URLSearchParams();
  if (next) p.set('next', next);
  if (reauth) p.set('reauth', '1');
  const s = p.toString();
  return `/v1/auth/oidc/login${s ? `?${s}` : ''}`;
}

export function useLogout() {
  const qc = useQueryClient();
  return async () => {
    try {
      await apiSend('POST', '/v1/auth/logout');
    } finally {
      setCsrfToken(null);
      qc.clear();
      window.location.assign('/login');
    }
  };
}

export const ROLE_LABELS: Record<Role, string> = {
  student: 'Student',
  teacher: 'Teacher',
  acadops: 'Academic Operations',
  verifier: 'Verifier',
  admin: 'Administrator',
};
