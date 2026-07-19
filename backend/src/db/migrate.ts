import { Migrator, type Migration, type MigrationProvider, type MigrationResultSet } from 'kysely/migration';
import type { Db } from './index.ts';
import * as m0001 from './migrations/0001_foundations.ts';
import * as m0002 from './migrations/0002_identity_org_audit.ts';
import * as m0003 from './migrations/0003_timetable.ts';

/**
 * Migrations are listed statically (not read from disk) so they are bundled
 * into the single server file. Append new ones in order; never edit or
 * reorder an applied migration.
 */
const MIGRATIONS: Record<string, Migration> = {
  '0001_foundations': m0001,
  '0002_identity_org_audit': m0002,
  '0003_timetable': m0003,
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
