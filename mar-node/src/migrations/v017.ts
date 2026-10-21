import { DatabaseSync } from 'node:sqlite';
import type { NodeSchemaMigration } from './types.js';
import { NODE_SCHEMA_V13 } from './v013.js';
import { NODE_SCHEMA_MIGRATION_V14 } from './v014.js';
import { NODE_SCHEMA_MIGRATION_V15 } from './v015.js';
import { NODE_SCHEMA_MIGRATION_V16 } from './v016.js';

const sql = `CREATE TABLE model_usage_outbox (
  namespace TEXT NOT NULL,
  record_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER,
  PRIMARY KEY(namespace, record_id)
) STRICT;
CREATE INDEX model_usage_outbox_updated ON model_usage_outbox(updated_at);`;

export const NODE_SCHEMA_MIGRATION_V17: NodeSchemaMigration = {
  version: 17,
  sql,
  preflight: (database) => NODE_SCHEMA_MIGRATION_V16.assert(database),
  assert(database) {
    const reference = new DatabaseSync(':memory:');
    try {
      reference.exec(NODE_SCHEMA_V13);
      reference.exec(NODE_SCHEMA_MIGRATION_V14.sql);
      reference.exec(NODE_SCHEMA_MIGRATION_V15.sql);
      reference.exec(NODE_SCHEMA_MIGRATION_V16.sql);
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
      if (JSON.stringify(schema(reference)) !== JSON.stringify(schema(database)))
        throw new Error('NODE_DATABASE_SCHEMA_INVALID:model_usage');
    } finally {
      reference.close();
    }
  }
};
