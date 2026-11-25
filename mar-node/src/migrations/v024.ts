import { DatabaseSync } from 'node:sqlite';
import { legacyCronTimeGroups } from './v024-cron.js';
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
import { NODE_SCHEMA_MIGRATION_V22 } from './v022.js';
import { NODE_SCHEMA_MIGRATION_V23 } from './v023.js';

const sql = `CREATE TABLE _node_v24_scheduled_session_tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  new_session TEXT CHECK (new_session IS NULL OR json_valid(new_session)),
  workspace_id TEXT NOT NULL,
  runner TEXT NOT NULL CHECK (runner IN ('mar-agent','codex','claude-code','opencode')),
  owner_user_id INTEGER NOT NULL CHECK (owner_user_id > 0),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  objective TEXT NOT NULL CHECK (length(objective) BETWEEN 1 AND 20000),
  cron TEXT,
  time_groups TEXT NOT NULL CHECK (json_valid(time_groups)),
  timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  next_run_at INTEGER CHECK (next_run_at IS NULL OR next_run_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  notify_on_terminal INTEGER NOT NULL DEFAULT 0 CHECK (notify_on_terminal IN (0,1)),
  grace_minutes INTEGER NOT NULL DEFAULT 60 CHECK (grace_minutes BETWEEN 0 AND 60),
  CHECK (session_id IS NULL OR new_session IS NULL),
  CHECK (session_id IS NOT NULL OR new_session IS NOT NULL OR (enabled=0 AND next_run_at IS NULL))
) STRICT;
INSERT INTO _node_v24_scheduled_session_tasks
  (id,session_id,workspace_id,runner,owner_user_id,name,objective,cron,time_groups,timezone,enabled,revision,next_run_at,created_at,updated_at,notify_on_terminal)
SELECT t.id,t.session_id,t.workspace_id,t.runner,t.owner_user_id,
  substr(COALESCE(NULLIF(trim(json_extract(s.metadata,'$.customTitle')),''),
    NULLIF(trim(json_extract(s.metadata,'$.runnerTitle')),''),t.session_id),1,160),
  t.objective,t.cron,'[]',t.timezone,t.enabled,t.revision,t.next_run_at,t.created_at,t.updated_at,t.notify_on_terminal
FROM scheduled_session_tasks t LEFT JOIN agent_sessions s ON t.session_id=s.id;
DROP TABLE scheduled_session_tasks;
ALTER TABLE _node_v24_scheduled_session_tasks RENAME TO scheduled_session_tasks;
CREATE INDEX scheduled_session_tasks_due ON scheduled_session_tasks(enabled, next_run_at);
CREATE INDEX scheduled_session_tasks_workspace ON scheduled_session_tasks(workspace_id, id);
CREATE INDEX scheduled_session_tasks_session ON scheduled_session_tasks(session_id, id);
ALTER TABLE scheduled_session_proposals ADD COLUMN name TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 160);
ALTER TABLE scheduled_session_proposals ADD COLUMN time_groups TEXT CHECK (time_groups IS NULL OR json_valid(time_groups));
CREATE TABLE _node_v24_scheduled_session_occurrences (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, due_at INTEGER NOT NULL CHECK (due_at >= 0),
  status TEXT NOT NULL CHECK (status IN ('CLAIMED','WAITING','SUBMITTING','SUBMITTED','SUCCEEDED','SKIPPED','FAILED','CANCELLED')),
  code TEXT, run_id TEXT, created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  task_snapshot TEXT CHECK (task_snapshot IS NULL OR json_valid(task_snapshot)),
  expires_at INTEGER, actual_started_at INTEGER, ended_at INTEGER, execution_session_id TEXT,
  UNIQUE (task_id,due_at)
) STRICT;
INSERT INTO _node_v24_scheduled_session_occurrences (id,task_id,due_at,status,code,run_id,created_at,updated_at,execution_session_id)
  SELECT o.id,o.task_id,o.due_at,o.status,o.code,o.run_id,o.created_at,o.updated_at,
    CASE WHEN o.run_id IS NOT NULL THEN s.id END
  FROM scheduled_session_occurrences o LEFT JOIN scheduled_session_tasks t ON o.task_id=t.id
  LEFT JOIN agent_sessions s ON s.id=t.session_id AND s.workspace_id=t.workspace_id AND s.runner=t.runner;
DROP TABLE scheduled_session_occurrences;
ALTER TABLE _node_v24_scheduled_session_occurrences RENAME TO scheduled_session_occurrences;
CREATE INDEX scheduled_session_occurrences_recent ON scheduled_session_occurrences(task_id,due_at DESC);
CREATE INDEX scheduled_session_occurrences_unfinished ON scheduled_session_occurrences(status)
  WHERE status IN ('CLAIMED','SUBMITTING','SUBMITTED');
CREATE INDEX scheduled_session_occurrences_waiting ON scheduled_session_occurrences(expires_at) WHERE status='WAITING';`;

const dropLegacyColumns = `ALTER TABLE scheduled_session_tasks DROP COLUMN cron;
ALTER TABLE scheduled_session_proposals DROP COLUMN cron;`;

const schema = (db: DatabaseSync) =>
  db
    .prepare(
      `SELECT name,sql FROM sqlite_master
  WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name`
    )
    .all()
    .map(({ name, sql }) => [
      name,
      name === 'node_schema_migrations'
        ? String(sql).replace(/\s+/g, '')
        : String(sql).replace(/\s+/g, ' ').trim()
    ]);

/** Rebuild and compare the complete v24 schema, with an optional later reference-only transform. */
export function assertNodeSchemaV24(
  database: DatabaseSync,
  transformReference?: (reference: DatabaseSync) => void
): void {
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
      NODE_SCHEMA_MIGRATION_V21,
      NODE_SCHEMA_MIGRATION_V22,
      NODE_SCHEMA_MIGRATION_V23
    ])
      reference.exec(migration.sql);
    reference.exec(sql);
    reference.exec(dropLegacyColumns);
    transformReference?.(reference);
    const actual = new Map(schema(database).map(([name, ddl]) => [name, ddl] as const));
    const expected = new Map(schema(reference).map(([name, ddl]) => [name, ddl] as const));
    for (const [name, ddl] of expected)
      if (actual.get(name) !== ddl) throw new Error(`NODE_DATABASE_SCHEMA_INVALID:${String(name)}`);
    for (const name of actual.keys())
      if (!expected.has(name)) throw new Error(`NODE_DATABASE_SCHEMA_INVALID:${String(name)}`);
  } finally {
    reference.close();
  }
}

export const NODE_SCHEMA_MIGRATION_V24: NodeSchemaMigration = {
  version: 24,
  sql,
  preflight: NODE_SCHEMA_MIGRATION_V23.assert,
  afterSql(database) {
    for (const table of ['scheduled_session_tasks', 'scheduled_session_proposals']) {
      const read = database.prepare(`SELECT id,cron FROM ${table} WHERE cron IS NOT NULL`);
      const write = database.prepare(`UPDATE ${table} SET time_groups=? WHERE id=?`);
      for (const { id, cron } of read.all() as { id: string; cron: string }[]) {
        let groups: string;
        try {
          groups = JSON.stringify(legacyCronTimeGroups(cron));
        } catch {
          throw new Error(`NODE_DATABASE_SCHEDULE_MIGRATION_INVALID:${table}:${id}`);
        }
        write.run(groups, id);
      }
    }
    database.exec(dropLegacyColumns);
  },
  assert(database) {
    assertNodeSchemaV24(database);
  }
};
