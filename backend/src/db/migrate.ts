import { Migrator, type Migration, type MigrationProvider, type MigrationResultSet } from 'kysely/migration';
import type { Db } from './index.ts';
import * as m0001 from './migrations/0001_foundations.ts';
import * as m0002 from './migrations/0002_identity_org_audit.ts';
import * as m0003 from './migrations/0003_timetable.ts';
import * as m0004 from './migrations/0004_devices.ts';
import * as m0005 from './migrations/0005_attendance.ts';
import * as m0006 from './migrations/0006_support.ts';
import * as m0007 from './migrations/0007_job_runs.ts';
import * as m0008 from './migrations/0008_notices.ts';
import * as m0009 from './migrations/0009_ios_pilot.ts';
import * as m0010 from './migrations/0010_push_tokens.ts';
import * as m0011 from './migrations/0011_retention.ts';
import * as m0012 from './migrations/0012_phone_unverified.ts';
import * as m0013 from './migrations/0013_pilot.ts';
import * as m0014 from './migrations/0014_od_and_issues.ts';

/**
 * Migrations are listed statically (not read from disk) so they are bundled
 * into the single server file. Append new ones in order; never edit or
 * reorder an applied migration.
 */
const MIGRATIONS: Record<string, Migration> = {
  '0001_foundations': m0001,
  '0002_identity_org_audit': m0002,
  '0003_timetable': m0003,
  '0004_devices': m0004,
  '0005_attendance': m0005,
  '0006_support': m0006,
  '0007_job_runs': m0007,
  '0008_notices': m0008,
  '0009_ios_pilot': m0009,
  '0010_push_tokens': m0010,
  '0011_retention': m0011,
  '0012_phone_unverified': m0012,
  '0013_pilot': m0013,
  '0014_od_and_issues': m0014,
};

const provider: MigrationProvider = {
  getMigrations: async () => MIGRATIONS,
};

export function createMigrator(db: Db): Migrator {
  return new Migrator({ db, provider });
}

export async function migrateToLatest(db: Db): Promise<MigrationResultSet> {
  return createMigrator(db).migrateToLatest();
}
