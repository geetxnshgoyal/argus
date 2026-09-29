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
    title: 'Semesters',
    subtitle: 'Each year’s timetable and batches belong to a semester.',
    singular: 'Semester',
    columns: [{ key: 'name', label: 'Name' }, { key: 'start_date', label: 'Starts' }, { key: 'end_date', label: 'Ends' }],
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, hint: 'e.g. Semester 3' },
      { key: 'start_date', label: 'Start date', type: 'date', required: true },
      { key: 'end_date', label: 'End date', type: 'date', required: true },
    ],
  },
  sections: {
    path: 'sections',
    title: 'Sections',
    subtitle: 'The students of one year who share a timetable, e.g. "2nd Year".',
    singular: 'Section',
    columns: [{ key: 'name', label: 'Name' }, { key: 'program_id', label: 'Program' }, { key: 'term_id', label: 'Semester' }],
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'program_id', label: 'Program', type: 'ref', required: true, ref: { path: 'programs', label: byCode } },
      { key: 'term_id', label: 'Semester', type: 'ref', required: true, ref: { path: 'terms', label: byName } },
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
    columns: [{ key: 'code', label: 'Room' }, { key: 'building', label: 'Building' }, { key: 'capacity', label: 'Capacity' }, { key: 'geofence_id', label: 'Campus area' }, { key: 'wifi_routers', label: 'Wi-Fi routers', render: (r) => (Array.isArray(r.wifi_routers) && r.wifi_routers.length ? r.wifi_routers.join(', ') : '—') }],
    fields: [
      { key: 'code', label: 'Room name', type: 'text', required: true, hint: 'As written in the timetable, e.g. Classroom 6' },
      { key: 'building', label: 'Building', type: 'text' },
      { key: 'floor', label: 'Floor', type: 'number', nullable: true },
      { key: 'capacity', label: 'Capacity', type: 'number', nullable: true },
      { key: 'geofence_id', label: 'Campus area', type: 'ref', nullable: true, ref: { path: 'geofences', label: byName } },
      {
        key: 'wifi_routers',
        label: 'Wi-Fi routers',
        type: 'lines',
        hint: 'One router per line, e.g. e0:c2:50:78:0e (the first five parts of its Wi-Fi ID). Scans that see one of these count as "in this room". See Wi-Fi routers for ones learned from scans.',
      },
    ],
  },
  geofences: {
    path: 'geofences',
    title: 'Campus areas',
    subtitle: 'Where the campus is. A scan clearly outside every area (with a good location fix) is refused.',
    singular: 'Campus area',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'polygon', label: 'Shape', render: (r) => (Array.isArray(r.polygon) && r.polygon.length >= 3 ? `Outline, ${r.polygon.length} corners` : `Circle, ${r.radius_m} m`) },
      { key: 'center_lat', label: 'Centre', render: (r) => `${r.center_lat}, ${r.center_lon}` },
    ],
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      {
        key: 'polygon',
        label: 'Building outline',
        type: 'polygon',
        nullable: true,
        hint: 'One corner per line: latitude, longitude (Google Maps: right-click a corner, click the numbers to copy). Leave empty to use a circle instead. Add ~25 m around the walls: indoor GPS drifts.',
      },
      { key: 'center_lat', label: 'Centre latitude', type: 'number', hint: 'Only for a circle; worked out from the outline otherwise' },
      { key: 'center_lon', label: 'Centre longitude', type: 'number' },
      { key: 'radius_m', label: 'Radius in metres', type: 'number', hint: 'Only for a circle: large enough to cover the whole campus' },
    ],
    // With an outline, the centre and radius are derived from it (the server still stores them).
    prepare: (body) => {
      const poly = body.polygon as [number, number][] | null | undefined;
      if (!poly || poly.length < 3) return body;
      const lat = poly.reduce((a, p) => a + p[0], 0) / poly.length;
      const lon = poly.reduce((a, p) => a + p[1], 0) / poly.length;
      const m = (a: [number, number]) => Math.hypot((a[0] - lat) * 111_195, (a[1] - lon) * 111_195 * Math.cos((lat * Math.PI) / 180));
      return { ...body, center_lat: Math.round(lat * 1e6) / 1e6, center_lon: Math.round(lon * 1e6) / 1e6, radius_m: Math.ceil(Math.max(...poly.map(m))) };
    },
  },
  'teaching-assignments': {
    path: 'teaching-assignments',
    title: 'Teaching assignments',
    subtitle: 'Who teaches each subject. For labs, pick the batch; a section-wide assignment covers every batch without its own.',
    singular: 'Assignment',
    columns: [
      { key: 'subject_code', label: 'Subject', render: (r) => `${r.subject_code} · ${r.subject_name}` },
      { key: 'section_name', label: 'Section' },
      { key: 'group_name', label: 'Batch', render: (r) => r.group_name ?? 'All batches' },
      { key: 'teacher_name', label: 'Teacher' },
      { key: 'role', label: 'Role', render: (r) => (r.role === 'primary' ? 'Main teacher' : 'Assistant') },
    ],
    fields: [
      { key: 'offering_id', label: 'Subject', type: 'ref', required: true, createOnly: true, ref: { path: 'offerings', label: (r) => `${r.subject_code} · ${r.subject_name} (${r.section_name})` } },
      { key: 'group_id', label: 'Batch', type: 'ref', nullable: true, hint: 'Leave empty for the whole section', ref: { path: 'groups', label: byName } },
      { key: 'teacher_id', label: 'Teacher', type: 'ref', required: true, createOnly: true, ref: { path: 'users', label: (r) => `${r.name} (${r.email})`, filter: { role: 'teacher', status: 'active' } } },
      { key: 'role', label: 'Role', type: 'select', options: [{ value: 'primary', label: 'Main teacher' }, { value: 'assistant', label: 'Assistant' }] },
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
