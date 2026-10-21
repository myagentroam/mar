import { DatabaseSync } from 'node:sqlite';
import type { NodeSchemaMigration } from './types.js';
import { NODE_SCHEMA_V13 } from './v013.js';
import { NODE_SCHEMA_MIGRATION_V14 } from './v014.js';
import { NODE_SCHEMA_MIGRATION_V15 } from './v015.js';
import { NODE_SCHEMA_MIGRATION_V16 } from './v016.js';
import { NODE_SCHEMA_MIGRATION_V17 } from './v017.js';
import { NODE_SCHEMA_MIGRATION_V18 } from './v018.js';
import { NODE_SCHEMA_MIGRATION_V19 } from './v019.js';

const sql = `CREATE INDEX scheduled_session_occurrences_unfinished
  ON scheduled_session_occurrences(status) WHERE status IN ('CLAIMED','SUBMITTED');`;

export const NODE_SCHEMA_MIGRATION_V20: NodeSchemaMigration = {
  version: 20,
  sql,
  preflight: (database) => NODE_SCHEMA_MIGRATION_V19.assert(database),
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
        NODE_SCHEMA_MIGRATION_V19
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
      if (JSON.stringify(schema(reference)) !== JSON.stringify(schema(database)))
        throw new Error('NODE_DATABASE_SCHEMA_INVALID:scheduled_session_occurrences_unfinished');
    } finally {
      reference.close();
    }
  }
};
