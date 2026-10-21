import type { DatabaseSync } from 'node:sqlite';
import { applyMigration } from './support.js';

export function up(database: DatabaseSync): void {
  applyMigration(
    database,
    15,
    `CREATE TABLE IF NOT EXISTS environment_secrets (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('SYSTEM', 'PERSONAL', 'NODE')),
      owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
      ciphertext TEXT NOT NULL,
      nonce TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        (scope = 'SYSTEM' AND owner_user_id IS NULL AND node_id IS NULL) OR
        (scope = 'PERSONAL' AND owner_user_id IS NOT NULL AND node_id IS NULL) OR
        (scope = 'NODE' AND owner_user_id IS NOT NULL AND node_id IS NOT NULL)
      )
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS environment_secrets_system_name_idx
      ON environment_secrets(name) WHERE scope = 'SYSTEM';
    CREATE UNIQUE INDEX IF NOT EXISTS environment_secrets_personal_name_idx
      ON environment_secrets(owner_user_id, name) WHERE scope = 'PERSONAL';
    CREATE UNIQUE INDEX IF NOT EXISTS environment_secrets_node_name_idx
      ON environment_secrets(node_id, name) WHERE scope = 'NODE';
    CREATE INDEX IF NOT EXISTS environment_secrets_owner_idx
      ON environment_secrets(owner_user_id, scope, updated_at);`
  );
}
