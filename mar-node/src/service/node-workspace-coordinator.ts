import type { NodeEnvelope } from '@myagentroam/protocol';
import { realpath } from 'node:fs/promises';
import { nodeLog } from '../operational.js';
import type { NodeConfig } from '../config.js';
import type { NodeAgentSession } from '../session/contracts.js';
import type { NodeWorkspace } from '../workspace/contracts.js';
import type { NodeDatabase, NodeTerminalSession } from '../database.js';
import type { TerminalSummary } from '../terminal.js';
import { inspectWorkspace, type WorkspaceInspection } from '../workspace/git.js';
import { normalizeWorkspacePath } from '../workspace/path-access.js';
import type { WorkspaceChangeService } from '../workspace/workspace-change-service.js';
import { ensureWorkspaceGitExclude } from '../workspace/workspace-git-exclude-service.js';
import type { WorkspaceSessionService } from '../workspace/workspace-session-service.js';
import type { WorkspaceWatchService } from '../workspace/workspace-watch-service.js';

interface NodeWorkspaceCoordinatorOptions {
  readonly config: () => NodeConfig | undefined;
  readonly database: () => NodeDatabase | undefined;
  readonly watches: WorkspaceWatchService;
  readonly sessions: WorkspaceSessionService;
  readonly changes: WorkspaceChangeService;
  readonly emit: (workspaceId: string, topic: 'files' | 'changes') => void;
  readonly send: (type: string, payload: unknown, replyTo?: string) => void;
}

/** Coordinates Workspace invalidation, inspection and persisted Terminal summaries. */
export class NodeWorkspaceCoordinator {
  constructor(private readonly options: NodeWorkspaceCoordinatorOptions) {}

  require(workspaceId: unknown): NodeWorkspace {
    if (typeof workspaceId !== 'string') throw new Error('WORKSPACE_NOT_FOUND');
    const workspace = this.options.database()?.getWorkspace(workspaceId);
    if (workspace === undefined) throw new Error('WORKSPACE_NOT_FOUND');
    return workspace;
  }

  async inspectMetadata(workspace: NodeWorkspace): Promise<WorkspaceInspection> {
    const config = this.options.config();
    if (config === undefined) throw new Error('NODE_CONFIG_UNAVAILABLE');
    const inspection = await inspectWorkspace(
      workspace.path,
      config.allowedRoots,
      workspace.includeParentRepository ?? true
    );
    if (normalizeWorkspacePath(inspection.path) !== normalizeWorkspacePath(workspace.path))
      throw new Error('WORKSPACE_NOT_ALLOWED');
    return inspection;
  }

  async commitMetadata(
    workspace: NodeWorkspace,
    inspection: WorkspaceInspection
  ): Promise<NodeWorkspace> {
    const database = this.options.database();
    if (database === undefined) throw new Error('NODE_DATABASE_UNAVAILABLE');
    if (normalizeWorkspacePath(inspection.path) !== normalizeWorkspacePath(workspace.path))
      throw new Error('WORKSPACE_NOT_ALLOWED');
    const current = this.require(workspace.id);
    if ((current.includeParentRepository ?? true) !== (workspace.includeParentRepository ?? true))
      return current;
    if (workspace.kind !== 'GIT_WORKSPACE' && inspection.kind === 'GIT_WORKSPACE')
      await ensureWorkspaceGitExclude(workspace.path, workspace.includeParentRepository ?? true);
    if (
      (this.require(workspace.id).includeParentRepository ?? true) !==
      (workspace.includeParentRepository ?? true)
    )
      return this.require(workspace.id);
    const saved = database.saveWorkspace({
      id: workspace.id,
      path: workspace.path,
      kind: inspection.kind,
      gitSummary: inspection.gitSummary ?? null
    });
    this.options.changes.invalidate(workspace.id);
    return saved;
  }

  clearWatches(workspaceId: string): void {
    this.options.watches.clear(workspaceId);
  }

  cachedSessions(workspaceId: string): Promise<readonly NodeAgentSession[]> {
    return this.options.sessions.cached(workspaceId);
  }

  invalidate(workspaceId: string): void {
    this.options.changes.invalidate(workspaceId);
    for (const topic of ['files', 'changes'] as const) {
      if (!this.options.watches.topicActive(workspaceId, topic)) continue;
      this.options.emit(workspaceId, topic);
    }
  }

  invalidateChanges(workspaceId: string): void {
    this.options.changes.invalidate(workspaceId);
  }

  gitPolicyChanged(workspaceId: string): void {
    this.invalidate(workspaceId);
    const workspace = this.require(workspaceId);
    void this.inspectMetadata(workspace)
      .then((inspection) => this.commitMetadata(workspace, inspection))
      .then(() => this.invalidate(workspaceId))
      .catch(() => nodeLog('workspace.git-policy.refresh-failed', { workspaceId }));
  }

  persistTerminal(summary: TerminalSummary): void {
    const database = this.options.database();
    if (database === undefined) return;
    const value: NodeTerminalSession = {
      id: summary.id,
      workspaceId: summary.workspaceId,
      profileId: summary.profileId,
      state: summary.state,
      exitCode: summary.exitCode,
      rows: summary.rows,
      cols: summary.cols,
      latestSequence: summary.latestSequence,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt
    };
    database.saveTerminalSession(value);
  }

  async inspect(envelope: NodeEnvelope): Promise<void> {
    const requestedPath =
      typeof envelope.payload === 'object' &&
      envelope.payload !== null &&
      'path' in envelope.payload
        ? (envelope.payload as { path?: unknown }).path
        : undefined;
    const config = this.options.config();
    if (typeof requestedPath !== 'string' || config === undefined) {
      this.options.send('workspace.inspect.result', { error: 'WORKSPACE_INVALID' }, envelope.id);
      return;
    }
    try {
      const path = await realpath(requestedPath);
      const current = this.options.database()?.getWorkspaceByPath(path);
      const inspection = await inspectWorkspace(
        path,
        config.allowedRoots,
        current?.includeParentRepository ?? true
      );
      this.options.send('workspace.inspect.result', inspection, envelope.id);
    } catch {
      this.options.send('workspace.inspect.result', { error: 'WORKSPACE_INVALID' }, envelope.id);
    }
  }
}
