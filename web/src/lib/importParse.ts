import Papa from 'papaparse';

/**
 * Turns an uploaded roster file into the minimal rows Argus needs.
 *
 * Runs entirely in the browser. Only usn, name, email, batch and status are
 * kept; every other field in the file (phone numbers, birthdays, blood group,
 * photos, IDs...) is dropped before anything is sent to the server.
 */

export interface RosterRow {
  usn: string | null;
  name: string | null;
  email: string | null;
  batch: string | null;
  status: string | null;
}

export interface ParseResult {
  rows: RosterRow[];
  /** Columns found in the file that Argus will ignore (shown to the user for transparency). */
  ignored: string[];
  format: 'json' | 'csv';
}

const ALIASES: Record<keyof RosterRow, string[]> = {
  usn: ['usn', 'usn_no', 'roll_no', 'rollno', 'register_number', 'reg_no', 'student_id'],
  name: ['name', 'full_name', 'student_name'],
  // Prefer the institutional email: that is what college sign-in uses.
  email: ['institutional_email', 'college_email', 'official_email', 'email'],
  batch: ['batch', 'lab_batch', 'group'],
  status: ['status'],
};

const norm = (k: string) => k.trim().toLowerCase().replace(/[\s-]+/g, '_');

function pick(record: Record<string, unknown>, field: keyof RosterRow): string | null {
  const keys = new Map(Object.keys(record).map((k) => [norm(k), k]));
  for (const alias of ALIASES[field]) {
    const original = keys.get(alias);
    if (original === undefined) continue;
    const v = record[original];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

function known(key: string): boolean {
  const k = norm(key);
  return Object.values(ALIASES).some((a) => a.includes(k));
}

function fromRecords(records: Record<string, unknown>[], format: 'json' | 'csv'): ParseResult {
  const ignored = new Set<string>();
  const rows = records.map((r) => {
    for (const k of Object.keys(r)) if (!known(k)) ignored.add(k);
    return { usn: pick(r, 'usn'), name: pick(r, 'name'), email: pick(r, 'email'), batch: pick(r, 'batch'), status: pick(r, 'status') };
  });
  return { rows, ignored: [...ignored].sort(), format };
}

export function parseRoster(fileName: string, text: string): ParseResult {
  const trimmed = text.trimStart();
  if (fileName.toLowerCase().endsWith('.json') || trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('This JSON file could not be read. Check that it is a valid export.');
    }
    // Accept a bare array, or an object wrapping one (e.g. {"students": [...]}).
    const list = Array.isArray(data)
      ? data
      : data && typeof data === 'object'
        ? Object.values(data as Record<string, unknown>).find(Array.isArray)
        : undefined;
    if (!Array.isArray(list)) throw new Error('No list of students was found in this JSON file.');
    return fromRecords(list.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object'), 'json');
  }
  const parsed = Papa.parse<Record<string, unknown>>(text, { header: true, skipEmptyLines: 'greedy' });
  if (parsed.errors.length && !parsed.data.length) throw new Error('This CSV file could not be read.');
  return fromRecords(parsed.data, 'csv');
}
