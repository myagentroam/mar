import type { DatabaseSync } from 'node:sqlite';
import { type SqlRow } from './support.js';

export function up(database: DatabaseSync): void {
  let current = 0;
  if (current < 7) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const columns = database.prepare('PRAGMA table_info(nodes)').all() as SqlRow[];
      if (!columns.some((column) => column['name'] === 'display_name'))
        database.exec('ALTER TABLE nodes ADD COLUMN display_name TEXT');
      if (!columns.some((column) => column['name'] === 'registered_address'))
        database.exec(
          "ALTER TABLE nodes ADD COLUMN registered_address TEXT NOT NULL DEFAULT 'unknown'"
        );
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(7, Date.now());
      database.exec('COMMIT');
      current = 7;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}
