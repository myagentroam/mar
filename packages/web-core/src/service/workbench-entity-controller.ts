import type { WorkspaceTarget } from '../model/workbench.js';
import type { Ref } from 'vue';
import type {
  AgentRun,
  ConversationTurn,
  NodeWorkbenchManifest,
  NodeSummary,
  Session,
  Workspace
} from '../model/workbench.js';
import type { createWorkbenchEntityService } from './workbench-entity-service.js';
import type { createWorkspaceTabService } from './workspace-tab-service.js';
import type { createWorkspaceTreeService } from './workspace-tree-service.js';
import type { createWorkspaceViewCacheService } from './workspace-view-cache-service.js';

/** Applies successful entity mutations to every affected tab-local projection. */
export function createWorkbenchEntityController(options: {
  readonly actions: ReturnType<typeof createWorkbenchEntityService>;
  readonly nodes: Ref<NodeSummary[]>;
  readonly sessions: Ref<Session[]>;
  readonly runs: Ref<AgentRun[]>;
  readonly turns: Ref<ConversationTurn[]>;
  readonly nextCursor: Ref<string | null>;
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly clearWorkspace: () => void;
  readonly selectedSessionId: Ref<string | undefined>;
  readonly selectedRunId: Ref<string | undefined>;
  readonly nodeManifest: Ref<NodeWorkbenchManifest | undefined>;
  readonly workspaces: Ref<Workspace[]>;
  readonly caches: ReturnType<typeof createWorkspaceViewCacheService>;
  readonly tabs: ReturnType<typeof createWorkspaceTabService>;
  readonly tree: ReturnType<typeof createWorkspaceTreeService>;
  readonly replaceSession: (previousId: string, session: Session) => void;
  readonly refreshSessions: () => Promise<unknown>;
  readonly discardNodeCaches: (nodeId: string) => void;
  readonly openDraft: () => void;
  readonly replaceUrl: () => void;
  readonly clearNodeDetails: () => void;
}) {
  async function renameNode(node: NodeSummary): Promise<void> {
    const updated = await options.actions.renameNode(node);
    if (updated !== undefined)
      options.nodes.value = options.nodes.value.map((item) =>
        item.id === node.id ? updated : item
      );
  }

  async function renameSession(session: Session): Promise<void> {
    const updated = await options.actions.renameSession(session);
    if (updated !== undefined) options.replaceSession(session.id, updated);
  }

  async function setSessionPinned(session: Session, pinned: boolean): Promise<void> {
    if (await options.actions.setSessionPinned(session, pinned)) await options.refreshSessions();
  }

  async function moveSessionToMain(session: Session): Promise<void> {
    const updated = await options.actions.moveSessionToMain(session);
    if (updated !== undefined) {
      options.replaceSession(session.id, updated);
      await options.refreshSessions();
    }
  }

  async function movePinnedSession(session: Session, direction: 'up' | 'down'): Promise<void> {
    if (await options.actions.movePinnedSession(session, direction))
      await options.refreshSessions();
  }

  async function movePinnedSessionTo(
    session: Session,
    target: Session,
    position: 'before' | 'after'
  ): Promise<void> {
    if (session.id === target.id) return;
    const direction = session.pinOrder! > target.pinOrder! ? 'up' : 'down';
    await options.actions.movePinnedSession(session, direction, { sessionId: target.id, position });
    await options.refreshSessions();
  }

  async function deleteSession(session: Session): Promise<void> {
    const nodeId = options.workspaceTarget.value?.nodeId;
    if (!(await options.actions.deleteSession(session))) return;
    if (nodeId !== undefined) {
      const cache = options.caches.get(nodeId, session.workspaceId);
      cache.sessionDetails.delete(session.id);
      if (cache.selectedSessionId === session.id) delete cache.selectedSessionId;
    }
    if (options.workspaceTarget.value?.nodeId !== nodeId) return;
    const wasSelected = options.selectedSessionId.value === session.id;
    options.sessions.value = options.sessions.value.filter((item) => item.id !== session.id);
    if (wasSelected) {
      options.selectedSessionId.value = undefined;
      options.selectedRunId.value = undefined;
      options.runs.value = [];
      options.turns.value = [];
      options.nextCursor.value = null;
      options.openDraft();
    }
    options.replaceUrl();
  }

  async function deleteNode(node: NodeSummary): Promise<void> {
    if (!(await options.actions.deleteNode(node))) return;
    options.nodes.value = options.nodes.value.filter((item) => item.id !== node.id);
    options.tabs.removeWhere((tab) => tab.nodeId === node.id);
    options.discardNodeCaches(node.id);
    options.tree.removeNode(node.id);
    if (options.workspaceTarget.value?.nodeId === node.id) {
      options.clearWorkspace();
      options.selectedSessionId.value = undefined;
      options.selectedRunId.value = undefined;
      options.nodeManifest.value = undefined;
      options.workspaces.value = [];
      options.sessions.value = [];
      options.runs.value = [];
    }
    options.clearNodeDetails();
  }

  return {
    renameNode,
    renameSession,
    moveSessionToMain,
    setSessionPinned,
    movePinnedSession,
    movePinnedSessionTo,
    deleteSession,
    deleteNode
  };
}
