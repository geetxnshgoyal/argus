import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseCellText, parseRooms, parseTimeRange, parseTimetableXlsx } from '../src/timetable/import-parse.ts';
import { buildCollegeTimetableXlsx } from './helpers/timetable-sheet.ts';

describe('parseTimeRange', () => {
  it.each([
    ['9:00-9.15', ['09:00', '09:15']],
    ['10:30-11.00', ['10:30', '11:00']],
    ['12:30-1:30', ['12:30', '13:30']],
    ['1:30-2:00', ['13:30', '14:00']],
    ['6:00-6:30', ['18:00', '18:30']],
    ['2:00 – 2:30', ['14:00', '14:30']],
    ['8:00 am-9:00 am', ['08:00', '09:00']],
  ])('%s', (text, expected) => expect(parseTimeRange(text)).toEqual(expected));

  it('rejects non-times', () => {
    expect(parseTimeRange('2nd Year 3rd Sem')).toBeNull();
    expect(parseTimeRange('LUNCH')).toBeNull();
  });
});

describe('parseCellText', () => {
  it.each([
    ['AP LEC- Classroom 6', { code: 'AP', kind: 'lecture', rooms: ['Classroom 6'] }],
    ['ADA LAB - Concept Room', { code: 'ADA LAB', kind: 'lab', rooms: ['Concept Room'] }],
    ['HOLISTIC LEC - Concept Room', { code: 'HOLISTIC', kind: 'lecture', rooms: ['Concept Room'] }],
    ['HOLISTIC PRACTICAL', { code: 'HOLISTIC PRACTICAL', kind: 'lab', rooms: [] }],
    ['CONTEST - Classroom 1,4,6,8,Concept Room', { code: 'CONTEST', kind: 'lecture', rooms: ['Classroom 1', 'Classroom 4', 'Classroom 6', 'Classroom 8', 'Concept Room'] }],
    ['m3   lab – Classroom 4', { code: 'M3 LAB', kind: 'lab', rooms: ['Classroom 4'] }],
  ])('%s', (text, expected) => expect(parseCellText(text)).toEqual(expected));

  it('skips lunch and empty cells', () => {
    expect(parseCellText('LUNCH')).toBe('skip');
    expect(parseCellText('   ')).toBeNull();
  });

  it('expands shorthand room lists', () => {
    expect(parseRooms('Lab 1, 2, Seminar Hall')).toEqual(['Lab 1', 'Lab 2', 'Seminar Hall']);
  });
});

describe('parseTimetableXlsx (college grid)', () => {
  it('reads the real timetable layout: 30 classes, whole-section vs batch from merged cells', async () => {
    const { rows, issues } = await parseTimetableXlsx(await buildCollegeTimetableXlsx());
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(rows).toHaveLength(30);

    const mon = rows.filter((r) => r.weekday === 1);
    expect(mon).toHaveLength(7);
    expect(mon.find((r) => r.subjectCode === 'AP')).toMatchObject({ start: '09:30', end: '11:00', batch: null, rooms: ['Classroom 6'] });
    expect(mon.find((r) => r.subjectCode === 'AI')).toMatchObject({ start: '14:00', end: '15:30', batch: null });
    expect(mon.find((r) => r.subjectCode === 'HOLISTIC')).toMatchObject({ start: '15:30', end: '16:30', batch: 'Batch 1' });
    expect(mon.filter((r) => r.subjectCode === 'ADA LAB').map((r) => [r.batch, r.start, r.end])).toEqual([
      ['Batch 1', '17:00', '18:30'],
      ['Batch 2', '15:30', '17:00'],
    ]);
    // Lunch is never imported.
    expect(rows.some((r) => /LUNCH/.test(r.text))).toBe(false);
  });

  it('handles Friday: a multi-room contest and a class without a room (warnings, not errors)', async () => {
    const { rows, issues } = await parseTimetableXlsx(await buildCollegeTimetableXlsx());
    const fri = rows.filter((r) => r.weekday === 5);
    expect(fri.map((r) => [r.subjectCode, r.start, r.end])).toEqual([
      ['CONTEST', '09:00', '12:00'],
      ['AI', '13:30', '15:00'],
      ['HOLISTIC PRACTICAL', '15:00', '16:30'],
    ]);
    expect(issues.map((i) => i.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/5 rooms; Argus records the first \(Classroom 1\)/), expect.stringMatching(/"HOLISTIC PRACTICAL" has no room/)]),
    );
  });

  it('reports a cell merged across only some batches', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('T');
    ws.getCell('A1').value = 'MONDAY';
    ws.getCell('A2').value = 'Sec';
    ws.getCell('B2').value = '9:00-10:00';
    ws.getCell('A3').value = 'BATCH 1';
    ws.getCell('A4').value = 'BATCH 2';
    ws.getCell('A5').value = 'BATCH 3';
    ws.getCell('B3').value = 'ADA LAB - Lab 1';
    ws.mergeCells('B3:B4');
    const { issues } = await parseTimetableXlsx(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(issues[0]).toMatchObject({ level: 'error', ref: 'Monday B3:B4' });
  });

  it('explains files that are not workbooks', async () => {
    const { issues } = await parseTimetableXlsx(Buffer.from('not an xlsx'));
    expect(issues[0]?.message).toMatch(/could not be read/);
  });
});
