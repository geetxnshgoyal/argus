import type { components } from '../generated/api.ts';
import { apiGet } from './api.ts';

type ServerTime = components['schemas']['ServerTime'];

/**
 * Server time is authoritative. Clients estimate `offset` so that
 * `Date.now() + offset` ≈ server time, assuming symmetric network delay
 * (the NTP-style midpoint estimate).
 */
export function estimateClockOffset(sentAtMs: number, serverMs: number, receivedAtMs: number): number {
  const midpoint = sentAtMs + (receivedAtMs - sentAtMs) / 2;
  return Math.round(serverMs - midpoint);
}

export interface ClockSync {
  offsetMs: number;
  /** Round-trip time of the best sample; the offset error is at most half of this. */
  rttMs: number;
}

/**
 * Takes several samples and keeps the one with the smallest round trip,
 * which has the tightest error bound.
 */
export async function syncClock(
  samples = 5,
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<ClockSync> {
  const now = deps.now ?? Date.now;
  let best: ClockSync | undefined;
  for (let i = 0; i < samples; i++) {
    const sent = now();
    const t = await apiGet<ServerTime>('/v1/time', deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
    const received = now();
    const sample = { offsetMs: estimateClockOffset(sent, t.server_time_ms, received), rttMs: received - sent };
    if (!best || sample.rttMs < best.rttMs) best = sample;
  }
  if (!best) throw new Error('syncClock needs at least one sample');
  return best;
}
