import type { NodeOperationHandler } from '../application/node-operation-contracts.js';
import type { NodeWorkspace } from '../workspace/contracts.js';
import type { WorkspaceWatchService } from '../workspace/workspace-watch-service.js';
import type { WorkspaceWatchSnapshotService } from '../workspace/workspace-watch-snapshot-service.js';

export interface WorkspaceWatchControllerOptions {
  readonly requireWorkspace: (workspaceId: unknown) => NodeWorkspace;
  readonly watch: WorkspaceWatchService;
  readonly snapshots: WorkspaceWatchSnapshotService;
  readonly nodeGeneration: () => string;
}

/** Handles only the Workspace Watch protocol and delegates all topic reads to snapshots. */
export class WorkspaceWatchController {
  constructor(private readonly options: WorkspaceWatchControllerOptions) {}

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'workspace.watch': (data) => this.watch(record(data)),
      'workspace.unwatch': (data) => this.unwatch(record(data))
    };
  }

  private async watch(input: Record<string, unknown>): Promise<unknown> {
    this.validate(input);
    const workspace = this.options.requireWorkspace(input.workspaceId);
    const key = this.options.watch.key(input);
    if (input.mode === 'renew') {
      const active = this.options.watch.renew(workspace.id, key, input.watchId as string);
      if (active === undefined) throw new Error('WORKSPACE_WATCH_NOT_FOUND');
      return this.accepted(active);
    }
    const topics = this.options.watch.parseTopics(input);
    const existing = this.options.watch.existing(workspace.id, key);
    const groupOnly =
      existing !== undefined &&
      existing.topics.sessions === topics.sessions &&
      existing.topics.sessionGroup !== topics.sessionGroup &&
      existing.topics.changes === topics.changes &&
      JSON.stringify(existing.topics.files) === JSON.stringify(topics.files) &&
      (existing.prepareFiles === true) === (input.prepareFiles === true);
    if (
      existing !== undefined &&
      existing.watchId === input.watchId &&
      JSON.stringify(existing.topics) === JSON.stringify(topics) &&
      (existing.prepareFiles === true) === (input.prepareFiles === true)
    ) {
      this.options.watch.renew(workspace.id, key, input.watchId as string);
      return this.accepted(existing);
    }
    const watch = this.options.watch.create(
      workspace.id,
      input.watchId as string,
      this.options.watch.sessionHash(input),
      input.workbenchConnectionId as string,
      this.options.nodeGeneration(),
      topics,
      input.prepareFiles === true
    );
    void this.options.snapshots.initial(workspace, watch, groupOnly ? existing : undefined);
    if (watch.prepareFiles) this.options.snapshots.prewarmFiles(workspace, watch);
    return this.accepted(watch);
  }

  private unwatch(input: Record<string, unknown>): unknown {
    if (
      typeof input.workspaceId !== 'string' ||
      typeof input.watchId !== 'string' ||
      typeof input.workbenchConnectionId !== 'string' ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(input.watchId)
    )
      throw new Error('WORKSPACE_WATCH_INVALID');
    const key = this.options.watch.key(input);
    const watch = this.options.watch.renew(input.workspaceId, key, input.watchId);
    if (watch !== undefined) this.options.watch.remove(input.workspaceId, key);
    return { stopped: true };
  }

  private validate(input: Record<string, unknown>): void {
    if (
      typeof input.workspaceId !== 'string' ||
      typeof input.watchId !== 'string' ||
      typeof input.workbenchConnectionId !== 'string' ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(input.watchId) ||
      (input.mode !== 'initial' && input.mode !== 'renew') ||
      (input.prepareFiles !== undefined &&
        (input.mode !== 'initial' || input.prepareFiles !== true))
    )
      throw new Error('WORKSPACE_WATCH_INVALID');
  }

  private accepted(watch: {
    readonly watchId: string;
    readonly nodeGeneration: string;
    readonly expiresAt: number;
  }): unknown {
    return {
      accepted: true,
      watchId: watch.watchId,
      nodeGeneration: watch.nodeGeneration,
      expiresAt: watch.expiresAt
    };
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('WORKSPACE_WATCH_INVALID');
  return value as Record<string, unknown>;
}
