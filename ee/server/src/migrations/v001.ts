import type { DatabaseSync } from 'node:sqlite';
import { applyMigration } from './support.js';

export function up(database: DatabaseSync): void {
  applyMigration(
    database,
    1,
    String.raw`
CREATE TABLE users (
    id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL UNIQUE CHECK (username = 'admin'), password_hash TEXT NOT NULL,
    must_change_password INTEGER NOT NULL CHECK (must_change_password IN (0, 1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE user_sessions (
    session_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf_token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
  ) STRICT;
  CREATE INDEX user_sessions_active_user_idx ON user_sessions(user_id, expires_at) WHERE revoked_at IS NULL;
  CREATE TABLE node_registration_tokens (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_by_user_id INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, consumed_at INTEGER, revoked_at INTEGER
  ) STRICT;
  CREATE TABLE node_credentials (node_id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL UNIQUE, issued_at INTEGER NOT NULL, revoked_at INTEGER) STRICT;
  CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY, event_type TEXT NOT NULL, actor_user_id INTEGER REFERENCES users(id), ip_address TEXT, metadata TEXT NOT NULL, created_at INTEGER NOT NULL
  ) STRICT;
`
  );
}
