/**
 * Proxy-attendance penalty policy and privacy notice shown to students on
 * first sign-in (spec §1, §11, §13). Bump POLICY_VERSION whenever the text
 * changes: every student is asked to accept the new version.
 *
 * PLACEHOLDER WORDING: the college must review and replace the penalty
 * section before the pilot.
 */
export const POLICY_VERSION = '2026-09-draft-1';

export const POLICY_TEXT = `# Argus attendance policy

## How attendance works
- Mark attendance by scanning the rotating QR code shown in your classroom, using the Argus app on the phone registered to you.
- Your account works on one registered phone at a time. Changing phones takes up to 48 hours unless Academic Operations approves it sooner.

## Proxy attendance is not allowed
- Marking attendance for someone who is not in class, or letting someone mark it for you, is proxy attendance.
- Lending your registered phone or sharing your college login so someone else can mark your attendance counts as proxy attendance by you.
- Teachers do random spot checks. Confirmed proxy attendance leads to the penalties set by the college. [College to insert the exact penalties here.]

## Your privacy
- Argus reads your phone's location once, only at the moment you scan during an attendance round. There is no background tracking.
- Argus stores only whether you were on campus and how accurate the reading was, never your exact coordinates.
- Attempt details are deleted after 90 days; attendance records are kept as required by university rules.
- Evidence about your attendance is visible only to authorised staff, and every access is logged.
- Questions or corrections: contact Academic Operations.
`;
