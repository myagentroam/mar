import { DatabaseSync } from 'node:sqlite';

export const NODE_SCHEMA_VERSION_V13 = 13;

/** Complete schema at the supported SQLite baseline; future changes use the migration catalog. */
export const NODE_SCHEMA_V13 = String.raw`CREATE TABLE "agent_sessions" (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    runner TEXT NOT NULL CHECK (runner IN ('mar-agent', 'codex', 'claude-code', 'opencode')),
    pin_order INTEGER CHECK (pin_order IS NULL OR pin_order >= 0),
    metadata TEXT NOT NULL CHECK (json_valid(metadata))
  ) STRICT;

CREATE TABLE "conversation_files" (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES hosted_conversations(id) ON DELETE CASCADE,
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

CREATE TABLE conversation_template_publish_jobs (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    draft_revision INTEGER NOT NULL CHECK (draft_revision > 0),
    stage TEXT NOT NULL CHECK (
      stage IN ('VALIDATING','ENUMERATING','COPYING','SCANNING','MANIFEST','SEALED','REGISTERED')
    ),
    status TEXT NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
    version_id TEXT REFERENCES conversation_template_versions(id) ON DELETE SET NULL,
    error_code TEXT,
    error_summary TEXT,
    requested_by_user_id INTEGER NOT NULL CHECK (requested_by_user_id > 0),
    draft TEXT NOT NULL CHECK (json_valid(draft)),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT;

CREATE TABLE conversation_template_versions (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    version_number INTEGER NOT NULL CHECK (version_number > 0),
    draft_revision INTEGER NOT NULL CHECK (draft_revision > 0),
    status TEXT NOT NULL CHECK (status IN ('AVAILABLE','DISABLED','CORRUPTED','RETAINED')),
    storage_key TEXT NOT NULL UNIQUE,
    manifest TEXT NOT NULL CHECK (json_valid(manifest)),
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
    file_count INTEGER NOT NULL CHECK (file_count >= 0),
    total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
    host_policy_version INTEGER NOT NULL CHECK (host_policy_version > 0),
    published_by_user_id INTEGER NOT NULL CHECK (published_by_user_id > 0),
    published_at INTEGER NOT NULL CHECK (published_at >= 0),
    reference_count INTEGER NOT NULL DEFAULT 0 CHECK (reference_count >= 0), mcp_config_hash TEXT NOT NULL DEFAULT '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
    CHECK (length(mcp_config_hash) = 64),
    UNIQUE (template_id, version_number)
  ) STRICT;

CREATE TABLE hosted_conversation_messages (
    conversation_id TEXT NOT NULL REFERENCES hosted_conversations(id) ON DELETE CASCADE,
    client_message_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','INTERRUPTED')),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0), user_text_present INTEGER NOT NULL DEFAULT 1
      CHECK (user_text_present IN (0,1)),
    PRIMARY KEY (conversation_id, client_message_id)
  ) STRICT;

CREATE TABLE "hosted_conversations" (
    id TEXT PRIMARY KEY,
    user_storage_key TEXT NOT NULL,
    conversation_storage_key TEXT NOT NULL,
    client_request_id TEXT,
    node_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    template_id TEXT NOT NULL,
    template_name TEXT NOT NULL,
    active_version_id TEXT NOT NULL REFERENCES conversation_template_versions(id),
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

CREATE TABLE mcp_installations (
      target_kind TEXT NOT NULL CHECK (target_kind IN ('NODE','WORKSPACE')),
      target_id TEXT NOT NULL, catalog_entry_id TEXT NOT NULL, server_name TEXT NOT NULL,
      display_name TEXT NOT NULL, version TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
      runtime TEXT NOT NULL CHECK (json_valid(runtime)),
      configuration TEXT NOT NULL CHECK (json_valid(configuration)), installed_at INTEGER NOT NULL,
      PRIMARY KEY (target_kind,target_id,server_name),
      CHECK ((target_kind='NODE' AND target_id='') OR (target_kind='WORKSPACE' AND target_id<>''))
    ) STRICT;

CREATE TABLE node_schema_migrations (
      version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL
    ) STRICT;

CREATE TABLE "runner_defaults" (
    runner TEXT PRIMARY KEY CHECK (runner IN ('mar-agent', 'codex', 'claude-code', 'opencode')),
    model TEXT NOT NULL, effort TEXT NOT NULL, access TEXT NOT NULL
  ) STRICT;

CREATE TABLE terminal_sessions (
      id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
      profile_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('RUNNING', 'EXITED', 'CLOSED')),
      exit_code INTEGER, rows INTEGER NOT NULL CHECK (rows > 0 AND rows <= 1000),
      cols INTEGER NOT NULL CHECK (cols > 0 AND cols <= 1000),
      latest_sequence INTEGER NOT NULL CHECK (latest_sequence >= 0),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;

CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('DIRECTORY', 'GIT_WORKSPACE')),
      git_summary TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    , preserve_git_config INTEGER NOT NULL DEFAULT 1 CHECK (preserve_git_config IN (0,1))) STRICT;

CREATE INDEX conversation_files_conversation_updated
    ON conversation_files(conversation_id, updated_at DESC, id);

CREATE INDEX conversation_template_publish_jobs_status
    ON conversation_template_publish_jobs(status, updated_at);

CREATE INDEX conversation_template_publish_jobs_template
    ON conversation_template_publish_jobs(template_id, created_at, id);

CREATE INDEX conversation_template_versions_template_status
    ON conversation_template_versions(template_id, status, published_at);

CREATE INDEX hosted_conversations_template
    ON hosted_conversations(template_id, status, id);

CREATE INDEX hosted_conversations_user_pin_activity
    ON hosted_conversations(
      user_storage_key,
      (pinned_at IS NOT NULL) DESC,
      last_activity_at DESC,
      id DESC
    );`;

export function assertNodeSchemaV13(database: DatabaseSync, exactBaseline = false): void {
  const required: Record<string, readonly string[]> = {
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
    conversation_template_versions: [
      'id',
      'template_id',
      'version_number',
      'draft_revision',
      'status',
      'storage_key',
      'manifest',
      'content_hash',
      'manifest_hash',
      'file_count',
      'total_bytes',
      'host_policy_version',
      'published_by_user_id',
      'published_at',
      'reference_count',
      'mcp_config_hash'
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
    mcp_installations: [
      'target_kind',
      'target_id',
      'catalog_entry_id',
      'server_name',
      'display_name',
      'version',
      'enabled',
      'runtime',
      'configuration',
      'installed_at'
    ],
    node_schema_migrations: ['version', 'applied_at'],
    runner_defaults: ['runner', 'model', 'effort', 'access'],
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
    ],
    workspaces: [
      'id',
      'path',
      'kind',
      'git_summary',
      'created_at',
      'updated_at',
      'preserve_git_config'
    ]
  };
  for (const [table, expected] of Object.entries(required)) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as { name?: unknown }[];
    if (expected.some((name) => !columns.some((column) => column.name === name)))
      throw new Error(`NODE_DATABASE_SCHEMA_INVALID:${table}`);
  }
  for (const name of [
    'conversation_files_conversation_updated',
    'conversation_template_publish_jobs_status',
    'conversation_template_publish_jobs_template',
    'conversation_template_versions_template_status',
    'hosted_conversations_template',
    'hosted_conversations_user_pin_activity'
  ]) {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name))
      throw new Error(`NODE_DATABASE_SCHEMA_INVALID:${name}`);
  }
  const workspace = database
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='workspaces'")
    .get() as { sql?: unknown } | undefined;
  if (
    typeof workspace?.sql !== 'string' ||
    !workspace.sql.includes('preserve_git_config INTEGER NOT NULL DEFAULT 1')
  )
    throw new Error('NODE_DATABASE_SCHEMA_INVALID:workspaces');
  for (const name of ['agent_sessions', 'runner_defaults']) {
    const row = database
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) as { sql?: unknown } | undefined;
    const definition = row?.sql;
    if (
      typeof definition !== 'string' ||
      !["'mar-agent'", "'codex'", "'claude-code'", "'opencode'"].every((runner) =>
        definition.includes(runner)
      )
    )
      throw new Error(`NODE_DATABASE_SCHEMA_INVALID:${name}:runner`);
  }
  if (database.prepare('PRAGMA foreign_key_check').all().length !== 0)
    throw new Error('NODE_DATABASE_SCHEMA_INVALID:foreign_keys');
  if (exactBaseline) {
    // Only compare whole DDL at v13; later additive migrations may extend these tables.
    const reference = new DatabaseSync(':memory:');
    try {
      reference.exec(NODE_SCHEMA_V13);
      const query =
        "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name";
      const expected = reference.prepare(query).all() as {
        type: string;
        name: string;
        sql: string;
      }[];
      const actual = database.prepare(query).all() as { type: string; name: string; sql: string }[];
      if (
        actual.length !== expected.length ||
        expected.some(
          (entry, index) =>
            actual[index]?.type !== entry.type ||
            actual[index]?.name !== entry.name ||
            actual[index]?.sql !== entry.sql
        )
      )
        throw new Error('NODE_DATABASE_SCHEMA_INVALID:baseline');
    } finally {
      reference.close();
    }
  }
}
