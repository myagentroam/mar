import { createDecipheriv } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

type LegacySecretRow = Record<string, string | number | bigint | Uint8Array | null>;

export function up(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    const rows = database.prepare('SELECT * FROM environment_secrets').all() as LegacySecretRow[];
    const key = rows.length === 0 ? undefined : legacyKey();
    database.exec(
      `ALTER TABLE environment_secrets RENAME TO environment_secrets_v015;
       CREATE TABLE environment_secrets (
         id TEXT PRIMARY KEY,
         scope TEXT NOT NULL CHECK (scope IN ('SYSTEM', 'PERSONAL', 'NODE')),
         owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
         node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
         name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
         value TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         CHECK (
           (scope = 'SYSTEM' AND owner_user_id IS NULL AND node_id IS NULL) OR
           (scope = 'PERSONAL' AND owner_user_id IS NOT NULL AND node_id IS NULL) OR
           (scope = 'NODE' AND owner_user_id IS NOT NULL AND node_id IS NOT NULL)
         )
       ) STRICT;`
    );
    const insert = database.prepare(
      `INSERT INTO environment_secrets
       (id, scope, owner_user_id, node_id, name, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows)
      insert.run(
        text(row, 'id'),
        text(row, 'scope'),
        nullableId(row.owner_user_id),
        nullableId(row.node_id),
        text(row, 'name'),
        decrypt(row, key!),
        integer(row, 'created_at'),
        integer(row, 'updated_at')
      );
    database.exec(
      `DROP TABLE environment_secrets_v015;
       CREATE UNIQUE INDEX environment_secrets_system_name_idx
         ON environment_secrets(name) WHERE scope = 'SYSTEM';
       CREATE UNIQUE INDEX environment_secrets_personal_name_idx
         ON environment_secrets(owner_user_id, name) WHERE scope = 'PERSONAL';
       CREATE UNIQUE INDEX environment_secrets_node_name_idx
         ON environment_secrets(node_id, name) WHERE scope = 'NODE';
       CREATE INDEX environment_secrets_owner_idx
         ON environment_secrets(owner_user_id, scope, updated_at);`
    );
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(16, Date.now());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function legacyKey(): Buffer {
  const encoded = process.env['MAR_SECRET_ENCRYPTION_KEY']?.trim() ?? '';
  const key = Buffer.from(encoded, 'base64');
  if (
    key.length !== 32 ||
    key.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')
  )
    throw new Error('LEGACY_SECRET_ENCRYPTION_KEY_REQUIRED');
  return key;
}

function decrypt(row: LegacySecretRow, key: Buffer): string {
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(text(row, 'nonce'), 'base64')
    );
    decipher.setAAD(
      Buffer.from(
        JSON.stringify([
          text(row, 'id'),
          text(row, 'scope'),
          typeof row.owner_user_id === 'number' ? row.owner_user_id : null,
          typeof row.node_id === 'string' ? row.node_id : null,
          text(row, 'name')
        ])
      )
    );
    decipher.setAuthTag(Buffer.from(text(row, 'auth_tag'), 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(text(row, 'ciphertext'), 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    throw new Error('LEGACY_SECRET_DECRYPTION_FAILED');
  }
}

function text(row: LegacySecretRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`DATABASE_VALUE_INVALID:${key}`);
  return value;
}

function integer(row: LegacySecretRow, key: string): number {
  const value = row[key];
  if (typeof value !== 'number') throw new Error(`DATABASE_VALUE_INVALID:${key}`);
  return value;
}

function nullableId(value: unknown): string | number | null {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  throw new Error('DATABASE_VALUE_INVALID:nullable-id');
}
