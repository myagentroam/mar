import type { DatabaseSync } from 'node:sqlite';
import { type SqlRow } from './support.js';

export function up(database: DatabaseSync): void {
  let current = 0;
  if (current < 11) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const columns = database.prepare('PRAGMA table_info(nodes)').all() as SqlRow[];
      if (
        columns.some((column) => column['name'] === 'platform') &&
        !columns.some((column) => column['name'] === 'node_app_version')
      )
        database.exec(
          "ALTER TABLE nodes ADD COLUMN node_app_version TEXT NOT NULL DEFAULT 'unknown'"
        );
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(11, Date.now());
      database.exec('COMMIT');
      current = 11;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}
