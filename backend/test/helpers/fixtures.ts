import type { Db } from '../../src/db/index.ts';
import { uuidv7 } from '../../src/platform/ids.ts';

/**
 * A small college shaped like the real one: one section ("2nd Year 3rd Sem")
 * with Batch 1 / Batch 2, a lecture and a lab subject, two classrooms, and
 * teachers. Term runs 2026-09-01 .. 2026-12-20 (2026-09-21 is a Monday).
 */
export async function collegeFixture(db: Db) {
  const id = () => uuidv7();
  const dept = { id: id(), code: 'CSE', name: 'Computer Science' };
  await db.insertInto('departments').values(dept).execute();
  const program = { id: id(), code: 'BTECH', name: 'B.Tech CSE', department_id: dept.id };
  await db.insertInto('programs').values(program).execute();
  const term = { id: id(), name: '2026 Odd', start_date: '2026-09-01', end_date: '2026-12-20' };
  await db.insertInto('terms').values(term).execute();
  const section = { id: id(), program_id: program.id, term_id: term.id, name: '2nd Year 3rd Sem' };
  const otherSection = { id: id(), program_id: program.id, term_id: term.id, name: '2nd Year 3rd Sem B' };
  await db.insertInto('sections').values([section, otherSection]).execute();
  const b1 = { id: id(), section_id: section.id, name: 'Batch 1' };
  const b2 = { id: id(), section_id: section.id, name: 'Batch 2' };
  await db.insertInto('section_groups').values([b1, b2]).execute();

  const subj = {
    ada: { id: id(), code: 'ADA', name: 'Analysis and Design of Algorithms', kind: 'lecture' as const },
    adaLab: { id: id(), code: 'ADA LAB', name: 'ADA Lab', kind: 'lab' as const },
    ap: { id: id(), code: 'AP', name: 'Advanced Programming', kind: 'lecture' as const },
  };
  await db.insertInto('subjects').values(Object.values(subj)).execute();
  const off = {
    ada: { id: id(), term_id: term.id, subject_id: subj.ada.id, section_id: section.id },
    adaLab: { id: id(), term_id: term.id, subject_id: subj.adaLab.id, section_id: section.id },
    ap: { id: id(), term_id: term.id, subject_id: subj.ap.id, section_id: section.id },
    otherAda: { id: id(), term_id: term.id, subject_id: subj.ada.id, section_id: otherSection.id },
  };
  await db.insertInto('course_offerings').values(Object.values(off)).execute();
  const room = { c6: { id: id(), code: 'Classroom 6' }, concept: { id: id(), code: 'Concept Room' } };
  await db.insertInto('rooms').values(Object.values(room)).execute();

  async function teacher(name: string, faculty: string) {
    const uid = id();
    await db.insertInto('users').values({ id: uid, role: 'teacher', name, email: `${faculty.toLowerCase()}@college.test` }).execute();
    await db.insertInto('teachers').values({ user_id: uid, faculty_id: faculty, department_id: dept.id }).execute();
    return { id: uid, name, email: `${faculty.toLowerCase()}@college.test` };
  }
  const tA = await teacher('Teacher A', 'T1');
  const tB = await teacher('Teacher B', 'T2');
  const tC = await teacher('Teacher C', 'T3');

  async function entry(e: {
    offering: string;
    weekday: number;
    start: string;
    end: string;
    room?: string | null;
    group?: string | null;
    teacher?: string | null;
    validFrom?: string;
    validTo?: string;
  }) {
    const row = {
      id: id(),
      term_id: term.id,
      offering_id: e.offering,
      group_id: e.group ?? null,
      weekday: e.weekday,
      start_time: e.start,
      end_time: e.end,
      room_id: e.room === undefined ? room.c6.id : e.room,
      teacher_id: e.teacher ?? null,
      valid_from: e.validFrom ?? null,
      valid_to: e.validTo ?? null,
    };
    await db.insertInto('timetable_entries').values(row).execute();
    return row;
  }

  async function assign(teacherId: string, offeringId: string, groupId: string | null = null) {
    await db.insertInto('teaching_assignments').values({ id: id(), teacher_id: teacherId, offering_id: offeringId, group_id: groupId }).execute();
  }

  return { dept, program, term, section, otherSection, b1, b2, subj, off, room, tA, tB, tC, entry, assign };
}

export type College = Awaited<ReturnType<typeof collegeFixture>>;
