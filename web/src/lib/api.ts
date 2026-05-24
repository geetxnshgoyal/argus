import type { components } from '../generated/api.ts';

export type ApiErrorBody = components['schemas']['Error'];

/** Thrown for any non-2xx API response; carries the server's stable error code. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
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

  let body: Partial<ApiErrorBody> = {};
  try {
    body = (await res.json()) as ApiErrorBody;
  } catch {
    // Non-JSON error (e.g. proxy error page); fall through to a generic message.
  }
  throw new ApiRequestError(res.status, body.code ?? 'http_error', body.message ?? `Request failed (${res.status})`);
}
