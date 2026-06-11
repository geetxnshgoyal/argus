import ipaddr from 'ipaddr.js';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { ApiError } from '../errors.ts';
import { isoDate, uuid } from '../validation.ts';
import type { ResourceDef } from './crud.ts';

/* eslint-disable @typescript-eslint/no-explicit-any -- generic transaction */
type AnyTx = Transaction<any>;

const text = (max = 200) => z.string().trim().min(1).max(max);
const code = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .transform((s) => s.toUpperCase());
const optUuid = uuid.nullable().optional();

/** Group (batch) must belong to the offering's section. */
async function groupMatchesOffering(tx: AnyTx, row: Record<string, unknown>): Promise<void> {
  if (!row.group_id) return;
  const ok = await tx
    .selectFrom('section_groups as g')
    .innerJoin('course_offerings as o', 'o.section_id', 'g.section_id')
    .select('g.id')
    .where('g.id', '=', row.group_id as string)
    .where('o.id', '=', row.offering_id as string)
    .executeTakeFirst();
  if (!ok) throw new ApiError(400, 'invalid_group', 'The batch must belong to the same section as the course offering.');
}

const cidr = z
  .string()
  .trim()
  .refine((s) => {
    try {
      ipaddr.parseCIDR(s);
      return true;
    } catch {
      return false;
    }
  }, 'Use CIDR notation, e.g. 203.0.113.0/24');

const latLonPolygon = z
  .array(z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]))
  .min(3)
  .max(500);

const geofenceBase = {
  name: text(),
  center_lat: z.number().min(-90).max(90),
  center_lon: z.number().min(-180).max(180),
  radius_m: z.number().positive().max(20_000),
  polygon: latLonPolygon.nullable().optional(),
};

export const RESOURCES: ResourceDef[] = [
  {
    path: 'departments',
    table: 'departments',
    entityType: 'department',
    create: z.object({ code, name: text() }),
    update: z.object({ code, name: text() }).partial(),
    search: ['code', 'name'],
    orderBy: ['code'],
  },
  {
    path: 'programs',
    table: 'programs',
    entityType: 'program',
    create: z.object({ code, name: text(), department_id: uuid }),
    update: z.object({ code, name: text(), department_id: uuid }).partial(),
    filters: { department_id: 'department_id' },
    search: ['code', 'name'],
    orderBy: ['code'],
  },
  {
    path: 'terms',
    table: 'terms',
    entityType: 'term',
    create: z
      .object({ name: text(), start_date: isoDate, end_date: isoDate })
      .refine((t) => t.end_date > t.start_date, { message: 'End date must be after start date', path: ['end_date'] }),
    update: z.object({ name: text(), start_date: isoDate, end_date: isoDate }).partial(),
    search: ['name'],
    orderBy: ['start_date'],
  },
  {
    path: 'sections',
    table: 'sections',
    entityType: 'section',
    create: z.object({ program_id: uuid, term_id: uuid, name: text(100) }),
    update: z.object({ program_id: uuid, term_id: uuid, name: text(100) }).partial(),
    filters: { term_id: 'term_id', program_id: 'program_id' },
    search: ['name'],
    orderBy: ['name'],
  },
  {
    path: 'groups',
    table: 'section_groups',
    entityType: 'section_group',
    create: z.object({ section_id: uuid, name: text(100) }),
    update: z.object({ name: text(100) }).partial(),
    filters: { section_id: 'section_id' },
    search: ['name'],
    orderBy: ['name'],
  },
  {
    path: 'subjects',
    table: 'subjects',
    entityType: 'subject',
    create: z.object({ code, name: text(), kind: z.enum(['lecture', 'lab', 'tutorial']) }),
    update: z.object({ code, name: text(), kind: z.enum(['lecture', 'lab', 'tutorial']) }).partial(),
    search: ['code', 'name'],
    orderBy: ['code'],
  },
  {
    path: 'rooms',
    table: 'rooms',
    entityType: 'room',
    create: z.object({
      code: text(50),
      building: z.string().trim().max(100).optional(),
      floor: z.number().int().min(-5).max(200).nullable().optional(),
      capacity: z.number().int().positive().max(5000).nullable().optional(),
      geofence_id: optUuid,
      ble_rssi_threshold: z.number().int().min(-120).max(0).nullable().optional(),
    }),
    update: z
      .object({
        code: text(50),
        building: z.string().trim().max(100),
        floor: z.number().int().min(-5).max(200).nullable(),
        capacity: z.number().int().positive().max(5000).nullable(),
        geofence_id: uuid.nullable(),
        ble_rssi_threshold: z.number().int().min(-120).max(0).nullable(),
      })
      .partial(),
    search: ['code', 'building'],
    orderBy: ['code'],
  },
  {
    path: 'geofences',
    table: 'campus_geofences',
    entityType: 'geofence',
    create: z.object(geofenceBase),
    update: z.object(geofenceBase).partial(),
    search: ['name'],
    orderBy: ['name'],
    toDb: (r) => ('polygon' in r ? { ...r, polygon: r.polygon ? JSON.stringify(r.polygon) : null } : r),
  },
  {
    path: 'campus-networks',
    table: 'campus_networks',
    entityType: 'campus_network',
    create: z.object({ cidr, label: z.string().trim().max(100).optional() }),
    update: z.object({ cidr, label: z.string().trim().max(100) }).partial(),
    search: ['label'],
    orderBy: ['cidr'],
  },
  {
    path: 'offerings',
    table: 'course_offerings',
    entityType: 'offering',
    create: z.object({ term_id: uuid, subject_id: uuid, section_id: uuid }),
    update: z.object({ term_id: uuid, subject_id: uuid, section_id: uuid }).partial(),
    filters: { term_id: 'term_id', section_id: 'section_id', subject_id: 'subject_id' },
    orderBy: ['created_at'],
    check: async (tx, row) => {
      const ok = await tx
        .selectFrom('sections')
        .select('id')
        .where('id', '=', row.section_id as string)
        .where('term_id', '=', row.term_id as string)
        .executeTakeFirst();
      if (!ok) throw new ApiError(400, 'invalid_section', 'The section must belong to the selected term.');
    },
  },
  {
    path: 'enrollments',
    table: 'enrollments',
    entityType: 'enrollment',
    create: z.object({ student_id: uuid, offering_id: uuid, group_id: optUuid }),
    update: z.object({ group_id: uuid.nullable() }).partial(),
    filters: { offering_id: 'offering_id', student_id: 'student_id' },
    orderBy: ['created_at'],
    check: groupMatchesOffering,
  },
  {
    path: 'teaching-assignments',
    table: 'teaching_assignments',
    entityType: 'teaching_assignment',
    create: z.object({
      teacher_id: uuid,
      offering_id: uuid,
      group_id: optUuid,
      role: z.enum(['primary', 'assistant']).optional(),
    }),
    update: z.object({ group_id: uuid.nullable(), role: z.enum(['primary', 'assistant']) }).partial(),
    filters: { offering_id: 'offering_id', teacher_id: 'teacher_id' },
    orderBy: ['created_at'],
    check: groupMatchesOffering,
  },
];
