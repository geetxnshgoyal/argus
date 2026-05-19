import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.ts';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { logger: createLogger('info', stream), text: () => lines.join('') };
}

describe('logger redaction', () => {
  it('redacts secrets, tokens, attestation blobs and locations', () => {
    const { logger, text } = capture();
    logger.info(
      {
        token: 'tok-SECRET-1',
        refresh_token: 'tok-SECRET-2',
        attestation: 'blob-SECRET-3',
        session_key: 'key-SECRET-4',
        attempt: { nonce: 'nonce-SECRET-5', location: { lat: 12.9716, lon: 77.5946 }, signature: 'sig-SECRET-6' },
        req: { headers: { authorization: 'Bearer SECRET-7', cookie: 'sid=SECRET-8' } },
      },
      'attempt received',
    );
    const out = text();
    for (const s of ['SECRET-1', 'SECRET-2', 'SECRET-3', 'SECRET-4', 'SECRET-5', 'SECRET-6', 'SECRET-7', 'SECRET-8']) {
      expect(out).not.toContain(s);
    }
    expect(out).not.toContain('12.9716');
    expect(out).toContain('[redacted]');
    expect(out).toContain('attempt received');
  });

  it('keeps non-sensitive fields', () => {
    const { logger, text } = capture();
    logger.info({ session_id: 'abc', decision: 'verified' }, 'ok');
    expect(text()).toContain('"decision":"verified"');
  });
});
