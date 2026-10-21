import type { DatabaseSync } from 'node:sqlite';
import { applyMigration } from './support.js';

export function up(database: DatabaseSync): void {
  applyMigration(
    database,
    2,
    String.raw`
CREATE TABLE nodes (
    id TEXT PRIMARY KEY, platform TEXT NOT NULL CHECK (platform IN ('win32', 'linux')), architecture TEXT NOT NULL, node_app_version TEXT NOT NULL DEFAULT 'unknown', node_version TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
    capabilities TEXT NOT NULL, connected INTEGER NOT NULL CHECK (connected IN (0, 1)), disabled INTEGER NOT NULL CHECK (disabled IN (0, 1)),
    last_heartbeat_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX nodes_connected_idx ON nodes(connected, disabled);
`
  );
}
