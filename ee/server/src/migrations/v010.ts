import type { DatabaseSync } from 'node:sqlite';
import { type SqlRow } from './support.js';

export function up(database: DatabaseSync): void {
  let current = 0;
  if (current < 10) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const columns = database.prepare('PRAGMA table_info(user_sessions)').all() as SqlRow[];
      if (!columns.some((column) => column['name'] === 'last_accessed_at'))
        database.exec(
          'ALTER TABLE user_sessions ADD COLUMN last_accessed_at INTEGER NOT NULL DEFAULT 0'
        );
      database.exec(
        'UPDATE user_sessions SET last_accessed_at = created_at WHERE last_accessed_at = 0'
      );
      database.exec(
        `CREATE INDEX IF NOT EXISTS user_sessions_active_lru_idx
         ON user_sessions(user_id, last_accessed_at, created_at, session_hash)
         WHERE revoked_at IS NULL`
      );
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(10, Date.now());
      database.exec('COMMIT');
      current = 10;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}
