import type { DatabaseSync } from 'node:sqlite';
import { type SqlRow, MAX_ACTIVE_USER_SESSIONS } from './support.js';

export function up(database: DatabaseSync): void {
  let current = 0;
  if (current < 8) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const columns = database.prepare('PRAGMA table_info(user_sessions)').all() as SqlRow[];
      if (!columns.some((column) => column['name'] === 'ip_address'))
        database.exec(
          "ALTER TABLE user_sessions ADD COLUMN ip_address TEXT NOT NULL DEFAULT 'unknown'"
        );
      if (!columns.some((column) => column['name'] === 'user_agent'))
        database.exec(
          "ALTER TABLE user_sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT 'unknown'"
        );
      const timestamp = Date.now();
      database
        .prepare(
          `UPDATE user_sessions SET revoked_at = ?
           WHERE session_hash IN (
             SELECT session_hash FROM user_sessions
             WHERE revoked_at IS NULL AND expires_at > ?
             ORDER BY created_at DESC, session_hash DESC
             LIMIT -1 OFFSET ${MAX_ACTIVE_USER_SESSIONS}
           )`
        )
        .run(timestamp, timestamp);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(8, Date.now());
      database.exec('COMMIT');
      current = 8;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}
