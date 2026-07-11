import ExcelJS from 'exceljs';

/**
 * Rebuilds the college's "2nd Year 3rd Sem" timetable sheet (as shared on
 * 2026-09-24) with the same layout and merged cells. Used by tests and as the
 * example file Acad Ops can download.
 */
const TIMES = [
  '9:00-9.15', '9:15-9.30', '9:30-10:00', '10:00-10:30', '10:30-11.00', '11:00-11.30', '11:30-12:00', '12:00-12:30',
  '12:30-1:30', '1:30-2:00', '2:00-2:30', '2:30-3:00', '3:00-3:30', '3:30-4:00', '4:00-4:30', '4:30-5:00', '5:00-5:30',
  '5:30-6:00', '6:00-6:30',
];

/** [range relative to the block's first batch row (row "1" = BATCH 1, "2" = BATCH 2), text] */
const WEEK: Record<string, [string, string][]> = {
  MONDAY: [
    ['D1:F2', 'AP LEC- Classroom 6'], ['G1:I2', 'ADA LEC- Classroom 6'], ['J1:K2', 'LUNCH'], ['L1:N2', 'AI LEC - Classroom 6'],
    ['O1:P1', 'HOLISTIC LEC - Classroom 6'], ['R1:T1', 'ADA LAB - Concept Room'],
    ['O2:Q2', 'ADA LAB - Concept Room'], ['R2:T2', 'AP LAB - Classroom 6'],
  ],
  TUESDAY: [
    ['D1:F2', 'M3 LEC - Classroom 6'], ['G1:I2', 'DE LEC - Classroom 6'], ['J1:K2', 'LUNCH'],
    ['N1:P1', 'AP LAB - Classroom 8'], ['Q1:S1', 'M3 LAB - Classroom 6'],
    ['L2:M2', 'HOLISTIC LEC - Concept Room'], ['N2:P2', 'M3 LAB - Classroom 4'], ['Q2:S2', 'DE LAB - Classroom 8'],
  ],
  WEDNESDAY: [
    ['D1:F2', 'AP LEC- Classroom 6'], ['G1:I2', 'ADA LEC - Classroom 6'], ['J1:K2', 'LUNCH'],
    ['L1:N1', 'AP LAB - Classroom 6'], ['O1:P1', 'HOLISTIC LEC - Concept Room'], ['Q1:S1', 'ADA LAB - Concept Room'],
    ['L2:N2', 'ADA LAB - Concept Room'], ['O2:Q2', 'AP LAB - Classroom 6'],
  ],
  THURSDAY: [
    ['D1:F2', 'M3 LEC - Classroom 6'], ['G1:I1', 'DE LAB - Classroom 6'], ['G2:I2', 'M3 LAB - Concept Room'], ['J1:K2', 'LUNCH'],
    ['L1:N2', 'DE LEC - Classroom 6'], ['O1:Q1', 'M3 LAB - Classroom 6'], ['O2:P2', 'HOLISTIC LEC - Concept Room'],
  ],
  FRIDAY: [
    ['B1:H2', 'CONTEST - Classroom 1,4,6,8,Concept Room'], ['I1:J2', 'LUNCH'], ['K1:M2', 'AI LEC - Classroom 6'], ['N1:P2', 'HOLISTIC PRACTICAL'],
  ],
};

export async function buildCollegeTimetableXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Timetable');
  let top = 1;
  for (const [day, cells] of Object.entries(WEEK)) {
    ws.getCell(top, 1).value = day;
    ws.mergeCells(top, 1, top, TIMES.length + 1);
    ws.getCell(top + 1, 1).value = '2nd Year 3rd Sem';
    TIMES.forEach((t, i) => (ws.getCell(top + 1, i + 2).value = t));
    ws.getCell(top + 2, 1).value = 'BATCH 1';
    ws.getCell(top + 3, 1).value = 'BATCH 2';
    for (const [range, text] of cells) {
      const [a, b] = range.split(':') as [string, string];
      const toAbs = (ref: string) => `${ref.replace(/\d+$/, '')}${top + 1 + Number(/\d+$/.exec(ref)![0])}`;
      ws.getCell(toAbs(a)).value = text;
      if (a !== b) ws.mergeCells(`${toAbs(a)}:${toAbs(b)}`);
    }
    top += 5;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
