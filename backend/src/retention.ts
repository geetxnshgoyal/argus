import { sql } from 'kysely';
import type { AppContext } from './context.ts';

/**
 * Retention (spec §13, DPDP minimization). Runs once a day.
 *
 * - Attempt signals: after 90 days the minimized signals and the phone's clock
 *   reading are cleared. The decision, reason codes and risk score stay, so
 *   attendance history and audits still explain themselves.
 * - Risk-flag details: cleared after 90 days; type, severity and resolution stay.
 * - Sign-in leftovers: expired login states, one-time codes and bind challenges
 *   are deleted; web sessions (with their IP and browser) and refresh tokens
 *   are deleted 30 days after they expired or were revoked.
 *
 * Attendance records, support requests, corrections and the audit log are kept
 * as university policy requires; they are never touched here.
 */
export const SIGNAL_RETENTION_DAYS = 90;
export const SIGN_IN_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;

export interface RetentionResult {
  attemptSignalsCleared: number;
  flagDetailsCleared: number;
  signInRowsDeleted: number;
}

export async function runRetention(ctx: AppContext): Promise<RetentionResult> {
  const now = new Date(ctx.now());
  const signalCutoff = new Date(ctx.now() - SIGNAL_RETENTION_DAYS * DAY_MS);
  const signInCutoff = new Date(ctx.now() - SIGN_IN_RETENTION_DAYS * DAY_MS);

  return ctx.db.transaction().execute(async (tx) => {
    const attempts = await tx
      .updateTable('attendance_attempts')
      .set({ signals: null, device_time: null })
      .where('received_at', '<', signalCutoff)
      .where((eb) => eb.or([eb('signals', 'is not', null), eb('device_time', 'is not', null)]))
      .executeTakeFirst();

    const flags = await tx
      .updateTable('risk_flags')
      .set({ details: null })
      .where('created_at', '<', signalCutoff)
      .where('details', 'is not', null)
      .executeTakeFirst();

    let signIn = 0;
    const count = (r: { numDeletedRows: bigint }) => (signIn += Number(r.numDeletedRows));
    count(await tx.deleteFrom('oidc_login_states').where('expires_at', '<', now).executeTakeFirst());
    count(await tx.deleteFrom('mobile_auth_codes').where('expires_at', '<', now).executeTakeFirst());
    count(await tx.deleteFrom('device_bind_challenges').where('expires_at', '<', now).executeTakeFirst());
    count(await tx.deleteFrom('web_sessions').where(sql<boolean>`coalesce(revoked_at, expires_at) < ${signInCutoff}`).executeTakeFirst());
    // A whole refresh-token family goes at once, so reuse detection never sees half a family.
    count(
      await tx
        .deleteFrom('refresh_tokens')
        .where('family_id', 'in', (eb) =>
          eb
            .selectFrom('refresh_tokens')
            .select('family_id')
            .groupBy('family_id')
            .having(sql<boolean>`max(coalesce(revoked_at, expires_at)) < ${signInCutoff}`),
        )
        .executeTakeFirst(),
    );

    return {
      attemptSignalsCleared: Number(attempts.numUpdatedRows),
      flagDetailsCleared: Number(flags.numUpdatedRows),
      signInRowsDeleted: signIn,
    };
  });
}
