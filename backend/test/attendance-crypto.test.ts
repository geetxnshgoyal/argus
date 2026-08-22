import { describe, expect, it } from 'vitest';
import {
  checkEpochWindow,
  checkOfflineEpoch,
  computeTag,
  decryptKs,
  deriveKble,
  deriveKqr,
  encryptKs,
  formatQr,
  generateKs,
  verifyTag,
} from '../src/attendance/crypto.ts';
import { evaluateLocation, distanceOutside } from '../src/geo/geofence.ts';
import { assess } from '../src/risk/scorers.ts';

/**
 * Test vectors (protocol.md §7). Cross-checked with an independent Python
 * implementation (hmac/hashlib); the web display test uses the same values.
 */
export const VECTORS = {
  ks: Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
  sessionId: '01923b6e-7c2a-7d4e-8f00-0123456789ab',
  cases: [
    { round: 1, epoch: 0, kqr: '58BLCxoM3Wo7nThwsJtyjY60hhpWElv8Jq8SmIEv4N0', tag: 'akVShuIFylEuGxrB' },
    { round: 1, epoch: 1234, kqr: '58BLCxoM3Wo7nThwsJtyjY60hhpWElv8Jq8SmIEv4N0', tag: 'cCQrbMuIfbZejtJP' },
    { round: 2, epoch: 1234, kqr: 'mPBYE7kewskoTgaNm9fAQh1ZrdCrwX5XHhEmcU1OCpM', tag: 'Y2dQF4G2KPW0Xt_w' },
  ],
};

describe('QR crypto (protocol §3, §5.3)', () => {
  it.each(VECTORS.cases)('round $round epoch $epoch matches the test vector', ({ round, epoch, kqr, tag }) => {
    const k = deriveKqr(VECTORS.ks, VECTORS.sessionId, round);
    expect(k.toString('base64url')).toBe(kqr);
    expect(computeTag(k, VECTORS.sessionId, round, epoch).toString('base64url')).toBe(tag);
    expect(formatQr(VECTORS.sessionId, round, epoch, computeTag(k, VECTORS.sessionId, round, epoch))).toBe(`argus://a/${VECTORS.sessionId}/${round}/${epoch}/${tag}`);
  });

  it('tags never collide across rounds, epochs or sessions', () => {
    const k1 = deriveKqr(VECTORS.ks, VECTORS.sessionId, 1);
    const t = computeTag(k1, VECTORS.sessionId, 1, 5);
    expect(verifyTag(k1, VECTORS.sessionId, 1, 5, t)).toBe(true);
    expect(verifyTag(k1, VECTORS.sessionId, 1, 6, t)).toBe(false);
    expect(verifyTag(deriveKqr(VECTORS.ks, VECTORS.sessionId, 2), VECTORS.sessionId, 2, 5, t)).toBe(false);
    const other = '01923b6e-7c2a-7d4e-8f00-0123456789ac';
    expect(verifyTag(deriveKqr(VECTORS.ks, other, 1), other, 1, 5, t)).toBe(false);
    expect(verifyTag(k1, VECTORS.sessionId, 1, 5, t.subarray(0, 11))).toBe(false);
  });

  it('the BLE key (Phase 2) is separate from every QR key', () => {
    const ble = deriveKble(VECTORS.ks, VECTORS.sessionId);
    for (const r of [1, 2, 3]) expect(ble.equals(deriveKqr(VECTORS.ks, VECTORS.sessionId, r))).toBe(false);
  });

  it('K_s ciphertext is bound to its session (cannot be moved)', () => {
    const master = Buffer.alloc(32, 7);
    const ks = generateKs();
    const ct = encryptKs(master, VECTORS.sessionId, ks);
    expect(ct).toHaveLength(12 + 32 + 16);
    expect(decryptKs(master, VECTORS.sessionId, ct).equals(ks)).toBe(true);
    expect(() => decryptKs(master, '01923b6e-7c2a-7d4e-8f00-0123456789ac', ct)).toThrow();
    expect(() => decryptKs(Buffer.alloc(32, 8), VECTORS.sessionId, ct)).toThrow();
    const flipped = Buffer.from(ct);
    flipped[20] = (flipped[20] as number) ^ 1;
    expect(() => decryptKs(master, VECTORS.sessionId, flipped)).toThrow();
  });
});

describe('epoch window (protocol §5.5)', () => {
  const t0 = 1_000_000;
  it('accepts the current epoch', () => {
    expect(checkEpochWindow(10, t0 + 30_000, t0)).toEqual({ valid: true, lateInWindow: false });
  });
  it('accepts the previous epoch for 2000 ms after the boundary, flagged late', () => {
    expect(checkEpochWindow(9, t0 + 30_000 + 2000, t0)).toEqual({ valid: true, lateInWindow: true });
    expect(checkEpochWindow(9, t0 + 30_000 + 2001, t0).valid).toBe(false);
  });
  it('rejects older and future epochs', () => {
    expect(checkEpochWindow(8, t0 + 30_000, t0).valid).toBe(false);
    expect(checkEpochWindow(11, t0 + 30_000, t0).valid).toBe(false);
  });
  it('offline-queued: ±1 epoch around device_time', () => {
    expect(checkOfflineEpoch(10, t0 + 30_500, t0)).toBe(true);
    expect(checkOfflineEpoch(11, t0 + 30_500, t0)).toBe(true);
    expect(checkOfflineEpoch(12, t0 + 30_500, t0)).toBe(false);
  });
});

describe('geofence (spec §6 step 8)', () => {
  const campus = { center_lat: 12.9716, center_lon: 77.5946, radius_m: 300, polygon: null };
  const fix = (lat: number, lon: number, accuracy_m = 10, is_mock = false, fix_age_ms = 1000) => ({ lat, lon, accuracy_m, is_mock, fix_age_ms });

  it('inside, outside and rounding to 50 m', () => {
    expect(evaluateLocation(fix(12.9716, 77.5946), [campus])).toMatchObject({ result: 'inside', distance_m: 0, clearlyOff: false });
    const out = evaluateLocation(fix(12.9816, 77.5946), [campus]); // ~1.1 km north
    expect(out.result).toBe('outside');
    expect(out.distance_m! % 50).toBe(0);
    expect(out.clearlyOff).toBe(true);
  });
  it('not clearly off when accuracy is poor, the radius covers the gap, or the fix is mocked', () => {
    expect(evaluateLocation(fix(12.9816, 77.5946, 150), [campus]).clearlyOff).toBe(false);
    expect(evaluateLocation(fix(12.9750, 77.5946, 100), [campus]).clearlyOff).toBe(false); // ~78 m outside, within the 100 m accuracy
    expect(evaluateLocation(fix(12.9816, 77.5946, 10, true), [campus]).clearlyOff).toBe(false);
  });
  it('stale fixes and missing geofences are "unknown"', () => {
    expect(evaluateLocation(fix(12.9716, 77.5946, 10, false, 31_000), [campus])).toMatchObject({ result: 'unknown', accuracy_m: null });
    expect(evaluateLocation(fix(12.9716, 77.5946), [])).toMatchObject({ result: 'unknown', clearlyOff: false });
    expect(evaluateLocation(null, [campus])).toMatchObject({ result: 'unknown', accuracy_m: null });
  });
  it('polygons', () => {
    const square = { center_lat: 0, center_lon: 0, radius_m: 1, polygon: [[12.97, 77.59], [12.97, 77.6], [12.98, 77.6], [12.98, 77.59]] as [number, number][] };
    expect(distanceOutside(square, 12.975, 77.595)).toBe(0);
    expect(distanceOutside(square, 12.99, 77.595)).toBeGreaterThan(1000);
  });
});

describe('risk scoring (spec §6 soft signals, ADR-0010, ADR-0014)', () => {
  const base = {
    location: { result: 'inside' as const, distance_m: 0, accuracy_m: 10, is_mock: false, clearlyOff: false },
    campusNetwork: true,
    lateInWindow: false,
    deviceActivatedAt: new Date('2026-01-01'),
    attestation: 'ok' as const,
    recentFlags: 0,
    now: new Date('2026-09-21'),
  };
  it('clean attempt → verified', () => {
    expect(assess(base, new Map())).toMatchObject({ score: 0, decision: 'verified' });
  });
  it('mock location alone → flagged_high (weight 70)', () => {
    expect(assess({ ...base, location: { ...base.location, is_mock: true } }, new Map())).toMatchObject({ score: 70, decision: 'flagged_high' });
  });
  it('signals add up; recent flags are capped at 30', () => {
    const r = assess({ ...base, campusNetwork: false, lateInWindow: true, recentFlags: 9 }, new Map());
    expect(r.score).toBe(15 + 10 + 30);
    expect(r.decision).toBe('flagged');
  });
  it('a disabled scorer is skipped (kill switch without redeploy)', () => {
    const settings = new Map([['location_mock', { value: 70, enabled: false }]]);
    expect(assess({ ...base, location: { ...base.location, is_mock: true } }, settings).decision).toBe('verified');
  });
  it('thresholds come from settings', () => {
    const settings = new Map([['threshold_flagged', { value: 10, enabled: true }]]);
    expect(assess({ ...base, lateInWindow: true }, settings).decision).toBe('flagged');
  });
});
