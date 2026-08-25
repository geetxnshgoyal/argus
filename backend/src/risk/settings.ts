import type { DbOrTx } from '../db/index.ts';

/**
 * Scorer weights, kill switches and thresholds (ADR-0014). Stored in
 * `risk_settings`, editable by admins, cached for a few seconds so a change
 * takes effect without a restart. Missing rows fall back to the defaults
 * below (the same values the migration seeds), never to zero.
 */

export interface RiskSetting {
  value: number;
  enabled: boolean;
}

export type RiskSettings = Map<string, RiskSetting>;

export const RISK_META: Record<string, { kind: 'scorer' | 'threshold' | 'setting'; value: number; description: string }> = {
  location_mock: { kind: 'scorer', value: 70, description: 'The phone reported a fake (mock) location.' },
  location_poor_accuracy: { kind: 'scorer', value: 20, description: 'Location accuracy worse than 100 m, or no location fix.' },
  not_campus_network: { kind: 'scorer', value: 15, description: 'The scan did not come from a campus network.' },
  late_in_window: { kind: 'scorer', value: 10, description: 'The QR code used was from the previous 3-second step.' },
  device_recently_rebound: { kind: 'scorer', value: 15, description: 'The phone was registered in the last 7 days.' },
  attestation_unavailable: { kind: 'scorer', value: 20, description: 'Google/Apple could not be reached to check the app.' },
  attestation_missing: { kind: 'scorer', value: 35, description: 'The app could not produce an integrity token.' },
  recent_flag_history: { kind: 'scorer', value: 10, description: 'Points per unresolved flag in the last 14 days.' },
  recent_flag_history_cap: { kind: 'setting', value: 30, description: 'Maximum points from recent flags.' },
  threshold_flagged: { kind: 'threshold', value: 30, description: 'Score at which an attempt is flagged.' },
  threshold_flagged_high: { kind: 'threshold', value: 70, description: 'Score at which an attempt is flagged high.' },
  support_approval_threshold: { kind: 'threshold', value: 30, description: 'Verifiers can approve a support request only below this evidence score (and with a valid QR scan).' },
  recheck_random_sample: { kind: 'setting', value: 3, description: 'Random verified students added to a targeted recheck.' },
  spot_check_flagged_max: { kind: 'setting', value: 5, description: 'Flagged students suggested per spot check.' },
  spot_check_random: { kind: 'setting', value: 3, description: 'Random verified students suggested per spot check.' },
  headcount_tolerance: { kind: 'setting', value: 2, description: 'Extra present students allowed over the headcount.' },
  late_after_minutes: { kind: 'setting', value: 10, description: 'A recheck opened this long after class start marks new scans late.' },
};

export const RISK_DEFAULTS: Record<string, number> = Object.fromEntries(Object.entries(RISK_META).map(([k, m]) => [k, m.value]));

const TTL_MS = 5000;

/** Per-process cache (lives on the AppContext). */
export class RiskSettingsStore {
  private cache: { at: number; settings: RiskSettings } | null = null;

  async load(db: DbOrTx, now: number): Promise<RiskSettings> {
    if (this.cache && now - this.cache.at < TTL_MS && now >= this.cache.at) return this.cache.settings;
    const rows = await db.selectFrom('risk_settings').select(['key', 'value', 'enabled']).execute();
    const settings: RiskSettings = new Map(rows.map((r) => [r.key, { value: r.value, enabled: r.enabled }]));
    this.cache = { at: now, settings };
    return settings;
  }

  invalidate(): void {
    this.cache = null;
  }
}

/** A setting's value, or its default. Disabled settings still return their value. */
export function num(s: RiskSettings, key: string, fallback = RISK_DEFAULTS[key] ?? 0): number {
  return s.get(key)?.value ?? fallback;
}
