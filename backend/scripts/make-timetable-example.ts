/**
 * Writes web/public/samples/timetable-example.xlsx: the college timetable
 * layout Acad Ops can download and follow. Regenerate with:
 *   node backend/scripts/make-timetable-example.ts
 */
import { writeFileSync } from 'node:fs';
import { buildCollegeTimetableXlsx } from '../test/helpers/timetable-sheet.ts';

const out = new URL('../../web/public/samples/timetable-example.xlsx', import.meta.url);
writeFileSync(out, await buildCollegeTimetableXlsx());
console.log(`Wrote ${out.pathname}`);
