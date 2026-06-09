/**
 * Local development seed. Refuses to run outside ARGUS_ENV=dev.
 *
 *   node --env-file-if-exists=.env scripts/seed-dev.ts [path/to/students.json]
 *
 * Creates a department, program, term, the "2nd Year 3rd Sem" section with
 * Batch 1 / Batch 2, a few staff accounts, and, if a roster file is given,
 * its students. From the roster only usn, name, institutional email, batch and
 * status are read; every other field (phones, birthdays, photos...) is ignored.
 */
import { readFileSync } from 'node:fs';
import { createDb } from '../src/db/index.ts';
import { migrateToLatest } from '../src/db/migrate.ts';
import { uuidv7 } from '../src/platform/ids.ts';

if (process.env.ARGUS_ENV !== 'dev') {
  console.error('seed-dev only runs with ARGUS_ENV=dev');
  process.exit(1);
}
const db = createDb(process.env.DATABASE_URL ?? 'postgres://argus@localhost:55432/argus');
const DOMAIN = process.env.OIDC_HOSTED_DOMAIN ?? 'svyasa-sas.edu.in';

async function one<T extends { id: string }>(table: string, where: Record<string, unknown>, values: Record<string, unknown>): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const k = db as any;
  let q = k.selectFrom(table).select('id');
  for (const [c, v] of Object.entries(where)) q = q.where(c, '=', v);
  const found = (await q.executeTakeFirst()) as T | undefined;
  if (found) return found.id;
  const id = uuidv7();
  await k.insertInto(table).values({ id, ...where, ...values }).execute();
  return id;
}

async function user(role: string, email: string, name: string): Promise<string> {
  const existing = await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
  if (existing) return existing.id;
  const id = uuidv7();
  await db.insertInto('users').values({ id, role: role as 'teacher', email, name }).execute();
  return id;
}

const { error } = await migrateToLatest(db);
if (error) throw error;

const dept = await one('departments', { code: 'CSE' }, { name: 'Computer Science and Engineering' });
const prog = await one('programs', { code: 'BTECH-CSE' }, { name: 'B.Tech CSE (Newton School of Technology)', department_id: dept });
const term = await one('terms', { name: '2026 Odd Semester' }, { start_date: '2026-08-01', end_date: '2026-12-20' });
const section = await one('sections', { term_id: term, program_id: prog, name: '2nd Year 3rd Sem' }, {});
const groups: Record<string, string> = {};
for (const g of ['Batch 1', 'Batch 2']) groups[g.toLowerCase()] = await one('section_groups', { section_id: section, name: g }, {});

await user('admin', `admin@${DOMAIN}`, 'Dev Admin');
await user('acadops', `acadops@${DOMAIN}`, 'Dev Acad Ops');
await user('verifier', `verifier@${DOMAIN}`, 'Dev Verifier');
const teacherId = await user('teacher', `teacher@${DOMAIN}`, 'Dev Teacher');
await db.insertInto('teachers').values({ user_id: teacherId, faculty_id: 'DEV-T1', department_id: dept }).onConflict((oc) => oc.doNothing()).execute();
const testStudent = await user('student', `student@${DOMAIN}`, 'Dev Student');
await db
  .insertInto('students')
  .values({ user_id: testStudent, usn: '0000000001', program_id: prog, section_id: section, group_id: groups['batch 1'] ?? null, admission_year: 2025 })
  .onConflict((oc) => oc.doNothing())
  .execute();

let imported = 0;
const file = process.argv[2];
if (file) {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[];
  for (const r of raw) {
    const usn = String(r.usn ?? '').trim();
    const name = String(r.name ?? '').trim().replace(/\s+/g, ' ');
    const email = String(r.institutional_email ?? '').trim().toLowerCase();
    if (!usn || !name || !email) continue;
    const status = ['left', 'inactive'].includes(String(r.status ?? '').toLowerCase()) ? 'disabled' : 'active';
    const group = groups[String(r.batch ?? '').trim().toLowerCase()] ?? null;
    const exists = await db.selectFrom('students').select('user_id').where('usn', '=', usn).executeTakeFirst();
    if (exists) continue;
    const id = uuidv7();
    await db.insertInto('users').values({ id, role: 'student', name, email, status }).onConflict((oc) => oc.doNothing()).execute();
    await db.insertInto('students').values({ user_id: id, usn, program_id: prog, section_id: section, group_id: group, admission_year: 2025 }).execute();
    imported++;
  }
}

console.log(`Seeded dev data. Staff: admin@, acadops@, verifier@, teacher@, student@${DOMAIN}. Students imported: ${imported}.`);
await db.destroy();
