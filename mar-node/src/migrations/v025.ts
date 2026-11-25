import type { NodeSchemaMigration } from './types.js';
import { assertNodeSchemaV24, NODE_SCHEMA_MIGRATION_V24 } from './v024.js';

const sql = `ALTER TABLE scheduled_session_tasks RENAME COLUMN time_groups TO triggers;
ALTER TABLE scheduled_session_proposals RENAME COLUMN time_groups TO triggers;`;

/** Invalidate the previous scheduling format without reading or converting it. */
export const NODE_SCHEMA_MIGRATION_V25: NodeSchemaMigration = {
  version: 25,
  sql,
  preflight: (database) => NODE_SCHEMA_MIGRATION_V24.assert(database),
  afterSql(database) {
    const now = Date.now();
    database
      .prepare(
        `UPDATE scheduled_session_tasks SET triggers='[]',enabled=0,
      next_run_at=NULL,revision=revision+1,updated_at=?`
      )
      .run(now);
    database
      .prepare(
        `UPDATE scheduled_session_occurrences
      SET status='SKIPPED',code='SCHEDULE_TASK_CHANGED',updated_at=?
      WHERE status IN ('CLAIMED','WAITING')`
      )
      .run(now);
    database.exec(`DELETE FROM scheduled_session_proposals WHERE status='PENDING';
      UPDATE scheduled_session_proposals SET triggers=NULL WHERE triggers IS NOT NULL;`);
  },
  assert(database) {
    assertNodeSchemaV24(database, (reference) => reference.exec(sql));
  }
};
