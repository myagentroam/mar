import type { DatabaseSync } from 'node:sqlite';
import { type SqlRow, numberValue, parseJsonObject, stringValue } from './support.js';

export function up(database: DatabaseSync): void {
  let current = 0;
  if (current < 13) {
    const nodeColumns = database.prepare('PRAGMA table_info(nodes)').all() as SqlRow[];
    const needsRebuild = nodeColumns.some((column) => column['name'] === 'platform');
    const hasConnectedColumn = nodeColumns.some((column) => column['name'] === 'connected');
    database.exec(needsRebuild ? 'PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE' : 'BEGIN IMMEDIATE');
    try {
      if (!needsRebuild) {
        database
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(13, Date.now());
        database.exec('COMMIT');
        current = 13;
        return;
      }
      const oldRows = database
        .prepare(
          hasConnectedColumn
            ? 'SELECT id, display_name, registered_address, platform, architecture, node_app_version, node_version, metadata, capabilities, connected, disabled, last_heartbeat_at, created_at, updated_at FROM nodes'
            : 'SELECT id, display_name, registered_address, platform, architecture, node_app_version, node_version, metadata, capabilities, disabled, last_heartbeat_at, created_at, updated_at FROM nodes'
        )
        .all() as SqlRow[];
      database.exec(
        `CREATE TABLE nodes_metadata_only (
          id TEXT PRIMARY KEY, display_name TEXT, registered_address TEXT NOT NULL DEFAULT 'unknown',
          metadata TEXT NOT NULL DEFAULT '{}', connected INTEGER NOT NULL CHECK (connected IN (0, 1)),
          disabled INTEGER NOT NULL CHECK (disabled IN (0, 1)), last_heartbeat_at INTEGER,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        ) STRICT;`
      );
      const insert = database.prepare(
        `INSERT INTO nodes_metadata_only
         (id, display_name, registered_address, metadata, connected, disabled, last_heartbeat_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const row of oldRows) {
        const metadata = parseJsonObject(row['metadata']);
        if (typeof row['platform'] === 'string') metadata['platform'] ??= row['platform'];
        if (typeof row['architecture'] === 'string')
          metadata['architecture'] ??= row['architecture'];
        if (typeof row['node_app_version'] === 'string')
          metadata['nodeAppVersion'] ??= row['node_app_version'];
        if (typeof row['node_version'] === 'string')
          metadata['nodeVersion'] ??= row['node_version'];
        const capabilities = parseJsonObject(row['capabilities']);
        if (capabilities['codex'] !== undefined) metadata['codex'] ??= capabilities['codex'];
        if (capabilities['claudeCode'] !== undefined)
          metadata['claudeCode'] ??= capabilities['claudeCode'];
        insert.run(
          stringValue(row, 'id'),
          row['display_name'] === null ? null : stringValue(row, 'display_name'),
          row['registered_address'] === null ? 'unknown' : stringValue(row, 'registered_address'),
          JSON.stringify(metadata),
          hasConnectedColumn ? numberValue(row, 'connected') : 0,
          numberValue(row, 'disabled'),
          row['last_heartbeat_at'] === null ? null : numberValue(row, 'last_heartbeat_at'),
          numberValue(row, 'created_at'),
          numberValue(row, 'updated_at')
        );
      }
      database.exec('DROP TABLE nodes; ALTER TABLE nodes_metadata_only RENAME TO nodes;');
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(13, Date.now());
      database.exec('COMMIT');
      if (needsRebuild) database.exec('PRAGMA foreign_keys = ON');
      current = 13;
    } catch (error) {
      database.exec('ROLLBACK');
      if (needsRebuild) database.exec('PRAGMA foreign_keys = ON');
      throw error;
    }
  }
}
