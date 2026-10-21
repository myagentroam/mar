import type { DatabaseSync } from 'node:sqlite';
import type { SqlRow } from './support.js';

export function up(database: DatabaseSync): void {
  const workspaceTable = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspaces'")
    .get();
  const columns =
    workspaceTable === undefined
      ? []
      : (database.prepare('PRAGMA table_info(workspaces)').all() as SqlRow[]);
  database.exec('BEGIN IMMEDIATE');
  try {
    if (workspaceTable !== undefined && !columns.some((column) => column['name'] === 'group_name'))
      database.exec('ALTER TABLE workspaces ADD COLUMN group_name TEXT');
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(18, Date.now());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
