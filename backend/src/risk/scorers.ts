import type { AttemptDecision } from '../db/schema.ts';
import type { LocationResult } from '../geo/geofence.ts';
import { num, RISK_DEFAULTS, type RiskSettings } from './settings.ts';

/**
 * Pluggable risk scorers (spec §6 soft signals, §12 hook). Each scorer looks
 * at the facts of one attempt (and, in Phase 2, presence observations) and
 * returns points plus reason codes. Weights and kill switches come from
 * `risk_settings`, so a misbehaving signal can be switched off from the admin
 * app without a redeploy. Soft signals never reject.
 */

export interface AttemptFacts {
  location: LocationResult;
  /** null = campus networks not configured, so the signal is skipped. */
  campusNetwork: boolean | null;
  lateInWindow: boolean;
  deviceActivatedAt: Date | null;
  attestation: 'ok' | 'unavailable' | 'missing' | 'bypass';
  /** Unresolved risk flags for this student in the last 14 days. */
  recentFlags: number;
  now: Date;
}

export interface PresenceObservation {
  source: string;
  observedAt: Date;
  data: unknown;
}

export interface ScoreResult {
  points: number;
  flags: string[];
}

export interface Scorer {
  /** Also the risk_settings key holding its weight and kill switch. */
  name: string;
  score(facts: AttemptFacts, observations: PresenceObservation[], weight: number, settings: RiskSettings): ScoreResult;
}

const none: ScoreResult = { points: 0, flags: [] };
const hit = (name: string, weight: number): ScoreResult => ({ points: weight, flags: [name] });

export const SCORERS: Scorer[] = [
  { name: 'location_mock', score: (f, _o, w) => (f.location.is_mock ? hit('location_mock', w) : none) },
  {
    name: 'location_poor_accuracy',
    // No (fresh) fix, or accuracy worse than 100 m. Missing geofence config is not the student's fault.
    score: (f, _o, w) => (f.location.accuracy_m === null || f.location.accuracy_m > 100 ? hit('location_poor_accuracy', w) : none),
  },
  { name: 'not_campus_network', score: (f, _o, w) => (f.campusNetwork === false ? hit('not_campus_network', w) : none) },
  { name: 'late_in_window', score: (f, _o, w) => (f.lateInWindow ? hit('late_in_window', w) : none) },
  {
    name: 'device_recently_rebound',
    score: (f, _o, w) => (f.deviceActivatedAt && f.now.getTime() - f.deviceActivatedAt.getTime() < 7 * 24 * 3600_000 ? hit('device_recently_rebound', w) : none),
  },
  { name: 'attestation_unavailable', score: (f, _o, w) => (f.attestation === 'unavailable' ? hit('attestation_unavailable', w) : none) },
  { name: 'attestation_missing', score: (f, _o, w) => (f.attestation === 'missing' ? hit('attestation_missing', w) : none) },
  {
    name: 'recent_flag_history',
    score: (f, _o, w, s) => (f.recentFlags > 0 ? { points: Math.min(f.recentFlags * w, num(s, 'recent_flag_history_cap', 30)), flags: ['recent_flag_history'] } : none),
  },
];

export interface Assessment {
  score: number;
  flags: string[];
  decision: Exclude<AttemptDecision, 'rejected'>;
}

export function assess(facts: AttemptFacts, settings: RiskSettings, observations: PresenceObservation[] = [], scorers: Scorer[] = SCORERS): Assessment {
  let score = 0;
  const flags: string[] = [];
  for (const s of scorers) {
    const cfg = settings.get(s.name);
    if (cfg && !cfg.enabled) continue;
    const r = s.score(facts, observations, cfg?.value ?? RISK_DEFAULTS[s.name] ?? 0, settings);
    score += r.points;
    flags.push(...r.flags);
  }
  return { score, flags, decision: decide(score, settings) };
}

export function decide(score: number, settings: RiskSettings): Assessment['decision'] {
  if (score >= num(settings, 'threshold_flagged_high', 70)) return 'flagged_high';
  if (score >= num(settings, 'threshold_flagged', 30)) return 'flagged';
  return 'verified';
}

/** Plain-language reasons for teachers (spec §11 "Flagged list with plain-language reasons"). */
export const REASON_TEXT: Record<string, string> = {
  location_mock: 'Phone reported a fake location',
  location_poor_accuracy: 'Location was unclear',
  not_campus_network: 'Not on the campus network',
  late_in_window: 'Scanned an older QR code',
  device_recently_rebound: 'Phone registered this week',
  attestation_unavailable: 'App check unavailable',
  attestation_missing: 'App check missing',
  recent_flag_history: 'Flagged in recent classes',
  offline_queued: 'Sent later from offline',
  missed_recheck: 'Missed a recheck',
  spot_check_absent: 'Not in the room at spot check',
  spot_check_no_response: 'No response at spot check',
};
