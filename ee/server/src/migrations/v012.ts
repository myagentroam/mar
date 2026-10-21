import type { DatabaseSync } from 'node:sqlite';
import { type SqlRow } from './support.js';

export function up(database: DatabaseSync): void {
  let current = 0;
  if (current < 12) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const columns = database.prepare('PRAGMA table_info(nodes)').all() as SqlRow[];
      if (!columns.some((column) => column['name'] === 'metadata'))
        database.exec("ALTER TABLE nodes ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'");
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(12, Date.now());
      database.exec('COMMIT');
      current = 12;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}
