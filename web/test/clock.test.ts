import { describe, expect, it } from 'vitest';
import { estimateClockOffset, syncClock } from '../src/lib/clock.ts';

describe('estimateClockOffset', () => {
  it('is zero when clocks agree and delay is symmetric', () => {
    expect(estimateClockOffset(1000, 1050, 1100)).toBe(0);
  });

  it('detects a client clock running behind the server', () => {
    // Client thinks 1000..1100; server said 6050 at the midpoint → client is 5 s behind.
    expect(estimateClockOffset(1000, 6050, 1100)).toBe(5000);
  });

  it('detects a client clock running ahead', () => {
    expect(estimateClockOffset(10_000, 7_050, 10_100)).toBe(-3000);
  });
});

describe('syncClock', () => {
  it('keeps the sample with the smallest round trip', async () => {
    const serverOffset = 2000;
    const delays = [300, 40, 200]; // round-trip per sample
    let t = 0;
    let call = 0;
    const now = () => t;
    const fetchImpl = (async () => {
      const rtt = delays[call++] ?? 100;
      t += rtt / 2; // request travels
      const server = t + serverOffset;
      t += rtt / 2; // response travels
      return new Response(JSON.stringify({ server_time_ms: server, server_time: new Date(server).toISOString() }), {
        status: 200,
      });
    }) as typeof fetch;

    const sync = await syncClock(3, { fetchImpl, now });
    expect(sync.rttMs).toBe(40);
    expect(sync.offsetMs).toBe(serverOffset);
  });
});
