import type { DatabaseSync } from 'node:sqlite';
import type { NodeSchemaMigration } from './types.js';
import { NODE_SCHEMA_MIGRATION_V14 } from './v014.js';

export const NODE_SCHEMA_MIGRATION_V15: NodeSchemaMigration = {
  version: 15,
  sql: `ALTER TABLE scheduled_session_tasks
    ADD COLUMN notify_on_terminal INTEGER NOT NULL DEFAULT 0 CHECK (notify_on_terminal IN (0,1));`,
  assert(database: DatabaseSync): void {
    NODE_SCHEMA_MIGRATION_V14.assert(database);
    const columns = new Set(
      (
        database.prepare('PRAGMA table_info(scheduled_session_tasks)').all() as {
          name: string;
        }[]
      ).map((column) => column.name)
    );
    if (!columns.has('notify_on_terminal') || columns.has('notify_user_id'))
      throw new Error('NODE_DATABASE_SCHEMA_INVALID');
  }
};
