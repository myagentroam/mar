import type { NodeSchemaMigration } from './types.js';

/** Example only: never import this migration into the production catalog. */
export const NODE_SCHEMA_MIGRATION_DEMO: NodeSchemaMigration = {
  version: 1,
  sql: 'CREATE TABLE migration_demo_example (id INTEGER PRIMARY KEY) STRICT;',
  assert: (database) => {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='migration_demo_example'").get())
      throw new Error('NODE_DATABASE_SCHEMA_INVALID:migration_demo_example');
  }
};
