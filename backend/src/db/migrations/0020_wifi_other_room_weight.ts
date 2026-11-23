import { sql, type Kysely } from 'kysely';

/**
 * ADR-0030: a scan whose phone hears only other classrooms' routers is a QR
 * relayed from another room, so it must flag on its own (threshold 30). The
 * old weight 15 never did. Leaves the weight alone if an admin changed it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`update risk_settings set value = 30 where key = 'wifi_other_room' and value = 15`.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('0020 is not reversible; set the weight on Anti-proxy checks instead');
}
