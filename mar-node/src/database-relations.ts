import type { DatabaseSync } from 'node:sqlite';

export function assertNodeNoForeignKeys(database: DatabaseSync): void {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const { name } of tables) {
    if (
      database.prepare('SELECT 1 FROM pragma_foreign_key_list(?) LIMIT 1').get(name) !== undefined
    )
      throw new Error(`NODE_DATABASE_SCHEMA_INVALID:foreign_keys:${name}`);
  }
}

/** Validate persisted Node associations independently of physical foreign keys. */
export function assertNodeRelations(database: DatabaseSync): void {
  const checks: Readonly<Record<string, string>> = {
    agent_sessions: `SELECT 1 FROM agent_sessions child LEFT JOIN workspaces parent
      ON parent.id=child.workspace_id WHERE parent.id IS NULL LIMIT 1`,
    terminal_sessions: `SELECT 1 FROM terminal_sessions child LEFT JOIN workspaces parent
      ON parent.id=child.workspace_id WHERE child.workspace_id IS NOT NULL AND parent.id IS NULL LIMIT 1`,
    conversation_files: `SELECT 1 FROM conversation_files child LEFT JOIN hosted_conversations parent
      ON parent.id=child.conversation_id WHERE parent.id IS NULL LIMIT 1`,
    hosted_conversation_messages: `SELECT 1 FROM hosted_conversation_messages child LEFT JOIN hosted_conversations parent
      ON parent.id=child.conversation_id WHERE parent.id IS NULL LIMIT 1`,
    hosted_conversations: `SELECT 1 FROM hosted_conversations child LEFT JOIN conversation_template_versions parent
      ON parent.id=child.active_version_id WHERE parent.id IS NULL OR parent.template_id<>child.template_id LIMIT 1`,
    conversation_template_publish_jobs: `SELECT 1 FROM conversation_template_publish_jobs child LEFT JOIN conversation_template_versions parent
      ON parent.id=child.version_id WHERE child.version_id IS NOT NULL
      AND (parent.id IS NULL OR parent.template_id<>child.template_id) LIMIT 1`,
    scheduled_session_tasks: `SELECT 1 FROM scheduled_session_tasks child
      LEFT JOIN agent_sessions session ON session.id=child.session_id
      LEFT JOIN workspaces workspace ON workspace.id=child.workspace_id
      WHERE session.id IS NULL OR workspace.id IS NULL OR session.workspace_id<>child.workspace_id
      OR session.runner<>child.runner LIMIT 1`,
    scheduled_session_occurrences: `SELECT 1 FROM scheduled_session_occurrences child LEFT JOIN scheduled_session_tasks parent
      ON parent.id=child.task_id WHERE parent.id IS NULL LIMIT 1`,
    scheduled_session_proposals: `SELECT 1 FROM scheduled_session_proposals child LEFT JOIN scheduled_session_tasks parent
      ON parent.id=child.task_id WHERE parent.id IS NULL LIMIT 1`,
    mcp_installations: `SELECT 1 FROM mcp_installations child LEFT JOIN workspaces parent
      ON parent.id=child.target_id WHERE child.target_kind='WORKSPACE' AND parent.id IS NULL LIMIT 1`
  };
  for (const [table, query] of Object.entries(checks)) {
    if (database.prepare(query).get() !== undefined)
      throw new Error(`NODE_DATABASE_SCHEMA_INVALID:relations:${table}`);
  }
}
