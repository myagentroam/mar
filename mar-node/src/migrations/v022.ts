import { DatabaseSync } from 'node:sqlite';
import type { NodeSchemaMigration } from './types.js';
import { NODE_SCHEMA_V13 } from './v013.js';
import { NODE_SCHEMA_MIGRATION_V14 } from './v014.js';
import { NODE_SCHEMA_MIGRATION_V15 } from './v015.js';
import { NODE_SCHEMA_MIGRATION_V16 } from './v016.js';
import { NODE_SCHEMA_MIGRATION_V17 } from './v017.js';
import { NODE_SCHEMA_MIGRATION_V18 } from './v018.js';
import { NODE_SCHEMA_MIGRATION_V19 } from './v019.js';
import { NODE_SCHEMA_MIGRATION_V20 } from './v020.js';
import { NODE_SCHEMA_MIGRATION_V21 } from './v021.js';

const sql = `ALTER TABLE agent_sessions ADD COLUMN parent_session_id TEXT;
UPDATE agent_sessions SET parent_session_id = CASE
  WHEN json_type(metadata, '$.parentSessionId') = 'text'
  THEN json_extract(metadata, '$.parentSessionId') ELSE NULL END;
UPDATE agent_sessions SET metadata = json_remove(metadata, '$.parentSessionId');
CREATE INDEX agent_sessions_workspace_parent ON agent_sessions(workspace_id, parent_session_id);`;

export const NODE_SCHEMA_MIGRATION_V22: NodeSchemaMigration = {
  version: 22,
  sql,
  preflight: (database) => NODE_SCHEMA_MIGRATION_V21.assert(database),
  assert(database) {
    const reference = new DatabaseSync(':memory:');
    try {
      reference.exec(NODE_SCHEMA_V13);
      for (const migration of [
        NODE_SCHEMA_MIGRATION_V14,
        NODE_SCHEMA_MIGRATION_V15,
        NODE_SCHEMA_MIGRATION_V16,
        NODE_SCHEMA_MIGRATION_V17,
        NODE_SCHEMA_MIGRATION_V18,
        NODE_SCHEMA_MIGRATION_V19,
        NODE_SCHEMA_MIGRATION_V20,
        NODE_SCHEMA_MIGRATION_V21
      ])
        reference.exec(migration.sql);
      reference.exec(sql);
      const schema = (db: DatabaseSync) =>
        db
          .prepare(
            "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name"
          )
          .all()
          .map((row) => [
            row.type,
            row.name,
            row.name === 'node_schema_migrations'
              ? String(row.sql).replace(/\s+/g, '')
              : String(row.sql).replace(/\s+/g, ' ').trim()
          ]);
      const actual = schema(database);
      const expected = schema(reference);
      const mismatch =
        expected.find(
          (row) => !actual.some((value) => JSON.stringify(value) === JSON.stringify(row))
        ) ??
        actual.find(
          (row) => !expected.some((value) => JSON.stringify(value) === JSON.stringify(row))
        );
      if (mismatch !== undefined)
        throw new Error(`NODE_DATABASE_SCHEMA_INVALID:${String(mismatch[1])}`);
    } finally {
      reference.close();
    }
  }
};
