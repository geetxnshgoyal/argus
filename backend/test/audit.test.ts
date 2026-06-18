import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { appendAudit, createCheckpoint, GENESIS_HASH, verifyAuditChain } from '../src/audit/audit.ts';
import type { Db } from '../src/db/index.ts';
import { closeTestDb, hasDb, resetDb, testDb } from './helpers/db.ts';

describe.skipIf(!hasDb)('audit log (integration)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await testDb();
    await resetDb(db);
  });
  afterAll(closeTestDb);

  async function write(n: number) {
    for (let i = 0; i < n; i++) {
      await db.transaction().execute((tx) =>
        appendAudit(tx, {
          actorId: null,
          action: 'room.update',
          entityType: 'room',
          entityId: `r${i}`,
          before: { capacity: 60, nested: { b: 2, a: 1 } },
          after: { capacity: 60 + i, note: 'x', when: new Date('2026-01-02T03:04:05.678Z') },
          ip: '10.0.0.1',
        }),
      );
    }
  }

  it('builds a linear chain from the genesis hash and verifies it', async () => {
    await write(5);
    const rows = await db.selectFrom('audit_log').select(['prev_hash', 'hash']).orderBy('id').execute();
    expect(rows[0]?.prev_hash).toBe(GENESIS_HASH);
    for (let i = 1; i < rows.length; i++) expect(rows[i]?.prev_hash).toBe(rows[i - 1]?.hash);
    const v = await verifyAuditChain(db);
    expect(v).toMatchObject({ ok: true, checked: 5 });
  });

  it('stays linear under concurrent appends', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        db.transaction().execute((tx) => appendAudit(tx, { actorId: null, action: 'x', entityType: 't', entityId: String(i) })),
      ),
    );
    expect((await verifyAuditChain(db)).ok).toBe(true);
  });

  it('blocks UPDATE, DELETE and TRUNCATE through the application connection', async () => {
    await write(1);
    await expect(sql`update audit_log set action = 'forged'`.execute(db)).rejects.toThrow(/append-only/);
    await expect(sql`delete from audit_log`.execute(db)).rejects.toThrow(/append-only/);
    await expect(sql`truncate audit_log`.execute(db)).rejects.toThrow(/append-only/);
  });

  it('detects a tampered row (spec §16: audit row tampered → verification fails)', async () => {
    await write(3);
    // Simulate an attacker with owner privileges bypassing the trigger.
    await sql`alter table audit_log disable trigger audit_log_no_update`.execute(db);
    await sql`update audit_log set after = '{"capacity":999}' where id = 2`.execute(db);
    await sql`alter table audit_log enable trigger audit_log_no_update`.execute(db);
    const v = await verifyAuditChain(db);
    expect(v.ok).toBe(false);
    expect(v.problem).toEqual({ id: '2', reason: 'row contents do not match its hash' });
  });

  it('detects a deleted row (broken link)', async () => {
    await write(3);
    await sql`alter table audit_log disable trigger audit_log_no_update`.execute(db);
    await sql`delete from audit_log where id = 2`.execute(db);
    await sql`alter table audit_log enable trigger audit_log_no_update`.execute(db);
    const v = await verifyAuditChain(db);
    expect(v.ok).toBe(false);
    expect(v.problem?.reason).toMatch(/broken link/);
  });

  it('detects a consistently rewritten chain via checkpoints', async () => {
    await write(2);
    await createCheckpoint(db);
    // Rewrite row 2 and recompute its hash so the chain itself looks valid again.
    await sql`alter table audit_log disable trigger audit_log_no_update`.execute(db);
    const { rows } = await sql<{ id: string }>`select id from audit_log order by id`.execute(db);
    await sql`delete from audit_log where id = ${rows[1]?.id}::bigint`.execute(db);
    await sql`alter table audit_log enable trigger audit_log_no_update`.execute(db);
    await db.transaction().execute((tx) => appendAudit(tx, { actorId: null, action: 'forged', entityType: 't' }));
    const v = await verifyAuditChain(db);
    expect(v.ok).toBe(false);
    expect(v.problem?.reason).toBe('checkpoint mismatch');
  });

  it('an empty log verifies', async () => {
    expect(await verifyAuditChain(db)).toMatchObject({ ok: true, checked: 0, lastHash: GENESIS_HASH });
  });
});
