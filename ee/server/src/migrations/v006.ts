import type { DatabaseSync } from 'node:sqlite';
import { applyMigration } from './support.js';

export function up(database: DatabaseSync): void {
  applyMigration(
    database,
    6,
    String.raw`
DROP TABLE IF EXISTS run_snapshots; DROP TABLE IF EXISTS workspace_leases; DROP TABLE IF EXISTS approvals;
    DROP TABLE IF EXISTS run_events; DROP TABLE IF EXISTS agent_runs; DROP TABLE IF EXISTS session_messages;
    DROP TABLE IF EXISTS agent_sessions; DROP TABLE IF EXISTS runners; DROP TABLE IF EXISTS workspaces;
`
  );
}
