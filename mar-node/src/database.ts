import { NODE_SCHEMA_MIGRATION_V17 } from './migrations/v017.js';
import { NODE_SCHEMA_MIGRATION_V18 } from './migrations/v018.js';
import { NODE_SCHEMA_MIGRATION_V19 } from './migrations/v019.js';
import { NODE_SCHEMA_MIGRATION_V20 } from './migrations/v020.js';
import { NODE_SCHEMA_MIGRATION_V21 } from './migrations/v021.js';
import { normalizeSessionPrompt } from './runner/personal-instructions.js';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  runnerDefaultConfigurationSchema,
  type RunnerDefaultConfiguration,
  type RunnerName
} from '@myagentroam/protocol';
import {
  mcpCatalogEntrySchema,
  mcpInstallationConfigurationSchema,
  mcpRuntimeDescriptorSchema,
  type McpCatalogEntry
} from '@myagentroam/protocol';
import {
  assertNodeSchemaV13,
  NODE_SCHEMA_V13,
  NODE_SCHEMA_VERSION_V13
} from './migrations/v013.js';
import type { NodeSchemaMigration } from './migrations/types.js';
import { NODE_SCHEMA_MIGRATION_V14 } from './migrations/v014.js';
import { NODE_SCHEMA_MIGRATION_V15 } from './migrations/v015.js';
import { NODE_SCHEMA_MIGRATION_V16 } from './migrations/v016.js';
import { ScheduledSessionStore } from './service/scheduled-session-store.js';
import { assertNodeNoForeignKeys, assertNodeRelations } from './database-relations.js';
import type { NodeMcpInstallation } from './mcp/model.js';

type SqlRow = Record<string, string | number | bigint | Uint8Array | null>;
// Future released migrations must be contiguous, immutable and begin at v14; Demo is excluded.
export const NODE_SCHEMA_MIGRATIONS: readonly NodeSchemaMigration[] = [
  NODE_SCHEMA_MIGRATION_V14,
  NODE_SCHEMA_MIGRATION_V15,
  NODE_SCHEMA_MIGRATION_V16,
  NODE_SCHEMA_MIGRATION_V17,
  NODE_SCHEMA_MIGRATION_V18,
  NODE_SCHEMA_MIGRATION_V19,
  NODE_SCHEMA_MIGRATION_V20,
  NODE_SCHEMA_MIGRATION_V21
];
const LEGACY_NODE_SCHEMA_V12 = NODE_SCHEMA_VERSION_V13 - 1;
const OBSOLETE_NODE_SCHEMA_V16 = 16;

import type { NodeWorkspace, WorkspaceSettings } from './workspace/contracts.js';
import type {
  NativeSessionControl,
  NodeAgentSession,
  NativeSessionMetadata
} from './session/contracts.js';
export type { NodeWorkspace, WorkspaceSettings } from './workspace/contracts.js';
export type {
  NativeSessionControl,
  NodeAgentSession,
  NativeSessionMetadata
} from './session/contracts.js';

export interface NodeSettings {
  readonly runnerDefaults?: Partial<
    Record<RunnerDefaultConfiguration['runner'], Omit<RunnerDefaultConfiguration, 'runner'>>
  >;
}

/** Terminal output and input are deliberately never part of this projection. */
export interface NodeTerminalSession {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly profileId: string;
  readonly state: 'RUNNING' | 'EXITED' | 'CLOSED';
  readonly exitCode: number | null;
  readonly rows: number;
  readonly cols: number;
  readonly latestSequence: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export class NodeDatabase {
  readonly raw: DatabaseSync;

  constructor(
    path: string,
    _nodeId: string | (() => string),
    private readonly now: () => number = Date.now
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const releaseMigrationLock = acquireNodeMigrationLock(path);
    try {
      this.raw = new DatabaseSync(path, {
        enableForeignKeyConstraints: false,
        timeout: 5_000,
        defensive: true
      });
      try {
        // Refuse unsupported databases before changing the on-disk journal mode.
        migrate(this.raw);
        this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
      } catch (error) {
        this.raw.close();
        throw error;
      }
    } finally {
      releaseMigrationLock();
    }
  }

  private write<T>(action: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.raw.close();
  }

  getRunnerDefaults(): readonly RunnerDefaultConfiguration[] {
    return Object.entries(this.getNodeSettings().runnerDefaults ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([runner, settings]) => {
        const parsed = runnerDefaultConfigurationSchema.safeParse({ runner, ...settings });
        return parsed.success ? [parsed.data] : [];
      });
  }

  getNodeSettings(): NodeSettings {
    const row = this.raw.prepare('SELECT settings FROM node_settings WHERE id = 1').get() as SqlRow;
    return JSON.parse(stringValue(row, 'settings')) as NodeSettings;
  }

  saveRunnerDefaults(input: RunnerDefaultConfiguration): RunnerDefaultConfiguration {
    const { runner, ...settings } = runnerDefaultConfigurationSchema.parse(input);
    this.raw
      .prepare(`UPDATE node_settings SET settings = json_patch(settings, ?) WHERE id = 1`)
      .run(JSON.stringify({ runnerDefaults: { [runner]: settings } }));
    return input;
  }

  listMcpInstallations(
    targetKind: 'NODE' | 'WORKSPACE',
    targetId = ''
  ): readonly NodeMcpInstallation[] {
    const rows = this.raw
      .prepare(
        `SELECT target_kind,target_id,catalog_entry_id,server_name,display_name,version,
                enabled,runtime,configuration,installed_at
         FROM mcp_installations WHERE target_kind=? AND target_id=? ORDER BY display_name,server_name`
      )
      .all(targetKind, targetKind === 'NODE' ? '' : targetId) as readonly SqlRow[];
    return rows.map(mcpInstallation);
  }

  saveMcpInstallation(input: {
    readonly targetKind: 'NODE' | 'WORKSPACE';
    readonly targetId?: string;
    readonly entry: McpCatalogEntry;
    readonly enabled: boolean;
    readonly configuration: NodeMcpInstallation['configuration'];
  }): NodeMcpInstallation {
    return this.write(() => {
      const entry = mcpCatalogEntrySchema.parse(input.entry);
      const configuration = mcpInstallationConfigurationSchema.parse(input.configuration);
      const targetId = input.targetKind === 'NODE' ? '' : (input.targetId ?? '');
      if (input.targetKind === 'WORKSPACE' && this.getWorkspace(targetId) === undefined)
        throw new Error('WORKSPACE_NOT_FOUND');
      const installedAt = this.now();
      this.raw
        .prepare(
          `INSERT INTO mcp_installations
           (target_kind,target_id,catalog_entry_id,server_name,display_name,version,enabled,runtime,configuration,installed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(target_kind,target_id,server_name) DO UPDATE SET
             catalog_entry_id=excluded.catalog_entry_id,display_name=excluded.display_name,
             version=excluded.version,enabled=excluded.enabled,runtime=excluded.runtime,
             configuration=excluded.configuration,installed_at=excluded.installed_at`
        )
        .run(
          input.targetKind,
          targetId,
          entry.id,
          entry.serverName,
          entry.displayName,
          entry.version,
          input.enabled ? 1 : 0,
          JSON.stringify(entry.runtime),
          JSON.stringify(configuration),
          installedAt
        );
      return {
        targetKind: input.targetKind,
        targetId,
        catalogEntryId: entry.id,
        serverName: entry.serverName,
        displayName: entry.displayName,
        version: entry.version,
        enabled: input.enabled,
        runtime: entry.runtime,
        configuration,
        installedAt
      };
    });
  }

  removeMcpInstallation(
    targetKind: 'NODE' | 'WORKSPACE',
    targetId: string,
    serverName: string
  ): boolean {
    return (
      Number(
        this.raw
          .prepare(
            'DELETE FROM mcp_installations WHERE target_kind=? AND target_id=? AND server_name=?'
          )
          .run(targetKind, targetKind === 'NODE' ? '' : targetId, serverName).changes
      ) > 0
    );
  }

  effectiveMcpInstallations(workspaceId: string): readonly NodeMcpInstallation[] {
    const effective = new Map(
      this.listMcpInstallations('NODE').map((installation) => [
        installation.serverName,
        installation
      ])
    );
    for (const installation of this.listMcpInstallations('WORKSPACE', workspaceId))
      effective.set(installation.serverName, installation);
    return [...effective.values()].filter((installation) => installation.enabled);
  }

  /**
   * Stores only terminal lifecycle metadata. PTY input/output must remain in
   * the Node-local bounded replay buffer and must never be passed here.
   */
  saveTerminalSession(input: NodeTerminalSession): NodeTerminalSession {
    return this.write(() => {
      if (input.workspaceId !== null && this.getWorkspace(input.workspaceId) === undefined)
        throw new Error('WORKSPACE_NOT_FOUND');
      this.raw
        .prepare(
          `INSERT INTO terminal_sessions
            (id, workspace_id, profile_id, state, exit_code, rows, cols, latest_sequence, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, profile_id = excluded.profile_id, state = excluded.state,
             exit_code = excluded.exit_code, rows = excluded.rows, cols = excluded.cols,
             latest_sequence = excluded.latest_sequence, updated_at = excluded.updated_at`
        )
        .run(
          input.id,
          input.workspaceId,
          input.profileId,
          input.state,
          input.exitCode,
          input.rows,
          input.cols,
          input.latestSequence,
          input.createdAt,
          input.updatedAt
        );
      return this.getTerminalSession(input.id) as NodeTerminalSession;
    });
  }

  getTerminalSession(id: string): NodeTerminalSession | undefined {
    const row = this.raw
      .prepare(
        `SELECT id, workspace_id, profile_id, state, exit_code, rows, cols, latest_sequence, created_at, updated_at
         FROM terminal_sessions WHERE id = ?`
      )
      .get(id) as SqlRow | undefined;
    return row === undefined ? undefined : terminalSession(row);
  }

  listTerminalSessions(): readonly NodeTerminalSession[] {
    return this.raw
      .prepare(
        `SELECT id, workspace_id, profile_id, state, exit_code, rows, cols, latest_sequence, created_at, updated_at
         FROM terminal_sessions WHERE state = 'RUNNING' ORDER BY created_at ASC, id ASC`
      )
      .all()
      .map((row) => terminalSession(row as SqlRow));
  }

  /** A restart cannot safely reattach an orphaned PTY, so record it as closed. */
  closeRunningTerminalSessions(): void {
    this.raw
      .prepare(
        "UPDATE terminal_sessions SET state = 'CLOSED', updated_at = ? WHERE state = 'RUNNING'"
      )
      .run(this.now());
  }

  saveWorkspace(
    input: Omit<NodeWorkspace, 'id' | 'settings'> & { readonly id?: string }
  ): NodeWorkspace {
    const current = this.raw
      .prepare('SELECT id, settings FROM workspaces WHERE path = ?')
      .get(input.path) as SqlRow | undefined;
    const settings: WorkspaceSettings =
      current === undefined
        ? {
            git: {
              preserveGitConfig: input.preserveGitConfig ?? false,
              includeParentRepository: input.includeParentRepository ?? true
            }
          }
        : (JSON.parse(stringValue(current, 'settings')) as WorkspaceSettings);
    const workspace: NodeWorkspace = {
      id: current === undefined ? (input.id ?? randomUUID()) : stringValue(current, 'id'),
      path: input.path,
      kind: input.kind,
      gitSummary: input.gitSummary,
      settings,
      includeParentRepository: settings.git?.includeParentRepository ?? true,
      preserveGitConfig: settings.git?.preserveGitConfig ?? false
    };
    const timestamp = this.now();
    this.raw
      .prepare(
        `INSERT INTO workspaces (id, path, kind, git_summary, created_at, updated_at, settings)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET kind = excluded.kind,
           git_summary = excluded.git_summary, updated_at = excluded.updated_at`
      )
      .run(
        workspace.id,
        workspace.path,
        workspace.kind,
        workspace.gitSummary === null ? null : JSON.stringify(workspace.gitSummary),
        timestamp,
        timestamp,
        JSON.stringify(settings)
      );
    return workspace;
  }

  listWorkspaces(): readonly NodeWorkspace[] {
    return this.raw
      .prepare(
        'SELECT id, path, kind, git_summary, settings FROM workspaces ORDER BY created_at ASC'
      )
      .all()
      .map((row) => workspace(row as SqlRow));
  }

  getWorkspace(id: string): NodeWorkspace | undefined {
    const row = this.raw
      .prepare('SELECT id, path, kind, git_summary, settings FROM workspaces WHERE id = ?')
      .get(id) as SqlRow | undefined;
    return row === undefined ? undefined : workspace(row);
  }

  getWorkspaceByPath(path: string): NodeWorkspace | undefined {
    const row = this.raw
      .prepare('SELECT id, path, kind, git_summary, settings FROM workspaces WHERE path = ?')
      .get(path) as SqlRow | undefined;
    return row === undefined ? undefined : workspace(row);
  }

  /** Updates only supplied policy fields without replacing Workspace metadata. */
  setWorkspaceGitPolicy(
    id: string,
    preserveGitConfig: boolean,
    includeParentRepository?: boolean
  ): NodeWorkspace {
    if (this.getWorkspace(id) === undefined) throw new Error('WORKSPACE_NOT_FOUND');
    this.raw
      .prepare('UPDATE workspaces SET settings=json_patch(settings, ?), updated_at=? WHERE id=?')
      .run(
        JSON.stringify({
          git: {
            preserveGitConfig,
            ...(includeParentRepository === undefined ? {} : { includeParentRepository })
          }
        }),
        this.now(),
        id
      );
    return this.getWorkspace(id)!;
  }

  /** Unregisters a Workspace registration without deleting its local directory. */
  removeWorkspace(id: string): NodeWorkspace {
    const current = this.getWorkspace(id);
    if (current === undefined) throw new Error('WORKSPACE_NOT_FOUND');
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      new ScheduledSessionStore(this.raw).removeForWorkspace(id);
      this.raw.prepare('DELETE FROM agent_sessions WHERE workspace_id = ?').run(id);
      this.raw
        .prepare("DELETE FROM mcp_installations WHERE target_kind='WORKSPACE' AND target_id = ?")
        .run(id);
      this.raw
        .prepare('UPDATE terminal_sessions SET workspace_id=NULL WHERE workspace_id=?')
        .run(id);
      this.raw.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
      this.raw.exec('COMMIT');
      return current;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  getNativeSessionMetadata(
    runner: RunnerName,
    externalSessionId: string,
    workspaceId: string
  ): NativeSessionMetadata | undefined {
    const row = this.raw
      .prepare(
        'SELECT pin_order, metadata FROM agent_sessions WHERE id = ? AND runner = ? AND workspace_id = ?'
      )
      .get(externalSessionId, runner, workspaceId) as SqlRow | undefined;
    if (row === undefined) return undefined;
    return {
      ...sessionMetadata(row),
      pinnedAt: row['pin_order'] === null ? null : 1,
      pinOrder: nullableNumber(row, 'pin_order')
    };
  }

  clearSessionParent(runner: RunnerName, externalSessionId: string, workspaceId: string): void {
    const result = this.raw
      .prepare(
        "UPDATE agent_sessions SET metadata = json_set(metadata, '$.parentSessionId', NULL) WHERE id = ? AND runner = ? AND workspace_id = ?"
      )
      .run(externalSessionId, runner, workspaceId);
    if (result.changes !== 1) throw new Error('SESSION_NOT_FOUND');
  }

  saveNativeSessionMetadata(input: {
    readonly parentSessionId?: string | null;
    // Only for the initial promotion of a newly created Session, never for a resume.
    readonly initializeParent?: boolean;
    readonly runner: RunnerName;
    readonly externalSessionId: string;
    readonly workspaceId: string;
    readonly customTitle?: string | null;
    readonly sessionPrompt?: string | null;
    readonly runnerTitle?: string | null;
    readonly runnerTitlePending?: boolean;
    readonly pinned?: boolean;
    readonly model?: string | null;
    readonly effort?: string | null;
    readonly access?: string | null;
  }): NativeSessionMetadata {
    const current = this.getNativeSessionMetadata(
      input.runner,
      input.externalSessionId,
      input.workspaceId
    );
    const customTitle =
      input.customTitle === undefined
        ? (current?.customTitle ?? null)
        : input.customTitle?.trim() || null;
    const runnerTitle =
      input.runnerTitle === undefined
        ? (current?.runnerTitle ?? null)
        : input.runnerTitle?.trim() || null;
    const sessionPrompt =
      input.sessionPrompt === undefined
        ? (current?.sessionPrompt ?? null)
        : normalizeSessionPrompt(input.sessionPrompt);
    const runnerTitlePending =
      input.runnerTitlePending === undefined
        ? (current?.runnerTitlePending ?? false)
        : input.runnerTitlePending;
    if (customTitle !== null && customTitle.length > 160) throw new Error('SESSION_TITLE_INVALID');
    if (runnerTitle !== null && runnerTitle.length > 160) throw new Error('SESSION_TITLE_INVALID');
    let pinOrder = current?.pinOrder ?? null;
    const pinAtTop = input.pinned === true && pinOrder === null;
    if (pinAtTop) pinOrder = 0;
    else if (input.pinned === false) pinOrder = null;
    const model = input.model === undefined ? (current?.model ?? null) : input.model;
    const effort = input.effort === undefined ? (current?.effort ?? null) : input.effort;
    const access = input.access === undefined ? (current?.access ?? null) : input.access;
    const parentSessionId =
      current === undefined || input.initializeParent === true
        ? (current?.parentSessionId ?? input.parentSessionId ?? null)
        : (current.parentSessionId ?? null);
    const metadata = JSON.stringify({
      version: 1,
      parentSessionId,
      customTitle,
      sessionPrompt,
      runnerTitle,
      runnerTitlePending,
      model,
      effort,
      access
    });
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      if (this.getWorkspace(input.workspaceId) === undefined)
        throw new Error('WORKSPACE_NOT_FOUND');
      const scheduled = this.raw
        .prepare('SELECT workspace_id,runner FROM scheduled_session_tasks WHERE session_id=?')
        .get(input.externalSessionId);
      if (
        scheduled !== undefined &&
        (scheduled['workspace_id'] !== input.workspaceId || scheduled['runner'] !== input.runner)
      )
        throw Object.assign(new Error('SCHEDULE_SESSION_MISMATCH'), {
          publicMessage: "The scheduled task must use its session's Workspace and Runner."
        });
      if (pinAtTop)
        this.raw
          .prepare(
            'UPDATE agent_sessions SET pin_order = pin_order + 1 WHERE workspace_id = ? AND pin_order IS NOT NULL'
          )
          .run(input.workspaceId);
      this.raw
        .prepare(
          `INSERT INTO agent_sessions (id, workspace_id, runner, pin_order, metadata)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id,
             runner = excluded.runner, pin_order = excluded.pin_order, metadata = excluded.metadata`
        )
        .run(input.externalSessionId, input.workspaceId, input.runner, pinOrder, metadata);
      this.raw.exec('COMMIT');
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
    return {
      customTitle,
      parentSessionId,
      sessionPrompt,
      runnerTitle,
      runnerTitlePending,
      pinnedAt: pinOrder === null ? null : 1,
      pinOrder,
      model,
      effort,
      access
    };
  }

  listSessionRecords(workspaceId: string): readonly {
    readonly id: string;
    readonly workspaceId: string;
    readonly runner: RunnerName;
    readonly pinOrder: number | null;
    readonly metadata: NativeSessionMetadata;
  }[] {
    return (
      this.raw
        .prepare(
          'SELECT id, workspace_id, runner, pin_order, metadata FROM agent_sessions WHERE workspace_id = ? ORDER BY pin_order IS NULL, pin_order, id'
        )
        .all(workspaceId) as readonly SqlRow[]
    ).map(sessionRecord);
  }

  getSessionRecord(
    sessionId: string
  ): ReturnType<NodeDatabase['listSessionRecords']>[number] | undefined {
    const row = this.raw
      .prepare(
        'SELECT id, workspace_id, runner, pin_order, metadata FROM agent_sessions WHERE id = ?'
      )
      .get(sessionId) as SqlRow | undefined;
    return row === undefined ? undefined : sessionRecord(row);
  }

  movePinnedSession(
    sessionId: string,
    direction: 'up' | 'down',
    target?: { sessionId: string; position: 'before' | 'after' }
  ): string {
    const current = this.raw
      .prepare('SELECT workspace_id, pin_order FROM agent_sessions WHERE id = ?')
      .get(sessionId) as SqlRow | undefined;
    if (current === undefined || current['pin_order'] === null)
      throw new Error('SESSION_NOT_PINNED');
    const order = numberValue(current, 'pin_order');
    const workspaceId = stringValue(current, 'workspace_id');
    const destination =
      target === undefined
        ? (this.raw
            .prepare(
              direction === 'up'
                ? 'SELECT id, pin_order FROM agent_sessions WHERE workspace_id = ? AND pin_order < ? ORDER BY pin_order DESC LIMIT 1'
                : 'SELECT id, pin_order FROM agent_sessions WHERE workspace_id = ? AND pin_order > ? ORDER BY pin_order ASC LIMIT 1'
            )
            .get(workspaceId, order) as SqlRow | undefined)
        : (this.raw
            .prepare(
              'SELECT id, pin_order FROM agent_sessions WHERE workspace_id = ? AND id = ? AND pin_order IS NOT NULL'
            )
            .get(workspaceId, target.sessionId) as SqlRow | undefined);
    if (target !== undefined && destination === undefined)
      throw new Error('SESSION_PIN_MOVE_INVALID');
    if (destination === undefined) return workspaceId;
    const targetOrder = numberValue(destination, 'pin_order');
    if (targetOrder === order) return workspaceId;
    const excludedTargetId =
      target !== undefined &&
      ((targetOrder > order && target.position === 'before') ||
        (targetOrder < order && target.position === 'after'))
        ? target.sessionId
        : null;
    const displaced = this.raw
      .prepare(
        `SELECT id, pin_order FROM agent_sessions WHERE workspace_id = ? AND pin_order BETWEEN ? AND ? AND id != ? AND (? IS NULL OR id != ?) ORDER BY pin_order ${targetOrder < order ? 'DESC' : 'ASC'}`
      )
      .all(
        workspaceId,
        Math.min(order, targetOrder),
        Math.max(order, targetOrder),
        sessionId,
        excludedTargetId,
        excludedTargetId
      ) as SqlRow[];
    if (displaced.length === 0) return workspaceId;
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const update = this.raw.prepare('UPDATE agent_sessions SET pin_order = ? WHERE id = ?');
      let nextOrder = order;
      for (const row of displaced) {
        update.run(nextOrder, stringValue(row, 'id'));
        nextOrder = numberValue(row, 'pin_order');
      }
      update.run(nextOrder, sessionId);
      this.raw.exec('COMMIT');
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
    return workspaceId;
  }

  deleteSessionRecord(sessionId: string): boolean {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      new ScheduledSessionStore(this.raw).removeForSession(sessionId);
      const removed =
        Number(this.raw.prepare('DELETE FROM agent_sessions WHERE id = ?').run(sessionId).changes) >
        0;
      this.raw.exec('COMMIT');
      return removed;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }
}

export function migrate(
  database: DatabaseSync,
  catalog: readonly NodeSchemaMigration[] = NODE_SCHEMA_MIGRATIONS
): void {
  if (catalog.some((entry, index) => entry.version !== NODE_SCHEMA_VERSION_V13 + index + 1))
    throw new Error('NODE_DATABASE_MIGRATION_CATALOG_INVALID');
  const latest = NODE_SCHEMA_VERSION_V13 + catalog.length;
  const existingMigrationTable = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'node_schema_migrations'")
    .get();
  if (existingMigrationTable === undefined) {
    const existingApplicationTable = database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1"
      )
      .get();
    if (existingApplicationTable !== undefined)
      throw new Error('NODE_DATABASE_VERSION_UNSUPPORTED');
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(NODE_SCHEMA_V13);
      database
        .prepare('INSERT INTO node_schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(NODE_SCHEMA_VERSION_V13, Date.now());
      assertNodeSchemaV13(database);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  const versions = (
    database
      .prepare('SELECT version FROM node_schema_migrations ORDER BY version')
      .all() as readonly SqlRow[]
  ).map((row) => numberValue(row, 'version'));
  const firstLegacyVersion = versions[0];
  if (
    firstLegacyVersion !== undefined &&
    firstLegacyVersion >= 1 &&
    firstLegacyVersion <= 4 &&
    versions.length === LEGACY_NODE_SCHEMA_V12 - firstLegacyVersion + 1 &&
    versions.every((version, index) => version === firstLegacyVersion + index)
  ) {
    // v13 is a history-compaction baseline. The final v12 schema is still the v13 schema;
    // validate it before atomically replacing only the migration ledger.
    assertNodeSchemaV13(database);
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('DELETE FROM node_schema_migrations').run();
      database
        .prepare('INSERT INTO node_schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(NODE_SCHEMA_VERSION_V13, Date.now());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  const migratedVersions = (
    database
      .prepare('SELECT version FROM node_schema_migrations ORDER BY version')
      .all() as readonly SqlRow[]
  ).map((row) => numberValue(row, 'version'));
  if (
    latest >= NODE_SCHEMA_MIGRATION_V15.version &&
    migratedVersions.length === 4 &&
    migratedVersions.every((version, index) => version === NODE_SCHEMA_VERSION_V13 + index) &&
    migratedVersions.at(-1) === OBSOLETE_NODE_SCHEMA_V16 &&
    (
      database.prepare('PRAGMA table_info(scheduled_session_tasks)').all() as { name: string }[]
    ).some((column) => column.name === 'notify_user_id') &&
    database.prepare('PRAGMA foreign_key_list(scheduled_session_tasks)').all().length !== 0
  ) {
    downgradeLegacyRecipientSchema(database);
    migratedVersions.pop();
  }
  const current = migratedVersions.at(-1);
  if (
    current === undefined ||
    current < NODE_SCHEMA_VERSION_V13 ||
    current > latest ||
    migratedVersions[0] !== NODE_SCHEMA_VERSION_V13
  )
    throw new Error('NODE_DATABASE_VERSION_UNSUPPORTED');
  if (migratedVersions.some((version, index) => version !== NODE_SCHEMA_VERSION_V13 + index))
    throw new Error('NODE_DATABASE_MIGRATION_HISTORY_INVALID');
  if (current < NODE_SCHEMA_MIGRATION_V21.version) assertNodeSchemaV13(database);
  else catalog[current - NODE_SCHEMA_VERSION_V13 - 1]!.assert(database);
  for (const entry of catalog) {
    if (entry.version <= current) continue;
    const foreignKeys = database.prepare('PRAGMA foreign_keys').get()?.['foreign_keys'];
    if (entry.rebuildTables) database.exec('PRAGMA foreign_keys=OFF');
    database.exec('BEGIN IMMEDIATE');
    try {
      entry.preflight?.(database);
      database.exec(entry.sql);
      entry.assert(database);
      if (entry.version >= NODE_SCHEMA_MIGRATION_V16.version) {
        assertNodeNoForeignKeys(database);
        assertNodeRelations(database);
      }
      database
        .prepare('INSERT INTO node_schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(entry.version, Date.now());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    } finally {
      if (entry.rebuildTables && foreignKeys === 1) database.exec('PRAGMA foreign_keys=ON');
    }
  }
  if (catalog.length > 0) catalog[catalog.length - 1]!.assert(database);
  if (latest >= NODE_SCHEMA_MIGRATION_V16.version) {
    assertNodeNoForeignKeys(database);
    assertNodeRelations(database);
  }
}

function downgradeLegacyRecipientSchema(database: DatabaseSync): void {
  const reference = new DatabaseSync(':memory:');
  try {
    migrate(reference, [NODE_SCHEMA_MIGRATION_V14]);
    reference.exec(
      `ALTER TABLE scheduled_session_tasks
       ADD COLUMN notify_user_id INTEGER NOT NULL DEFAULT 1 CHECK (notify_user_id > 0);
       ${NODE_SCHEMA_MIGRATION_V15.sql}`
    );
    const definitions = (source: DatabaseSync): Map<string, string> =>
      new Map(
        source
          .prepare(
            'SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name'
          )
          .all()
          .map((row) => {
            const type = row['type'];
            const name = row['name'];
            const sql = row['sql'];
            if (typeof type !== 'string' || typeof name !== 'string' || typeof sql !== 'string')
              throw new Error('NODE_DATABASE_VERSION_UNSUPPORTED');
            return [`${type}:${name}`, sql.replace(/\s+/gu, ' ').trim()] as const;
          })
      );
    const expected = definitions(reference);
    const actual = definitions(database);
    if (
      expected.size !== actual.size ||
      [...expected].some(([name, sql]) => actual.get(name) !== sql)
    )
      throw new Error('NODE_DATABASE_VERSION_UNSUPPORTED');
  } finally {
    reference.close();
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    if (database.prepare('SELECT 1 FROM scheduled_session_tasks LIMIT 1').get() !== undefined)
      throw new Error('NODE_DATABASE_DOWNGRADE_UNSAFE');
    database.exec('ALTER TABLE scheduled_session_tasks DROP COLUMN notify_user_id');
    NODE_SCHEMA_MIGRATION_V15.assert(database);
    database
      .prepare('DELETE FROM node_schema_migrations WHERE version=?')
      .run(OBSOLETE_NODE_SCHEMA_V16);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function mcpInstallation(row: SqlRow): NodeMcpInstallation {
  const runtime = mcpRuntimeDescriptorSchema.parse(JSON.parse(stringValue(row, 'runtime')));
  const configuration = mcpInstallationConfigurationSchema.parse(
    JSON.parse(stringValue(row, 'configuration'))
  );
  return {
    targetKind: stringValue(row, 'target_kind') as NodeMcpInstallation['targetKind'],
    targetId: stringValue(row, 'target_id'),
    catalogEntryId: stringValue(row, 'catalog_entry_id'),
    serverName: stringValue(row, 'server_name'),
    displayName: stringValue(row, 'display_name'),
    version: stringValue(row, 'version'),
    enabled: numberValue(row, 'enabled') === 1,
    runtime,
    configuration,
    installedAt: numberValue(row, 'installed_at')
  };
}

function sessionRecord(row: SqlRow) {
  return {
    id: stringValue(row, 'id'),
    workspaceId: stringValue(row, 'workspace_id'),
    runner: stringValue(row, 'runner') as RunnerName,
    pinOrder: nullableNumber(row, 'pin_order'),
    metadata: {
      ...sessionMetadata(row),
      pinnedAt: row['pin_order'] === null ? null : 1,
      pinOrder: nullableNumber(row, 'pin_order')
    }
  };
}

function sessionMetadata(row: SqlRow): Omit<NativeSessionMetadata, 'pinnedAt' | 'pinOrder'> {
  const raw = JSON.parse(stringValue(row, 'metadata')) as Record<string, unknown>;
  if (raw['version'] !== 1) throw new Error('SESSION_METADATA_VERSION_UNSUPPORTED');
  const value = (key: string): string | null =>
    typeof raw[key] === 'string' ? (raw[key] as string) : null;
  return {
    customTitle: value('customTitle'),
    parentSessionId: value('parentSessionId'),
    sessionPrompt: value('sessionPrompt'),
    runnerTitle: value('runnerTitle'),
    runnerTitlePending: raw['runnerTitlePending'] === true,
    model: value('model'),
    effort: value('effort'),
    access: value('access')
  };
}

function acquireNodeMigrationLock(databasePath: string): () => void {
  if (databasePath === ':memory:') return () => undefined;
  const lockPath = `${databasePath}.migration.lock`;
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600);
      return () => {
        closeSync(descriptor);
        if (existsSync(lockPath)) rmSync(lockPath);
      };
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'EEXIST' || Date.now() >= deadline)
        throw new Error('NODE_DATABASE_MIGRATION_LOCK_UNAVAILABLE');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function workspace(row: SqlRow): NodeWorkspace {
  const summary = nullableString(row, 'git_summary');
  const settings = JSON.parse(stringValue(row, 'settings')) as WorkspaceSettings;
  return {
    id: stringValue(row, 'id'),
    settings,
    preserveGitConfig: settings.git?.preserveGitConfig ?? false,
    includeParentRepository: settings.git?.includeParentRepository ?? true,
    path: stringValue(row, 'path'),
    kind: stringValue(row, 'kind') as NodeWorkspace['kind'],
    gitSummary: summary === null ? null : (JSON.parse(summary) as unknown)
  };
}

function terminalSession(row: SqlRow): NodeTerminalSession {
  const state = stringValue(row, 'state');
  if (state !== 'RUNNING' && state !== 'EXITED' && state !== 'CLOSED')
    throw new Error('DATABASE_VALUE_INVALID:terminal_state');
  return {
    id: stringValue(row, 'id'),
    workspaceId: nullableString(row, 'workspace_id'),
    profileId: stringValue(row, 'profile_id'),
    state,
    exitCode: nullableNumber(row, 'exit_code'),
    rows: numberValue(row, 'rows'),
    cols: numberValue(row, 'cols'),
    latestSequence: numberValue(row, 'latest_sequence'),
    createdAt: numberValue(row, 'created_at'),
    updatedAt: numberValue(row, 'updated_at')
  };
}

function stringValue(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`DATABASE_VALUE_INVALID:${key}`);
  return value;
}
function nullableString(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null || typeof value === 'string') return value;
  throw new Error(`DATABASE_VALUE_INVALID:${key}`);
}
function nullableNumber(row: SqlRow, key: string): number | null {
  const value = row[key];
  if (value === null || typeof value === 'number') return value;
  throw new Error(`DATABASE_VALUE_INVALID:${key}`);
}
function numberValue(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== 'number') throw new Error(`DATABASE_VALUE_INVALID:${key}`);
  return value;
}
