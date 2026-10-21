-- Empty Node SQLite v12 schema from common-v0.9.120 (no user data).
CREATE TABLE "agent_sessions" (
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
    );
