import type { NodeSchemaMigration } from './types.js';
import { NODE_SCHEMA_MIGRATION_V17 } from './v017.js';

export const NODE_SCHEMA_MIGRATION_V18: NodeSchemaMigration = {
  version: 18,
  sql: `UPDATE agent_sessions
    SET metadata = json_set(metadata, '$.sessionPrompt', NULL)
    WHERE json_type(metadata, '$.sessionPrompt') IS NULL;`,
  preflight: (database) => NODE_SCHEMA_MIGRATION_V17.assert(database),
  assert: (database) => NODE_SCHEMA_MIGRATION_V17.assert(database)
};
