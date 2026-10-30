import type { NodeSchemaMigration } from './types.js';
import { NODE_SCHEMA_MIGRATION_V22 } from './v022.js';

const defaultPaths = ['codex', 'claude-code', 'opencode', 'mar-agent'].map(
  (runner) => `$.runnerDefaults."${runner}"`
);

const rename = (column: string, path: string) =>
  `json_remove(CASE WHEN json_type(${column}, '${path}.modelId') IS NULL
    THEN json_set(${column}, '${path}.modelId', json_extract(${column}, '${path}.model'))
    ELSE ${column} END, '${path}.model')`;

export const NODE_SCHEMA_MIGRATION_V23: NodeSchemaMigration = {
  version: 23,
  sql: [
    `UPDATE agent_sessions SET metadata = ${rename('metadata', '$')}
      WHERE json_type(metadata, '$.model') IS NOT NULL;`,
    ...defaultPaths.map(
      (path) => `UPDATE node_settings SET settings = ${rename('settings', path)}
        WHERE json_type(settings, '${path}.model') IS NOT NULL;`
    )
  ].join('\n'),
  preflight: (database) => NODE_SCHEMA_MIGRATION_V22.assert(database),
  assert(database) {
    NODE_SCHEMA_MIGRATION_V22.assert(database);
    if (
      database
        .prepare("SELECT 1 FROM agent_sessions WHERE json_type(metadata, '$.model') IS NOT NULL")
        .get() !== undefined ||
      defaultPaths.some(
        (path) =>
          database
            .prepare(
              `SELECT 1 FROM node_settings WHERE json_type(settings, '${path}.model') IS NOT NULL`
            )
            .get() !== undefined
      )
    )
      throw new Error('NODE_DATABASE_SCHEMA_INVALID:modelId');
  }
};
