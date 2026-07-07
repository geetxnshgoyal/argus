import ExcelJS from 'exceljs';

/**
 * Parses the college's timetable spreadsheet (the Google Sheet grid, downloaded
 * as .xlsx) into normalized timetable rows.
 *
 * Layout understood (one block per weekday):
 *
 *   |            MONDAY (merged across)                                       |
 *   | 2nd Year 3rd Sem | 9:00-9.15 | 9:15-9.30 | 9:30-10:00 | ... | 6:00-6:30 |
 *   | BATCH 1          |  <cells; merged cells span time columns and rows>   |
 *   | BATCH 2          |                                                     |
 *
 * A cell merged across every batch row is a whole-section class; a cell in one
 * batch row is that batch's class (usually a lab). Cell text is
 * "<SUBJECT> <LEC|LAB|TUT|PRACTICAL> - <room>[, room…]". LUNCH/BREAK are skipped.
 */

export type SubjectKind = 'lecture' | 'lab' | 'tutorial';

export interface TimetableRow {
  /** Where it came from, e.g. "Monday D3:F4" or "CSV line 7". */
  ref: string;
  weekday: number;
  start: string; // HH:MM
  end: string;
  subjectCode: string;
  subjectKind: SubjectKind;
  batch: string | null; // null = whole section
  rooms: string[];
  teacherEmail: string | null;
  text: string;
}

export interface ParseIssue {
  ref: string;
  level: 'error' | 'warning';
  message: string;
}

const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const SKIP = /^(LUNCH|BREAK|TEA BREAK|FREE|-+)$/i;

/** "9:00-9.15" / "12:30 - 1:30" / "2:00–2:30" → ["09:00","09:15"], with afternoon inference. */
export function parseTimeRange(text: string): [string, string] | null {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*(am|pm)?\s*[-–—to]+\s*(\d{1,2})[:.](\d{2})\s*(am|pm)?\s*$/i.exec(text);
  if (!m) return null;
  const to24 = (h: number, ap: string | undefined) => {
    if (ap) return ap.toLowerCase() === 'pm' ? (h % 12) + 12 : h % 12;
    // College day runs roughly 8:00–20:00: bare 1–7 o'clock means afternoon.
    return h >= 1 && h <= 7 ? h + 12 : h;
  };
  const fmt = (h: number, min: string) => `${String(h).padStart(2, '0')}:${min}`;
  const sh = to24(Number(m[1]), m[3] ?? m[6]);
  const eh = to24(Number(m[4]), m[6] ?? m[3]);
  const start = fmt(sh, m[2] as string);
  const end = fmt(eh, m[5] as string);
  return end > start ? [start, end] : null;
}

const KIND_WORDS: Record<string, SubjectKind> = {
  LEC: 'lecture',
  LECTURE: 'lecture',
  LAB: 'lab',
  PRACTICAL: 'lab',
  TUT: 'tutorial',
  TUTORIAL: 'tutorial',
};

/** "AP LEC- Classroom 6" → {code: 'AP', kind: 'lecture', rooms: ['Classroom 6']}; "ADA LAB - Concept Room" → code 'ADA LAB'. */
export function parseCellText(raw: string): { code: string; kind: SubjectKind; rooms: string[] } | 'skip' | null {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (SKIP.test(text)) return 'skip';
  const dash = /\s*[-–—]\s*/.exec(text);
  const left = (dash ? text.slice(0, dash.index) : text).trim();
  const right = dash ? text.slice(dash.index + dash[0].length).trim() : '';
  const tokens = left.toUpperCase().split(' ').filter(Boolean);
  const last = tokens.at(-1) ?? '';
  const kindWord = KIND_WORDS[last] ? last : null;
  const kind = kindWord ? (KIND_WORDS[kindWord] as SubjectKind) : 'lecture';
  const base = (kindWord ? tokens.slice(0, -1) : tokens).join(' ');
  if (!base) return null;
  const code = kind === 'lecture' ? base : `${base} ${kindWord === 'PRACTICAL' ? 'PRACTICAL' : kind === 'lab' ? 'LAB' : 'TUT'}`;
  return { code, kind, rooms: parseRooms(right) };
}

/** "Classroom 1,4,6,8,Concept Room" → ["Classroom 1","Classroom 4","Classroom 6","Classroom 8","Concept Room"]. */
export function parseRooms(text: string): string[] {
  const out: string[] = [];
  let prefix = '';
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    if (/^\d+[A-Za-z]?$/.test(part) && prefix) {
      out.push(`${prefix} ${part}`);
      continue;
    }
    out.push(part);
    const m = /^(.*\S)\s+\d+[A-Za-z]?$/.exec(part);
    prefix = m ? (m[1] as string) : '';
  }
  return out;
}

function cellText(ws: ExcelJS.Worksheet, r: number, c: number): string {
  const cell = ws.getCell(r, c);
  const v = cell.text ?? '';
  return String(v).replace(/\s+/g, ' ').trim();
}

interface Region {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

function mergeRegions(ws: ExcelJS.Worksheet): Region[] {
  const merges: string[] = (ws.model as { merges?: string[] }).merges ?? [];
  return merges.map((m) => {
    const [a, b] = m.split(':') as [string, string];
    const tl = ws.getCell(a);
    const br = ws.getCell(b);
    return { r1: Number(tl.row), c1: Number(tl.col), r2: Number(br.row), c2: Number(br.col) };
  });
}

function colLetter(c: number): string {
  let s = '';
  for (let n = c; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export async function parseTimetableXlsx(data: Buffer): Promise<{ rows: TimetableRow[]; issues: ParseIssue[] }> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as unknown as ArrayBuffer);
  } catch {
    return { rows: [], issues: [{ ref: 'file', level: 'error', message: 'This file could not be read as an Excel (.xlsx) workbook.' }] };
  }
  const rows: TimetableRow[] = [];
  const issues: ParseIssue[] = [];

  for (const ws of wb.worksheets) {
    const regions = mergeRegions(ws);
    const regionAt = (r: number, c: number): Region =>
      regions.find((g) => r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2) ?? { r1: r, c1: c, r2: r, c2: c };
    const maxRow = ws.rowCount;
    const maxCol = ws.columnCount;

    for (let r = 1; r <= maxRow; r++) {
      // A day header: a row whose only text is a weekday name.
      const texts = Array.from({ length: maxCol }, (_, i) => cellText(ws, r, i + 1)).filter(Boolean);
      const dayIdx = texts.length > 0 && new Set(texts).size === 1 ? DAYS.indexOf((texts[0] as string).toUpperCase()) : -1;
      if (dayIdx < 0) continue;
      const weekday = dayIdx + 1;
      const dayName = (texts[0] as string).charAt(0) + (texts[0] as string).slice(1).toLowerCase();

      // Time header on the next row.
      const hr = r + 1;
      const cols = new Map<number, [string, string]>();
      for (let c = 2; c <= maxCol; c++) {
        const t = parseTimeRange(cellText(ws, hr, c));
        if (t) cols.set(c, t);
      }
      if (cols.size === 0) {
        issues.push({ ref: `${dayName} row ${hr}`, level: 'error', message: 'No time slots found under the day heading.' });
        continue;
      }

      // Batch rows until a blank row or the next day heading.
      const batchRows: { row: number; name: string }[] = [];
      for (let br = hr + 1; br <= maxRow; br++) {
        const label = cellText(ws, br, 1);
        if (!label) break;
        if (DAYS.includes(label.toUpperCase())) break;
        const m = /^batch\s*(\S+)$/i.exec(label);
        batchRows.push({ row: br, name: m ? `Batch ${m[1]}` : label });
      }
      if (batchRows.length === 0) {
        issues.push({ ref: `${dayName}`, level: 'error', message: 'No batch rows found (expected "BATCH 1", "BATCH 2"…).' });
        continue;
      }
      const firstRow = batchRows[0]!.row;
      const lastRow = batchRows.at(-1)!.row;

      const seen = new Set<string>();
      for (const b of batchRows) {
        for (const c of cols.keys()) {
          const g = regionAt(b.row, c);
          const key = `${g.r1}:${g.c1}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const text = cellText(ws, g.r1, g.c1);
          const ref = `${dayName} ${colLetter(g.c1)}${g.r1}${g.r1 !== g.r2 || g.c1 !== g.c2 ? `:${colLetter(g.c2)}${g.r2}` : ''}`;
          const parsed = parseCellText(text);
          if (parsed === null || parsed === 'skip') continue;

          const startCol = Math.max(g.c1, Math.min(...cols.keys()));
          const endCol = Math.min(g.c2, Math.max(...cols.keys()));
          const start = cols.get(startCol)?.[0];
          const end = cols.get(endCol)?.[1];
          if (!start || !end) {
            issues.push({ ref, level: 'error', message: `"${text}" is not under a time slot.` });
            continue;
          }
          const coveredRows = batchRows.filter((x) => x.row >= g.r1 && x.row <= g.r2);
          let batches: (string | null)[];
          if (g.r1 <= firstRow && g.r2 >= lastRow) batches = [null];
          else if (coveredRows.length === 1) batches = [coveredRows[0]!.name];
          else {
            issues.push({ ref, level: 'error', message: `"${text}" is merged across some batches but not all. Split it per batch, or merge it across all batches.` });
            continue;
          }
          if (parsed.rooms.length === 0) issues.push({ ref, level: 'warning', message: `"${text}" has no room.` });
          if (parsed.rooms.length > 1) {
            issues.push({ ref, level: 'warning', message: `"${text}" lists ${parsed.rooms.length} rooms; Argus records the first (${parsed.rooms[0]}).` });
          }
          for (const batch of batches) {
            rows.push({ ref, weekday, start, end, subjectCode: parsed.code, subjectKind: parsed.kind, batch, rooms: parsed.rooms, teacherEmail: null, text });
          }
        }
      }
    }
  }
  if (rows.length === 0 && !issues.some((i) => i.level === 'error')) {
    issues.push({ ref: 'file', level: 'error', message: 'No classes found. Is this the timetable sheet (with MONDAY, TUESDAY… headings)?' });
  }
  return { rows, issues };
}
