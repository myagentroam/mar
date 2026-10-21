import type { DatabaseSync } from 'node:sqlite';
import { type SqlRow, randomToken, stringValue } from './support.js';

export function up(database: DatabaseSync): void {
  let current = 0;
  if (current < 9) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const columns = database.prepare('PRAGMA table_info(user_sessions)').all() as SqlRow[];
      if (!columns.some((column) => column['name'] === 'public_id'))
        database.exec('ALTER TABLE user_sessions ADD COLUMN public_id TEXT');
      const rows = database
        .prepare('SELECT session_hash FROM user_sessions WHERE public_id IS NULL')
        .all() as SqlRow[];
      const update = database.prepare(
        'UPDATE user_sessions SET public_id = ? WHERE session_hash = ?'
      );
      for (const row of rows) update.run(randomToken(), stringValue(row, 'session_hash'));
      database.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS user_sessions_public_id_idx ON user_sessions(public_id)'
      );
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(9, Date.now());
      database.exec('COMMIT');
      current = 9;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}
