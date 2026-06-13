import type { ResourceConfig } from '../../components/ResourcePage.tsx';

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are generic JSON */
const byCode = (r: any) => `${r.code} · ${r.name}`;
const byName = (r: any) => String(r.name);

export const RESOURCE_CONFIGS: Record<string, ResourceConfig> = {
  departments: {
    path: 'departments',
    title: 'Departments',
    subtitle: 'Academic departments. Teachers and programs belong to one.',
    singular: 'Department',
    columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }],
    fields: [
      { key: 'code', label: 'Code', type: 'text', required: true, hint: 'Short code, e.g. CSE' },
      { key: 'name', label: 'Name', type: 'text', required: true },
    ],
  },
  programs: {
    path: 'programs',
    title: 'Programs',
    subtitle: 'Degree programs, e.g. B.Tech CSE.',
    singular: 'Program',
    columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'department_id', label: 'Department' }],
    fields: [
      { key: 'code', label: 'Code', type: 'text', required: true },
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'department_id', label: 'Department', type: 'ref', required: true, ref: { path: 'departments', label: byCode } },
    ],
  },
  terms: {
    path: 'terms',
    title: 'Terms',
    subtitle: 'Semesters. Timetables and sections belong to a term.',
    singular: 'Term',
    columns: [{ key: 'name', label: 'Name' }, { key: 'start_date', label: 'Starts' }, { key: 'end_date', label: 'Ends' }],
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, hint: 'e.g. 2026 Odd Semester' },
      { key: 'start_date', label: 'Start date', type: 'date', required: true },
      { key: 'end_date', label: 'End date', type: 'date', required: true },
    ],
  },
  sections: {
    path: 'sections',
    title: 'Sections',
    subtitle: 'A class of students that shares a timetable, e.g. "2nd Year 3rd Sem".',
    singular: 'Section',
    columns: [{ key: 'name', label: 'Name' }, { key: 'program_id', label: 'Program' }, { key: 'term_id', label: 'Term' }],
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'program_id', label: 'Program', type: 'ref', required: true, ref: { path: 'programs', label: byCode } },
      { key: 'term_id', label: 'Term', type: 'ref', required: true, ref: { path: 'terms', label: byName } },
    ],
  },
  groups: {
    path: 'groups',
    title: 'Lab batches',
    subtitle: 'Batches within a section (e.g. Batch 1, Batch 2) for labs.',
    singular: 'Batch',
    columns: [{ key: 'name', label: 'Batch' }, { key: 'section_id', label: 'Section' }],
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'section_id', label: 'Section', type: 'ref', required: true, createOnly: true, ref: { path: 'sections', label: byName } },
    ],
  },
  subjects: {
    path: 'subjects',
    title: 'Subjects',
    subtitle: 'Courses. Labs and lectures are separate subjects (e.g. ADA and ADA Lab).',
    singular: 'Subject',
    columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'kind', label: 'Type' }],
    fields: [
      { key: 'code', label: 'Code', type: 'text', required: true, hint: 'As written in the timetable, e.g. ADA' },
      { key: 'name', label: 'Name', type: 'text', required: true },
      {
        key: 'kind',
        label: 'Type',
        type: 'select',
        required: true,
        options: [
          { value: 'lecture', label: 'Lecture' },
          { value: 'lab', label: 'Lab' },
          { value: 'tutorial', label: 'Tutorial' },
        ],
      },
    ],
  },
  rooms: {
    path: 'rooms',
    title: 'Rooms',
    subtitle: 'Classrooms and labs. The campus area decides where scans count as on campus.',
    singular: 'Room',
    columns: [{ key: 'code', label: 'Room' }, { key: 'building', label: 'Building' }, { key: 'capacity', label: 'Capacity' }, { key: 'geofence_id', label: 'Campus area' }],
    fields: [
      { key: 'code', label: 'Room name', type: 'text', required: true, hint: 'As written in the timetable, e.g. Classroom 6' },
      { key: 'building', label: 'Building', type: 'text' },
      { key: 'floor', label: 'Floor', type: 'number', nullable: true },
      { key: 'capacity', label: 'Capacity', type: 'number', nullable: true },
      { key: 'geofence_id', label: 'Campus area', type: 'ref', nullable: true, ref: { path: 'geofences', label: byName } },
    ],
  },
  geofences: {
    path: 'geofences',
    title: 'Campus areas',
    subtitle: 'Where the campus is. A scan clearly outside every area (with a good location fix) is refused.',
    singular: 'Campus area',
    columns: [{ key: 'name', label: 'Name' }, { key: 'center_lat', label: 'Latitude' }, { key: 'center_lon', label: 'Longitude' }, { key: 'radius_m', label: 'Radius (m)' }],
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'center_lat', label: 'Centre latitude', type: 'number', required: true, hint: 'From Google Maps: right-click the campus centre' },
      { key: 'center_lon', label: 'Centre longitude', type: 'number', required: true },
      { key: 'radius_m', label: 'Radius in metres', type: 'number', required: true, hint: 'Large enough to cover the whole campus' },
    ],
  },
  'campus-networks': {
    path: 'campus-networks',
    title: 'Campus networks',
    subtitle: 'Internet addresses of the college Wi-Fi. Scans from elsewhere get a soft flag (never rejected).',
    singular: 'Network',
    columns: [{ key: 'cidr', label: 'Address range' }, { key: 'label', label: 'Label' }],
    fields: [
      { key: 'cidr', label: 'Address range', type: 'text', required: true, hint: 'Ask IT for the public IP range, e.g. 203.0.113.0/24' },
      { key: 'label', label: 'Label', type: 'text' },
    ],
  },
};
