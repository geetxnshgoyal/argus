import { describe, expect, it } from 'vitest';
import { apiGet, ApiRequestError } from '../src/lib/api.ts';

const respond = (status: number, body: unknown) =>
  (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as typeof fetch;

describe('apiGet', () => {
  it('returns parsed JSON on success', async () => {
    expect(await apiGet('/v1/x', { fetchImpl: respond(200, { a: 1 }) })).toEqual({ a: 1 });
  });

  it('surfaces the server error code and message', async () => {
    const err = await apiGet('/v1/x', { fetchImpl: respond(403, { code: 'forbidden', message: 'Not your class' }) }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 403, code: 'forbidden', message: 'Not your class' });
  });

  it('handles non-JSON error pages', async () => {
    const err = await apiGet('/v1/x', { fetchImpl: respond(502, '<html>Bad gateway</html>') }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: 'http_error' });
  });

  it('accepts listed non-2xx statuses that carry a body', async () => {
    const body = { status: 'degraded', version: '1', db: 'unavailable' };
    expect(await apiGet('/v1/health', { acceptStatus: [503], fetchImpl: respond(503, body) })).toEqual(body);
  });
});
