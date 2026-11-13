import type { WorkspaceTarget } from '../model/workbench.js';
import type { Ref } from 'vue';
import type { NodeSummary, Session, Workspace } from '../model/workbench.js';
import type { createWorkbenchEntityService } from './workbench-entity-service.js';
import type { createWorkspaceTabService } from './workspace-tab-service.js';
import type { createWorkspaceTreeService } from './workspace-tree-service.js';
import type { createWorkspaceViewCacheService } from './workspace-view-cache-service.js';

/** Applies successful entity mutations to every affected tab-local projection. */
export function createWorkbenchEntityController(options: {
  readonly actions: ReturnType<typeof createWorkbenchEntityService>;
  readonly replaceNode: (node: NodeSummary) => void;
  readonly removeNode: (nodeId: string) => void;
  readonly sessions: Readonly<Ref<readonly Session[]>>;
  readonly removeSessionId: (sessionId: string) => void;
  readonly clearSessions: () => void;
  readonly clearActiveSelection: () => void;
  readonly clearRuns: () => void;
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly clearWorkspace: () => void;
  readonly selectedSessionId: Readonly<Ref<string | undefined>>;
  readonly setSelectedSessionId: (id: string | undefined) => void;
  readonly workspaces: Readonly<Ref<readonly Workspace[]>>;
  readonly replaceWorkspaces: (workspaces: readonly Workspace[]) => void;
  readonly caches: ReturnType<typeof createWorkspaceViewCacheService>;
  readonly tabs: ReturnType<typeof createWorkspaceTabService>;
  readonly tree: ReturnType<typeof createWorkspaceTreeService>;
  readonly replaceSession: (previousId: string, session: Session) => void;
  readonly refreshSessions: () => Promise<unknown>;
  readonly discardNodeCaches: (nodeId: string) => void;
  readonly releaseSessionDraft: (nodeId: string, workspaceId: string, sessionId: string) => void;
  readonly openDraft: () => void;
  readonly replaceUrl: () => void;
  readonly clearNodeDetails: () => void;
}) {
  async function renameNode(node: NodeSummary): Promise<void> {
    const updated = await options.actions.renameNode(node);
    if (updated !== undefined) options.replaceNode(updated);
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
      options.caches.removeSession(nodeId, session.workspaceId, session.id);
      options.releaseSessionDraft(nodeId, session.workspaceId, session.id);
    }
    if (options.workspaceTarget.value?.nodeId !== nodeId) return;
    const wasSelected = options.selectedSessionId.value === session.id;
    options.removeSessionId(session.id);
    if (wasSelected) {
      options.setSelectedSessionId(undefined);
      options.clearActiveSelection();
      options.openDraft();
    }
    options.replaceUrl();
  }

  async function deleteNode(node: NodeSummary): Promise<void> {
    if (!(await options.actions.deleteNode(node))) return;
    options.removeNode(node.id);
    options.tabs.removeWhere((tab) => tab.nodeId === node.id);
    options.discardNodeCaches(node.id);
    options.tree.removeNode(node.id);
    if (options.workspaceTarget.value?.nodeId === node.id) {
      options.clearWorkspace();
      options.setSelectedSessionId(undefined);
      options.replaceWorkspaces([]);
      options.clearSessions();
      options.clearRuns();
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
