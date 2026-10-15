import { createHash } from 'node:crypto';
import type { DbOrTx } from './db/index.ts';

/**
 * Proxy-attendance penalty policy and privacy notice shown to students on
 * first sign-in (spec §1, §11, §13). Bump POLICY_VERSION whenever the text
 * changes: every student is asked to accept the new version.
 *
 * The penalties are the college's own words, set by an admin on Anti-proxy
 * checks (app_settings.policy_penalties). Changing them changes the version, so
 * students accept again.
 */
export const POLICY_VERSION = '2026-10-1';

/** Used until the college writes its own. */
export const DEFAULT_PENALTIES = 'Confirmed proxy attendance is treated as academic misconduct under the college\'s rules.';

const POLICY_TEMPLATE = `# Argus attendance policy

## How attendance works
- Mark attendance by scanning the rotating QR code shown in your classroom, using the Argus app on the phone registered to you.
- Your account works on one registered phone at a time. Changing phones takes up to 48 hours unless Academic Operations approves it sooner.

## Proxy attendance is not allowed
- Marking attendance for someone who is not in class, or letting someone mark it for you, is proxy attendance.
- Lending your registered phone or sharing your college login so someone else can mark your attendance counts as proxy attendance by you.
- Teachers do random spot checks. {{penalties}}

## Your privacy
- Argus reads your phone's location once, only at the moment you scan during an attendance round. There is no background tracking.
- Argus stores only whether you were on campus and how accurate the reading was, never your exact coordinates.
- Attempt details are deleted after 90 days; attendance records are kept as required by university rules.
- Evidence about your attendance is visible only to authorised staff, and every access is logged.
- Questions or corrections: contact Academic Operations.
`;

/** The policy built from the template; exported for tests and the default text. */
export function policyText(penalties: string | null): string {
  return POLICY_TEMPLATE.replace('{{penalties}}', penalties?.trim() || DEFAULT_PENALTIES);
}

/** The policy students must accept now: the college's penalties, and a version that changes with them. */
export async function currentPolicy(db: DbOrTx): Promise<{ version: string; text: string; penalties: string | null }> {
  const row = await db.selectFrom('app_settings').select('value').where('key', '=', 'policy_penalties').executeTakeFirst();
  const penalties = typeof row?.value === 'string' && row.value.trim() !== '' ? row.value.trim() : null;
  const version = penalties ? `${POLICY_VERSION}.${createHash('sha256').update(penalties).digest('hex').slice(0, 8)}` : POLICY_VERSION;
  return { version, text: policyText(penalties), penalties };
}
