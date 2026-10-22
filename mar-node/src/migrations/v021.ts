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

const sql = `ALTER TABLE workspaces ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(settings) AND json_type(settings) = 'object');
UPDATE workspaces SET settings = json_object('git', json_object(
  'preserveGitConfig', json(CASE WHEN preserve_git_config = 1 THEN 'true' ELSE 'false' END),
  'includeParentRepository', json('true')));
ALTER TABLE workspaces DROP COLUMN preserve_git_config;
CREATE TABLE node_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  settings TEXT NOT NULL CHECK (json_valid(settings) AND json_type(settings) = 'object')
) STRICT;
INSERT INTO node_settings (id, settings)
SELECT 1, json_object('runnerDefaults', json_group_object(runner,
  json_object('model', model, 'effort', effort, 'access', access))) FROM runner_defaults;
DROP TABLE runner_defaults;`;

export const NODE_SCHEMA_MIGRATION_V21: NodeSchemaMigration = {
  version: 21,
  sql,
  preflight: (database) => NODE_SCHEMA_MIGRATION_V20.assert(database),
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
        NODE_SCHEMA_MIGRATION_V20
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
      const expected = schema(reference);
      const actual = schema(database);
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
