import type { NodeSchemaMigration } from './types.js';
import { assertNodeSchemaV24, NODE_SCHEMA_MIGRATION_V24 } from './v024.js';
import { NODE_SCHEMA_MIGRATION_V25 } from './v025.js';

const sql = `CREATE TABLE whiteboards (
  owner_session_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL,
  next_entry INTEGER NOT NULL,
  entries TEXT NOT NULL,
  recent_changes TEXT NOT NULL
);`;

export const NODE_SCHEMA_MIGRATION_V26: NodeSchemaMigration = {
  version: 26,
  sql,
  preflight: NODE_SCHEMA_MIGRATION_V25.assert,
  assert(database) {
    assertNodeSchemaV24(database, (reference) => {
      reference.exec(NODE_SCHEMA_MIGRATION_V25.sql);
      reference.exec(sql);
    });
    if (
      database
        .prepare(
          `SELECT 1 FROM whiteboards board LEFT JOIN agent_sessions session
      ON session.id=board.owner_session_id WHERE session.id IS NULL LIMIT 1`
        )
        .get()
    ) {
      throw new Error('NODE_DATABASE_SCHEMA_INVALID:relations:whiteboards');
    }
  }
};
