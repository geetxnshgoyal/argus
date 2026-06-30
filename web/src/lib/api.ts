import type { components } from '../generated/api.ts';

export type Schemas = components['schemas'];
export type ApiErrorBody = Schemas['Error'];

/** Thrown for any non-2xx API response; carries the server's stable error code. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Field-level validation messages, if the server sent any. */
  get fields(): Record<string, string> {
    const f = this.details?.fields;
    return f && typeof f === 'object' ? (f as Record<string, string>) : {};
  }
}

// The CSRF token comes from GET /v1/me and must accompany every mutating request.
let csrfToken: string | null = null;
export function setCsrfToken(t: string | null): void {
  csrfToken = t;
}

async function toError(res: Response): Promise<ApiRequestError> {
  let body: Partial<ApiErrorBody> = {};
  try {
    body = (await res.json()) as ApiErrorBody;
  } catch {
    // Non-JSON error (e.g. proxy error page); fall through to a generic message.
  }
  return new ApiRequestError(res.status, body.code ?? 'http_error', body.message ?? `Request failed (${res.status})`, body.details);
}

/**
 * GET a JSON API resource. Resolves for 2xx; for non-2xx it resolves only when
 * `acceptStatus` includes the status (e.g. health returns 503 with a body).
 */
export async function apiGet<T>(
  path: string,
  opts: { acceptStatus?: number[]; fetchImpl?: typeof fetch } = {},
): Promise<T> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(path, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
  if (res.ok || opts.acceptStatus?.includes(res.status)) return (await res.json()) as T;
  throw await toError(res);
}

/** POST/PATCH/DELETE with JSON and the CSRF header. */
export async function apiSend<T>(
  method: 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  path: string,
  body?: unknown,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<T> {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrfToken) headers['x-argus-csrf'] = csrfToken;
  const res = await doFetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return undefined as T;
  if (res.ok) return (await res.json()) as T;
  throw await toError(res);
}

/** Query string from defined, non-empty values. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
