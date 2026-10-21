import type { DatabaseSync } from 'node:sqlite';

/** Upgrade the original singleton account schema without losing existing data. */
export function up(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
  try {
    database.exec(`
      CREATE TABLE users_next (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE CHECK (length(username) BETWEEN 1 AND 80),
        email TEXT UNIQUE,
        nickname TEXT,
        is_admin INTEGER NOT NULL CHECK (is_admin IN (0, 1)),
        password_hash TEXT NOT NULL,
        must_change_password INTEGER NOT NULL CHECK (must_change_password IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO users_next
        (id, username, email, nickname, is_admin, password_hash, must_change_password, created_at, updated_at)
      SELECT id, username, NULL, NULL, CASE WHEN username = 'admin' THEN 1 ELSE 0 END,
        password_hash, must_change_password, created_at, updated_at
      FROM users;
      DROP TABLE users;
      ALTER TABLE users_next RENAME TO users;
      CREATE UNIQUE INDEX IF NOT EXISTS users_single_admin_idx ON users(is_admin) WHERE is_admin = 1;
      ${
        (database.prepare('PRAGMA table_info(nodes)').all() as { name?: unknown }[]).some(
          (column) => column.name === 'owner_user_id'
        )
          ? ''
          : 'ALTER TABLE nodes ADD COLUMN owner_user_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE;'
      }
      CREATE INDEX IF NOT EXISTS nodes_owner_user_idx ON nodes(owner_user_id, created_at);
      CREATE INDEX IF NOT EXISTS node_registration_tokens_creator_idx ON node_registration_tokens(created_by_user_id, expires_at);
    `);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(14, Date.now());
    database.exec('COMMIT; PRAGMA foreign_keys = ON');
  } catch (error) {
    database.exec('ROLLBACK; PRAGMA foreign_keys = ON');
    throw error;
  }
}
