import { sql } from 'kysely';
import type { Db, DbOrTx, Tx } from '../db/index.ts';
import { sha256Hex } from '../platform/crypto.ts';
import { canonicalize } from '../platform/jcs.ts';

/**
 * Append-only, hash-chained audit log (spec §9, ADR-0013).
 *
 *   hash = SHA256( prev_hash ‖ JCS(row without id and hash) )
 *
 * Appends take a transaction-scoped advisory lock so the chain stays linear
 * under concurrency. Always append in the same transaction as the change
 * being audited, so a change can never commit without its audit row.
 */

export const GENESIS_HASH = '0'.repeat(64);
const AUDIT_LOCK_KEY = 0x41524755; // "ARGU"

export interface AuditEntry {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

interface ChainRow {
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  at: string;
  prev_hash: string;
}

/** JSON round-trip so hashed values equal what jsonb gives back (drops undefined, Dates → ISO strings). */
function normalize(v: unknown): unknown {
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}

export function computeHash(row: ChainRow): string {
  return sha256Hex(row.prev_hash + canonicalize(row));
}

export async function appendAudit(tx: Tx, e: AuditEntry, now: Date = new Date()): Promise<string> {
  await sql`select pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`.execute(tx);
  const last = await tx.selectFrom('audit_log').select('hash').orderBy('id', 'desc').limit(1).executeTakeFirst();
  const row: ChainRow = {
    actor_id: e.actorId,
    action: e.action,
    entity_type: e.entityType,
    entity_id: e.entityId ?? null,
    before: normalize(e.before),
    after: normalize(e.after),
    ip: e.ip ?? null,
    at: new Date(Math.floor(now.getTime())).toISOString(),
    prev_hash: last?.hash ?? GENESIS_HASH,
  };
  const hash = computeHash(row);
  await tx
    .insertInto('audit_log')
    .values({
      ...row,
      before: row.before === null ? null : JSON.stringify(row.before),
      after: row.after === null ? null : JSON.stringify(row.after),
      hash,
    })
    .execute();
  return hash;
}

/** Runs `fn` in a transaction and audits it atomically. */
export async function withAudit<T>(db: Db, entry: (result: T) => AuditEntry, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (tx) => {
    const result = await fn(tx);
    await appendAudit(tx, entry(result));
    return result;
  });
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  lastId: string | null;
  lastHash: string;
  problem?: { id: string; reason: string };
}

/** Walks the whole chain in id order and recomputes every hash. */
export async function verifyAuditChain(db: DbOrTx, batchSize = 1000): Promise<VerifyResult> {
  let prev = GENESIS_HASH;
  let afterId = '0';
  let checked = 0;
  let lastId: string | null = null;
  for (;;) {
    const rows = await db
      .selectFrom('audit_log')
      .selectAll()
      .where(sql<boolean>`id > ${afterId}::bigint`)
      .orderBy('id')
      .limit(batchSize)
      .execute();
    if (rows.length === 0) break;
    for (const r of rows) {
      if (r.prev_hash !== prev) {
        return { ok: false, checked, lastId, lastHash: prev, problem: { id: String(r.id), reason: 'broken link (prev_hash mismatch)' } };
      }
      const expected = computeHash({
        actor_id: r.actor_id,
        action: r.action,
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        before: r.before ?? null,
        after: r.after ?? null,
        ip: r.ip,
        at: new Date(r.at).toISOString(),
        prev_hash: r.prev_hash,
      });
      if (expected !== r.hash) {
        return { ok: false, checked, lastId, lastHash: prev, problem: { id: String(r.id), reason: 'row contents do not match its hash' } };
      }
      prev = r.hash;
      lastId = String(r.id);
      afterId = lastId;
      checked++;
    }
  }

  // Every recorded checkpoint must still be on the chain.
  const checkpoints = await db.selectFrom('audit_checkpoints').selectAll().orderBy('id').execute();
  for (const cp of checkpoints) {
    const row = await db.selectFrom('audit_log').select('hash').where('id', '=', cp.last_audit_id).executeTakeFirst();
    if (!row || row.hash !== cp.last_hash) {
      return { ok: false, checked, lastId, lastHash: prev, problem: { id: String(cp.last_audit_id), reason: 'checkpoint mismatch' } };
    }
  }
  return { ok: true, checked, lastId, lastHash: prev };
}

/** Records the current chain head; the job that calls this also exports it outside the DB (ADR-0013). */
export async function createCheckpoint(db: Db): Promise<{ lastAuditId: string; lastHash: string } | null> {
  const head = await db.selectFrom('audit_log').select(['id', 'hash']).orderBy('id', 'desc').limit(1).executeTakeFirst();
  if (!head) return null;
  await db.insertInto('audit_checkpoints').values({ last_audit_id: String(head.id), last_hash: head.hash }).execute();
  return { lastAuditId: String(head.id), lastHash: head.hash };
}
