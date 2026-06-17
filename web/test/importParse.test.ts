import { describe, expect, it } from 'vitest';
import { parseRoster } from '../src/lib/importParse.ts';

// Synthetic records shaped like the college's existing export (Firestore JSON).
const exportLike = [
  {
    usn: '2102500001',
    name: 'Asha Rao',
    institutional_email: 'asha@college.test',
    email: 'asha.personal@example.com',
    batch: 'Batch 1',
    status: 'active',
    mobile_number: '9999999999',
    birthday: '2005-01-01',
    blood_group: 'O+',
    abc_id: '123456789012',
    photo: 'data:image/jpeg;base64,AAAA',
    createdAt: { _seconds: 1, _nanoseconds: 0 },
  },
  { usn: '2102500002', name: 'Ravi', institutional_email: 'ravi@college.test', batch: 'Batch 2' },
];

describe('parseRoster', () => {
  it('keeps only the five fields Argus needs, preferring the institutional email', () => {
    const r = parseRoster('students.json', JSON.stringify(exportLike));
    expect(r.format).toBe('json');
    expect(r.rows[0]).toEqual({ usn: '2102500001', name: 'Asha Rao', email: 'asha@college.test', batch: 'Batch 1', status: 'active' });
    expect(r.rows[1]).toEqual({ usn: '2102500002', name: 'Ravi', email: 'ravi@college.test', batch: 'Batch 2', status: null });
    // Sensitive fields never make it into the rows sent to the server.
    const sent = JSON.stringify(r.rows);
    for (const secret of ['9999999999', '2005-01-01', 'O+', '123456789012', 'base64', 'personal']) expect(sent).not.toContain(secret);
    expect(r.ignored).toEqual(expect.arrayContaining(['mobile_number', 'birthday', 'photo', 'abc_id']));
  });

  it('accepts a JSON object wrapping the list', () => {
    expect(parseRoster('x.json', JSON.stringify({ students: exportLike })).rows).toHaveLength(2);
  });

  it('reads CSV with flexible headers', () => {
    const csv = 'USN,Full Name,College Email,Batch\n2102500003,Meera N,meera@college.test,Batch 1\n\n';
    expect(parseRoster('r.csv', csv).rows).toEqual([
      { usn: '2102500003', name: 'Meera N', email: 'meera@college.test', batch: 'Batch 1', status: null },
    ]);
  });

  it('explains unreadable files', () => {
    expect(() => parseRoster('x.json', '{not json')).toThrow(/could not be read/);
    expect(() => parseRoster('x.json', '{"a": 1}')).toThrow(/No list of students/);
  });
});
