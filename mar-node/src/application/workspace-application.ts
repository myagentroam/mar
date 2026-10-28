import type { SessionGroup } from '@myagentroam/protocol';
import type { NodeConfig } from '../config.js';
import type { NodeDatabase } from '../database.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { TerminalManager } from '../terminal.js';
import { NodeWorkspaceCoordinator } from '../service/node-workspace-coordinator.js';
import { WorkspaceService } from '../service/workspace-service.js';
import { WorkspaceWorkbenchService } from '../workspace/workspace-workbench-service.js';
import type { WorkspaceChangeService } from '../workspace/workspace-change-service.js';
import type { composeWorkspaceResources } from './workspace-composition.js';
import { isPlainRecord } from '../util/records.js';

/** Owns the cross-service workspace removal and observation wiring. */
export function composeWorkspaceApplication(input: {
  readonly config: () => NodeConfig | undefined;
  readonly database: () => NodeDatabase | undefined;
  readonly runtime: NodeRuntimeState;
  readonly terminals: TerminalManager;
  readonly resources: ReturnType<typeof composeWorkspaceResources>;
  readonly changes: WorkspaceChangeService;
  readonly listSessions: (workspaceId: string, group?: SessionGroup) => Promise<unknown>;
  readonly invalidatePrompt: (workspaceId: string) => void;
  readonly nodeId: () => string;
  readonly nodeGeneration: () => string;
  readonly send: (type: string, payload: unknown, replyTo?: string) => void;
  readonly emitWatchEvent: (payload: unknown) => void;
  readonly publishSession: (payload: unknown) => void;
}) {
  const resources = input.resources;
  const coordinator = new NodeWorkspaceCoordinator({
    config: input.config,
    database: input.database,
    watches: resources.watch,
    sessions: resources.sessions,
    changes: input.changes,
    emit: (workspaceId, topic) => void workbench?.invalidateTopic(workspaceId, topic),
    send: input.send
  });
  const workbench = new WorkspaceWorkbenchService({
    requireWorkspace: (id) => coordinator.require(id),
    inspectWorkspace: (workspace) => coordinator.inspectMetadata(workspace),
    commitWorkspace: (workspace, inspection) => coordinator.commitMetadata(workspace, inspection),
    watch: resources.watch,
    files: resources.files,
    uploads: resources.uploads,
    changes: input.changes,
    listSessions: input.listSessions,
    invalidate: resources.invalidateFiles,
    nodeId: input.nodeId,
    nodeGeneration: input.nodeGeneration,
    emitWatchEvent: input.emitWatchEvent
  });
  const workspace = new WorkspaceService(
    () => {
      const database = input.database();
      if (database === undefined) throw new Error('NODE_DATABASE_UNAVAILABLE');
      return database;
    },
    () => {
      const config = input.config();
      if (config === undefined) throw new Error('NODE_CONFIG_UNAVAILABLE');
      return config;
    },
    input.runtime,
    (id) => {
      input.terminals.removeWorkspaceAssociation(id);
      resources.files.dispose(id);
      coordinator.invalidateChanges(id);
      resources.sessions.invalidate(id);
      coordinator.clearWatches(id);
      workbench.clearWorkspace(id);
      input.invalidatePrompt(id);
    },
    (id) => coordinator.gitPolicyChanged(id)
  );
  const publishSession = (payload: unknown): void => {
    if (isPlainRecord(payload) && isPlainRecord(payload.session)) {
      const workspaceId = payload.session.workspaceId;
      if (typeof workspaceId === 'string') {
        resources.sessions.markCacheStale(workspaceId);
        void workbench.invalidateTopic(workspaceId, 'sessions');
      }
    }
    input.publishSession(payload);
  };
  return { coordinator, workbench, workspace, publishSession };
}
