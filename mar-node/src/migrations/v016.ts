import { DatabaseSync } from 'node:sqlite';
import type { NodeSchemaMigration } from './types.js';
import { assertNodeRelations } from '../database-relations.js';
import { NODE_SCHEMA_V13 } from './v013.js';
import { NODE_SCHEMA_MIGRATION_V14 } from './v014.js';
import { NODE_SCHEMA_MIGRATION_V15 } from './v015.js';

const obsoleteTables = [
  'share_sessions',
  'share_invitations',
  'share_participants',
  'worktree_snapshots',
  'worktree_shares'
] as const;
const currentTables = [
  'agent_sessions',
  'conversation_files',
  'conversation_template_publish_jobs',
  'conversation_template_versions',
  'hosted_conversation_messages',
  'hosted_conversations',
  'mcp_installations',
  'node_schema_migrations',
  'runner_defaults',
  'scheduled_session_occurrences',
  'scheduled_session_proposals',
  'scheduled_session_tasks',
  'terminal_sessions',
  'workspaces'
] as const;
const rebuiltColumns: Record<string, readonly string[]> = {
  agent_sessions: ['id', 'workspace_id', 'runner', 'pin_order', 'metadata'],
  conversation_files: [
    'id',
    'conversation_id',
    'category',
    'relative_path',
    'display_name',
    'mime_type',
    'size',
    'source',
    'turn_id',
    'item_id',
    'created_at',
    'updated_at'
  ],
  conversation_template_publish_jobs: [
    'id',
    'template_id',
    'draft_revision',
    'stage',
    'status',
    'version_id',
    'error_code',
    'error_summary',
    'requested_by_user_id',
    'draft',
    'created_at',
    'updated_at'
  ],
  hosted_conversation_messages: [
    'conversation_id',
    'client_message_id',
    'run_id',
    'status',
    'created_at',
    'updated_at',
    'user_text_present'
  ],
  hosted_conversations: [
    'id',
    'user_storage_key',
    'conversation_storage_key',
    'client_request_id',
    'node_id',
    'session_id',
    'template_id',
    'template_name',
    'active_version_id',
    'title',
    'status',
    'model_id',
    'template_deleted',
    'used_bytes',
    'max_bytes',
    'created_at',
    'updated_at',
    'last_activity_at',
    'pinned_at',
    'title_source'
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
  ],
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
    'updated_at',
    'notify_on_terminal'
  ],
  terminal_sessions: [
    'id',
    'workspace_id',
    'profile_id',
    'state',
    'exit_code',
    'rows',
    'cols',
    'latest_sequence',
    'created_at',
    'updated_at'
  ]
};

export const NODE_SCHEMA_MIGRATION_V16: NodeSchemaMigration = {
  version: 16,
  rebuildTables: true,
  preflight(database: DatabaseSync): void {
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      if (obsoleteTables.some((table) => table === name)) {
        if (database.prepare(`SELECT 1 FROM "${name}" LIMIT 1`).get() !== undefined)
          throw new Error(`NODE_DATABASE_OBSOLETE_TABLE_NOT_EMPTY:${name}`);
      } else if (!currentTables.some((table) => table === name)) {
        throw new Error(`NODE_DATABASE_SCHEMA_INVALID:table:${name}`);
      }
    }
    for (const [table, expected] of Object.entries(rebuiltColumns)) {
      const actual = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (
        actual.length !== expected.length ||
        actual.some((column) => !expected.includes(column.name))
      )
        throw new Error(`NODE_DATABASE_SCHEMA_INVALID:${table}`);
    }
    if (
      database.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' LIMIT 1").get() !==
      undefined
    )
      throw new Error('NODE_DATABASE_SCHEMA_INVALID:triggers');
    const reference = new DatabaseSync(':memory:');
    try {
      reference.exec(NODE_SCHEMA_V13);
      reference.exec(NODE_SCHEMA_MIGRATION_V14.sql);
      reference.exec(NODE_SCHEMA_MIGRATION_V15.sql);
      const normalize = (sql: string): string =>
        sql
          .replace(/\s+REFERENCES\s+\w+\([^)]*\)(?:\s+ON DELETE\s+(?:CASCADE|SET NULL))?/giu, '')
          .replace(/"(\w+)"/gu, '$1')
          .replace(/\s+/gu, ' ')
          .replace(/\s*([(),])\s*/gu, '$1')
          .trim();
      const query =
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name";
      const expected = reference.prepare(query).all() as {
        type: string;
        name: string;
        tbl_name: string;
        sql: string;
      }[];
      const actual = (
        database.prepare(query).all() as {
          type: string;
          name: string;
          tbl_name: string;
          sql: string;
        }[]
      ).filter((entry) => !obsoleteTables.some((table) => table === entry.tbl_name));
      const definition = (entry: { name: string; sql: string }): string => {
        const sql = normalize(entry.sql);
        // Released upgrades appended this nullable column; new installs declared it second.
        return entry.name === 'terminal_sessions'
          ? sql.replace(/(?:,workspace_id TEXT|workspace_id TEXT,)/u, '')
          : sql;
      };
      if (
        actual.length !== expected.length ||
        expected.some(
          (entry, index) =>
            entry.type !== actual[index]?.type ||
            entry.name !== actual[index]?.name ||
            definition(entry) !== definition(actual[index]!)
        )
      )
        throw new Error('NODE_DATABASE_SCHEMA_INVALID:definitions');
    } finally {
      reference.close();
    }
  },
  sql: `DROP TABLE IF EXISTS share_sessions;
DROP TABLE IF EXISTS share_invitations;
DROP TABLE IF EXISTS share_participants;
DROP TABLE IF EXISTS worktree_snapshots;
DROP TABLE IF EXISTS worktree_shares;
CREATE TABLE _node_v16_agent_sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    runner TEXT NOT NULL CHECK (runner IN ('mar-agent', 'codex', 'claude-code', 'opencode')),
    pin_order INTEGER CHECK (pin_order IS NULL OR pin_order >= 0),
    metadata TEXT NOT NULL CHECK (json_valid(metadata))
  ) STRICT;
INSERT INTO _node_v16_agent_sessions (id,workspace_id,runner,pin_order,metadata) SELECT id,workspace_id,runner,pin_order,metadata FROM agent_sessions;
DROP TABLE agent_sessions;
ALTER TABLE _node_v16_agent_sessions RENAME TO agent_sessions;
CREATE TABLE _node_v16_conversation_files (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('UPLOAD','OUTPUT')),
    relative_path TEXT NOT NULL,
    display_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    source TEXT NOT NULL CHECK (source IN ('USER','AGENT','SYSTEM')),
    turn_id TEXT,
    item_id TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    UNIQUE (conversation_id, category, relative_path)
  ) STRICT;
INSERT INTO _node_v16_conversation_files (id,conversation_id,category,relative_path,display_name,mime_type,size,source,turn_id,item_id,created_at,updated_at) SELECT id,conversation_id,category,relative_path,display_name,mime_type,size,source,turn_id,item_id,created_at,updated_at FROM conversation_files;
DROP TABLE conversation_files;
ALTER TABLE _node_v16_conversation_files RENAME TO conversation_files;
CREATE INDEX conversation_files_conversation_updated
    ON conversation_files(conversation_id, updated_at DESC, id);
CREATE TABLE _node_v16_conversation_template_publish_jobs (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    draft_revision INTEGER NOT NULL CHECK (draft_revision > 0),
    stage TEXT NOT NULL CHECK (
      stage IN ('VALIDATING','ENUMERATING','COPYING','SCANNING','MANIFEST','SEALED','REGISTERED')
    ),
    status TEXT NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
    version_id TEXT,
    error_code TEXT,
    error_summary TEXT,
    requested_by_user_id INTEGER NOT NULL CHECK (requested_by_user_id > 0),
    draft TEXT NOT NULL CHECK (json_valid(draft)),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT;
INSERT INTO _node_v16_conversation_template_publish_jobs (id,template_id,draft_revision,stage,status,version_id,error_code,error_summary,requested_by_user_id,draft,created_at,updated_at) SELECT id,template_id,draft_revision,stage,status,version_id,error_code,error_summary,requested_by_user_id,draft,created_at,updated_at FROM conversation_template_publish_jobs;
DROP TABLE conversation_template_publish_jobs;
ALTER TABLE _node_v16_conversation_template_publish_jobs RENAME TO conversation_template_publish_jobs;
CREATE INDEX conversation_template_publish_jobs_status
    ON conversation_template_publish_jobs(status, updated_at);
CREATE INDEX conversation_template_publish_jobs_template
    ON conversation_template_publish_jobs(template_id, created_at, id);
CREATE TABLE _node_v16_hosted_conversation_messages (
    conversation_id TEXT NOT NULL,
    client_message_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','INTERRUPTED')),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0), user_text_present INTEGER NOT NULL DEFAULT 1
      CHECK (user_text_present IN (0,1)),
    PRIMARY KEY (conversation_id, client_message_id)
  ) STRICT;
INSERT INTO _node_v16_hosted_conversation_messages (conversation_id,client_message_id,run_id,status,created_at,updated_at,user_text_present) SELECT conversation_id,client_message_id,run_id,status,created_at,updated_at,user_text_present FROM hosted_conversation_messages;
DROP TABLE hosted_conversation_messages;
ALTER TABLE _node_v16_hosted_conversation_messages RENAME TO hosted_conversation_messages;
CREATE TABLE _node_v16_hosted_conversations (
    id TEXT PRIMARY KEY,
    user_storage_key TEXT NOT NULL,
    conversation_storage_key TEXT NOT NULL,
    client_request_id TEXT,
    node_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    template_id TEXT NOT NULL,
    template_name TEXT NOT NULL,
    active_version_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE')),
    model_id TEXT NOT NULL,
    template_deleted INTEGER NOT NULL DEFAULT 0 CHECK (template_deleted IN (0,1)),
    used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
    max_bytes INTEGER NOT NULL CHECK (max_bytes > 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    last_activity_at INTEGER NOT NULL CHECK (last_activity_at >= 0),
    pinned_at INTEGER CHECK (pinned_at IS NULL OR pinned_at >= 0),
    title_source TEXT NOT NULL DEFAULT 'CUSTOM'
      CHECK (title_source IN ('DEFAULT','AUTO','CUSTOM')),
    UNIQUE (user_storage_key, conversation_storage_key),
    UNIQUE (user_storage_key, client_request_id)
  ) STRICT;
INSERT INTO _node_v16_hosted_conversations (id,user_storage_key,conversation_storage_key,client_request_id,node_id,session_id,template_id,template_name,active_version_id,title,status,model_id,template_deleted,used_bytes,max_bytes,created_at,updated_at,last_activity_at,pinned_at,title_source) SELECT id,user_storage_key,conversation_storage_key,client_request_id,node_id,session_id,template_id,template_name,active_version_id,title,status,model_id,template_deleted,used_bytes,max_bytes,created_at,updated_at,last_activity_at,pinned_at,title_source FROM hosted_conversations;
DROP TABLE hosted_conversations;
ALTER TABLE _node_v16_hosted_conversations RENAME TO hosted_conversations;
CREATE INDEX hosted_conversations_template
    ON hosted_conversations(template_id, status, id);
CREATE INDEX hosted_conversations_user_pin_activity
    ON hosted_conversations(
      user_storage_key,
      (pinned_at IS NOT NULL) DESC,
      last_activity_at DESC,
      id DESC
    );
CREATE TABLE _node_v16_scheduled_session_occurrences (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    due_at INTEGER NOT NULL CHECK (due_at >= 0),
    status TEXT NOT NULL CHECK (status IN ('CLAIMED','SUBMITTED','SUCCEEDED','SKIPPED','FAILED')),
    code TEXT,
    run_id TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    UNIQUE(task_id, due_at)
  ) STRICT;
INSERT INTO _node_v16_scheduled_session_occurrences (id,task_id,due_at,status,code,run_id,created_at,updated_at) SELECT id,task_id,due_at,status,code,run_id,created_at,updated_at FROM scheduled_session_occurrences;
DROP TABLE scheduled_session_occurrences;
ALTER TABLE _node_v16_scheduled_session_occurrences RENAME TO scheduled_session_occurrences;
CREATE INDEX scheduled_session_occurrences_recent
    ON scheduled_session_occurrences(task_id, due_at DESC);
CREATE TABLE _node_v16_scheduled_session_proposals (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    proposed_by_user_id INTEGER NOT NULL CHECK (proposed_by_user_id > 0),
    base_revision INTEGER NOT NULL CHECK (base_revision > 0),
    objective TEXT CHECK (objective IS NULL OR length(objective) BETWEEN 1 AND 20000),
    cron TEXT,
    timezone TEXT,
    status TEXT NOT NULL CHECK (status IN ('PENDING','ACCEPTED','REJECTED','STALE')),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    resolved_at INTEGER
  ) STRICT;
INSERT INTO _node_v16_scheduled_session_proposals (id,task_id,proposed_by_user_id,base_revision,objective,cron,timezone,status,created_at,resolved_at) SELECT id,task_id,proposed_by_user_id,base_revision,objective,cron,timezone,status,created_at,resolved_at FROM scheduled_session_proposals;
DROP TABLE scheduled_session_proposals;
ALTER TABLE _node_v16_scheduled_session_proposals RENAME TO scheduled_session_proposals;
CREATE INDEX scheduled_session_proposals_pending
    ON scheduled_session_proposals(task_id, status, created_at DESC);
CREATE TABLE _node_v16_scheduled_session_tasks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
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
  , notify_on_terminal INTEGER NOT NULL DEFAULT 0 CHECK (notify_on_terminal IN (0,1))) STRICT;
INSERT INTO _node_v16_scheduled_session_tasks (id,session_id,workspace_id,runner,owner_user_id,objective,cron,timezone,enabled,revision,next_run_at,created_at,updated_at,notify_on_terminal) SELECT id,session_id,workspace_id,runner,owner_user_id,objective,cron,timezone,enabled,revision,next_run_at,created_at,updated_at,notify_on_terminal FROM scheduled_session_tasks;
DROP TABLE scheduled_session_tasks;
ALTER TABLE _node_v16_scheduled_session_tasks RENAME TO scheduled_session_tasks;
CREATE INDEX scheduled_session_tasks_due
    ON scheduled_session_tasks(enabled, next_run_at);
CREATE TABLE _node_v16_terminal_sessions (
      id TEXT PRIMARY KEY, workspace_id TEXT,
      profile_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('RUNNING', 'EXITED', 'CLOSED')),
      exit_code INTEGER, rows INTEGER NOT NULL CHECK (rows > 0 AND rows <= 1000),
      cols INTEGER NOT NULL CHECK (cols > 0 AND cols <= 1000),
      latest_sequence INTEGER NOT NULL CHECK (latest_sequence >= 0),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
INSERT INTO _node_v16_terminal_sessions (id,workspace_id,profile_id,state,exit_code,rows,cols,latest_sequence,created_at,updated_at) SELECT id,workspace_id,profile_id,state,exit_code,rows,cols,latest_sequence,created_at,updated_at FROM terminal_sessions;
DROP TABLE terminal_sessions;
ALTER TABLE _node_v16_terminal_sessions RENAME TO terminal_sessions;`,
  assert(database: DatabaseSync): void {
    NODE_SCHEMA_MIGRATION_V15.assert(database);
    NODE_SCHEMA_MIGRATION_V16.preflight!(database);
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    if (
      tables.length !== currentTables.length ||
      tables.some(({ name }) => !currentTables.some((table) => table === name))
    )
      throw new Error('NODE_DATABASE_SCHEMA_INVALID:tables');
    for (const { name } of tables) {
      if (database.prepare(`PRAGMA foreign_key_list(${name})`).all().length !== 0)
        throw new Error(`NODE_DATABASE_SCHEMA_INVALID:foreign_keys:${name}`);
    }
    if (
      database.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' LIMIT 1").get() !==
      undefined
    )
      throw new Error('NODE_DATABASE_SCHEMA_INVALID:triggers');
    assertNodeRelations(database);
  }
};
