import type { DatabaseSync } from 'node:sqlite';
import type { SqlRow } from './support.js';

export function up(database: DatabaseSync): void {
  const columns = database.prepare('PRAGMA table_info(nodes)').all() as SqlRow[];
  const hasConnectedColumn = columns.some((column) => column['name'] === 'connected');
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec('DROP INDEX IF EXISTS nodes_connected_idx');
    if (hasConnectedColumn) database.exec('ALTER TABLE nodes DROP COLUMN connected');
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(17, Date.now());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
