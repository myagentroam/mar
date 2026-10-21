import type { NodeSchemaMigration } from './types.js';
import { NODE_SCHEMA_MIGRATION_V18 } from './v018.js';

export const NODE_SCHEMA_MIGRATION_V19: NodeSchemaMigration = {
  version: 19,
  sql: `UPDATE agent_sessions
    SET metadata = json_set(metadata, '$.parentSessionId', NULL)
    WHERE json_type(metadata, '$.parentSessionId') IS NULL;`,
  preflight: (database) => NODE_SCHEMA_MIGRATION_V18.assert(database),
  assert: (database) => NODE_SCHEMA_MIGRATION_V18.assert(database)
};
