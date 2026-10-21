import type { DatabaseSync } from 'node:sqlite';
import type { NodeSchemaMigration } from './types.js';

export const NODE_SCHEMA_MIGRATION_V14: NodeSchemaMigration = {
  version: 14,
  sql: `CREATE TABLE scheduled_session_tasks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE REFERENCES agent_sessions(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    runner TEXT NOT NULL CHECK (runner IN ('mar-agent','codex','claude-code','opencode')),
    owner_user_id INTEGER NOT NULL CHECK (owner_user_id > 0),
    objective TEXT NOT NULL CHECK (length(objective) BETWEEN 1 AND 20000),
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
    revision INTEGER NOT NULL CHECK (revision > 0),
    next_run_at INTEGER CHECK (next_run_at IS NULL OR next_run_at >= 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT;
  CREATE INDEX scheduled_session_tasks_due
    ON scheduled_session_tasks(enabled, next_run_at);
  CREATE TABLE scheduled_session_occurrences (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES scheduled_session_tasks(id) ON DELETE CASCADE,
    due_at INTEGER NOT NULL CHECK (due_at >= 0),
    status TEXT NOT NULL CHECK (status IN ('CLAIMED','SUBMITTED','SUCCEEDED','SKIPPED','FAILED')),
    code TEXT,
    run_id TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    UNIQUE(task_id, due_at)
  ) STRICT;
  CREATE INDEX scheduled_session_occurrences_recent
    ON scheduled_session_occurrences(task_id, due_at DESC);
  CREATE TABLE scheduled_session_proposals (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES scheduled_session_tasks(id) ON DELETE CASCADE,
    proposed_by_user_id INTEGER NOT NULL CHECK (proposed_by_user_id > 0),
    base_revision INTEGER NOT NULL CHECK (base_revision > 0),
    objective TEXT CHECK (objective IS NULL OR length(objective) BETWEEN 1 AND 20000),
    cron TEXT,
    timezone TEXT,
    status TEXT NOT NULL CHECK (status IN ('PENDING','ACCEPTED','REJECTED','STALE')),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    resolved_at INTEGER
  ) STRICT;
  CREATE INDEX scheduled_session_proposals_pending
    ON scheduled_session_proposals(task_id, status, created_at DESC);`,
  assert(database: DatabaseSync): void {
    const tables = {
      scheduled_session_tasks: [
        'id',
        'session_id',
        'workspace_id',
        'runner',
        'owner_user_id',
        'objective',
        'cron',
        'timezone',
        'enabled',
        'revision',
        'next_run_at',
        'created_at',
        'updated_at'
      ],
      scheduled_session_occurrences: [
        'id',
        'task_id',
        'due_at',
        'status',
        'code',
        'run_id',
        'created_at',
        'updated_at'
      ],
      scheduled_session_proposals: [
        'id',
        'task_id',
        'proposed_by_user_id',
        'base_revision',
        'objective',
        'cron',
        'timezone',
        'status',
        'created_at',
        'resolved_at'
      ]
    } as const;
    for (const [table, required] of Object.entries(tables)) {
      const row = database
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get(table) as { sql: string } | undefined;
      const columns = new Set(
        (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
          (column) => column.name
        )
      );
      if (
        row === undefined ||
        !row.sql.endsWith('STRICT') ||
        required.some((column) => !columns.has(column))
      )
        throw new Error('NODE_DATABASE_SCHEMA_INVALID');
    }
    for (const name of [
      'scheduled_session_tasks_due',
      'scheduled_session_occurrences_recent',
      'scheduled_session_proposals_pending'
    ])
      if (
        database
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
          .get(name) === undefined
      )
        throw new Error('NODE_DATABASE_SCHEMA_INVALID');
  }
};
