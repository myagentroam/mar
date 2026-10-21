import type { WorkspaceTarget } from '../model/workbench.js';
import { ElMessageBox } from 'element-plus';
import type { Ref } from 'vue';
import type { NodeSummary, Session, Workspace, WorkspaceTab } from '../model/workbench.js';
import type { WorkspaceSessionCleanupResult } from '@myagentroam/protocol';
import type { createWorkspaceTabService } from './WorkspaceTabService.js';
import type { createWorkspaceTreeService } from './WorkspaceTreeService.js';
import { translate } from './LocalePreferenceService.js';

export interface WorkbenchWorkspaceTreeControllerOptions {
  readonly nodes: Ref<NodeSummary[]>;
  readonly workspaces: Ref<Workspace[]>;
  readonly sessions: Ref<Session[]>;
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Ref<string | undefined>;
  readonly selectedRunId: Ref<string | undefined>;
  readonly activeTabId: Ref<string | undefined>;
  readonly showWorkbench: () => void;
  readonly loading: Ref<boolean>;
  readonly notice: Ref<string>;
  readonly workspacesByNode: Ref<Record<string, readonly Workspace[]>>;
  readonly tabs: ReturnType<typeof createWorkspaceTabService>;
  readonly tree: ReturnType<typeof createWorkspaceTreeService>;
  readonly releaseTerminalDock: (tabId: string) => void;
  readonly deleteTerminalDock: (tabId: string) => void;
  readonly request: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  readonly saveCurrent: () => void;
  readonly discardCache: (nodeId: string, workspaceId: string) => void;
  readonly activateWorkspace: (
    target: WorkspaceTarget,
    restoreSession?: boolean
  ) => Promise<boolean>;
  readonly workspaceTabSession: (nodeId: string, workspaceId: string) => string | undefined;
  readonly openWorkspaceTabSession: (sessionId: string) => Promise<void>;
  readonly clearWorkspace: () => void;
  readonly currentSelectionRevision: () => number;
  readonly cleanupSessionsEnabled: (nodeId: string) => boolean;
  readonly refreshWorkspaceSessions: (workspaceId: string) => Promise<void>;
  readonly refreshNodes: () => Promise<void>;
  readonly closeMobileSidebar: () => void;
  readonly closeMobileWorkspaceSurface: () => void;
  readonly errorMessage: (error: unknown) => string;
  readonly tabLabel: (workspace: Workspace) => string;
}

/** Owns Workspace tree caching, tabs, ordering and registration removal actions. */
export function createWorkbenchWorkspaceTreeController(
  options: WorkbenchWorkspaceTreeControllerOptions
) {
  const workspaceRequestIds = new Map<string, number>();
  let fallbackRevision = 0;
  let pendingFallbackTabId: string | undefined;
  let pendingFallbackSelectionRevision = 0;
  const cacheNodeWorkspaces = (nodeId: string, values: readonly Workspace[]) =>
    options.tree.cacheWorkspaces(nodeId, values);
  const workspacesForNode = (nodeId: string) => options.tree.workspacesForNode(nodeId);
  const orderedWorkspaces = (nodeId: string) => options.tree.orderedWorkspaces(nodeId);

  function updateWorkspaceBranch(nodeId: string, workspaceId: string, branch: string | null): void {
    const updated = workspacesForNode(nodeId).map((workspace) =>
      workspace.id === workspaceId
        ? { ...workspace, gitSummary: { ...(workspace.gitSummary ?? {}), branch } }
        : workspace
    );
    if (nodeId === options.workspaceTarget.value?.nodeId) options.workspaces.value = [...updated];
    cacheNodeWorkspaces(nodeId, updated);
  }

  function updateWorkspaceMetadata(nodeId: string, value: Workspace): void {
    const updated = workspacesForNode(nodeId).map((workspace) => {
      if (workspace.id !== value.id) return workspace;
      const workspaceWithoutGitSummary = { ...workspace };
      Reflect.deleteProperty(workspaceWithoutGitSummary, 'gitSummary');
      return {
        ...workspaceWithoutGitSummary,
        path: value.path,
        kind: value.kind,
        ...(value.gitSummary === undefined ? {} : { gitSummary: value.gitSummary })
      };
    });
    if (nodeId === options.workspaceTarget.value?.nodeId) options.workspaces.value = [...updated];
    cacheNodeWorkspaces(nodeId, updated);
  }

  function rememberWorkspace(nodeId: string, workspace: Workspace): void {
    const node = options.nodes.value.find((candidate) => candidate.id === nodeId);
    options.tabs.remember(nodeId, node, workspace);
  }

  function closeWorkspaceTab(tab: WorkspaceTab, force = false): void {
    const current = options.tabs.tabs.value.find((candidate) => candidate.id === tab.id);
    if (current === undefined || (!force && current.pinned === true)) return;
    closeWorkspaceTabs([current], !force);
  }

  function closeWorkspaceTabs(closing: readonly WorkspaceTab[], restartPending = true): void {
    const wasActive = closing.some((tab) => options.activeTabId.value === tab.id);
    const wasPending =
      restartPending &&
      pendingFallbackSelectionRevision === options.currentSelectionRevision() &&
      closing.some((tab) => pendingFallbackTabId === tab.id);
    if (wasActive) options.saveCurrent();
    for (const tab of closing) {
      options.releaseTerminalDock(tab.id);
      options.deleteTerminalDock(tab.id);
      options.tabs.remove(tab);
      options.discardCache(tab.nodeId, tab.workspaceId);
    }
    if (!wasActive && !wasPending) return;
    options.clearWorkspace();
    void activateMostRecentWorkspaceTab();
  }

  async function activateMostRecentWorkspaceTab(): Promise<void> {
    const revision = ++fallbackRevision;
    const attempted = new Set<string>();
    pendingFallbackTabId = undefined;
    for (;;) {
      const replacement = options.tabs.mostRecentlyUsed(attempted);
      if (replacement === undefined) return;
      attempted.add(replacement.id);
      pendingFallbackTabId = replacement.id;
      const activation = activateWorkspaceTab(replacement);
      // Activation changes the Workspace identity synchronously before background requests.
      const selectionRevision = options.currentSelectionRevision();
      pendingFallbackSelectionRevision = selectionRevision;
      const activated = await activation;
      if (revision !== fallbackRevision) return;
      pendingFallbackTabId = undefined;
      if (activated || selectionRevision !== options.currentSelectionRevision()) return;
    }
  }

  function closeUnpinnedWorkspaceTabs(): void {
    const activeId = options.activeTabId.value;
    const closing = options.tabs.tabs.value.filter((tab) => tab.pinned !== true);
    const active = closing.find((tab) => tab.id === activeId);
    closeWorkspaceTabs([
      ...closing.filter((tab) => tab.id !== activeId),
      ...(active === undefined ? [] : [active])
    ]);
  }

  async function activateWorkspaceTab(tab: WorkspaceTab): Promise<boolean> {
    const node = options.nodes.value.find((candidate) => candidate.id === tab.nodeId);
    if (node === undefined) {
      closeWorkspaceTab(tab, true);
      return false;
    }
    return activateWorkspaceTarget(tab);
  }

  async function openWorkspaceTab(tab: WorkspaceTab): Promise<void> {
    const node = options.nodes.value.find((candidate) => candidate.id === tab.nodeId);
    if (node === undefined) {
      closeWorkspaceTab(tab, true);
      return;
    }
    const sessionId = options.workspaceTabSession(tab.nodeId, tab.workspaceId);
    const activation = activateWorkspaceTarget(tab, sessionId === undefined);
    const revision = options.currentSelectionRevision();
    if (!(await activation) || revision !== options.currentSelectionRevision()) return;
    const selected = options.workspaceTarget.value;
    if (
      selected?.nodeId !== tab.nodeId ||
      selected.workspaceId !== tab.workspaceId ||
      !node.connected ||
      node.disabled
    )
      return;
    if (sessionId !== undefined) await options.openWorkspaceTabSession(sessionId);
  }

  function activateWorkspaceTarget(
    target: WorkspaceTarget,
    restoreSession = true
  ): Promise<boolean> {
    const current = options.workspaceTarget.value;
    const activation =
      current?.nodeId === target.nodeId && current.workspaceId === target.workspaceId
        ? Promise.resolve(true)
        : restoreSession
          ? options.activateWorkspace(target)
          : options.activateWorkspace(target, false);
    options.closeMobileSidebar();
    options.showWorkbench();
    return activation;
  }

  async function toggleNodeExpansion(nodeId: string): Promise<void> {
    if (!options.tree.toggleNode(nodeId)) return;
    if (
      nodeId === options.workspaceTarget.value?.nodeId ||
      nodeId in options.workspacesByNode.value
    )
      return;
    await refreshNodeWorkspaces(nodeId);
  }

  async function refreshNodeWorkspaces(nodeId: string): Promise<void> {
    const selection = options.workspaceTarget.value;
    const selectionRevision = options.currentSelectionRevision();
    const currentSelection = () =>
      options.workspaceTarget.value === selection &&
      options.currentSelectionRevision() === selectionRevision;
    const requestId = (workspaceRequestIds.get(nodeId) ?? 0) + 1;
    workspaceRequestIds.set(nodeId, requestId);
    try {
      const result = await options.request<{ workspaces: Workspace[] }>(
        `/api/workspaces?nodeId=${encodeURIComponent(nodeId)}`
      );
      if (workspaceRequestIds.get(nodeId) !== requestId) return;
      cacheNodeWorkspaces(nodeId, result.workspaces);
      if (currentSelection() && options.workspaceTarget.value?.nodeId === nodeId)
        options.workspaces.value = result.workspaces;
    } catch (error) {
      if (workspaceRequestIds.get(nodeId) !== requestId || !currentSelection()) return;
      options.notice.value = translate(
        'generated.workbenchWorkspaceTreeController.unableToLoadNodeWorkspaces',
        { value0: options.errorMessage(error) }
      );
    }
  }

  async function refreshWorkspaceTree(): Promise<void> {
    await options.refreshNodes();
    const nodeIds = new Set([
      ...options.tree.expandedNodeIds.value,
      ...Object.keys(options.workspacesByNode.value),
      ...(options.workspaceTarget.value?.nodeId === undefined
        ? []
        : [options.workspaceTarget.value?.nodeId])
    ]);
    await Promise.all(
      options.nodes.value
        .filter((node) => nodeIds.has(node.id))
        .map((node) => refreshNodeWorkspaces(node.id))
    );
  }

  async function openWorkspaceFromTree(nodeId: string, workspaceId: string): Promise<void> {
    options.closeMobileWorkspaceSurface();
    await activateWorkspaceTarget({ nodeId, workspaceId });
  }

  const startWorkspaceDrag = (event: DragEvent, nodeId: string, workspaceId: string) =>
    options.tree.startDrag(event, nodeId, workspaceId);

  function canOrganizeWorkspaceGroups(nodeId: string): boolean {
    const node = options.nodes.value.find((candidate) => candidate.id === nodeId);
    return node?.workspaceCreatable === true;
  }

  async function updateWorkspaceGroup(
    nodeId: string,
    workspace: Workspace,
    groupName: string | null
  ): Promise<void> {
    if (!canOrganizeWorkspaceGroups(nodeId) || workspace.groupName === groupName) return;
    options.loading.value = true;
    try {
      await options.request(
        `/api/workspaces/${encodeURIComponent(workspace.id)}?nodeId=${encodeURIComponent(nodeId)}`,
        { method: 'PATCH', body: JSON.stringify({ groupName }) }
      );
      const updatedWorkspace = { ...workspace, groupName };
      const updated = workspacesForNode(nodeId).map((candidate) =>
        candidate.id === workspace.id ? updatedWorkspace : candidate
      );
      cacheNodeWorkspaces(nodeId, updated);
      if (options.workspaceTarget.value?.nodeId === nodeId) options.workspaces.value = [...updated];
    } catch (error) {
      options.notice.value = options.errorMessage(error);
    } finally {
      options.loading.value = false;
    }
  }

  async function moveWorkspaceGroup(
    nodeId: string,
    workspace: Workspace,
    groupName: string | null
  ): Promise<void> {
    await updateWorkspaceGroup(nodeId, workspace, groupName);
  }

  function reorderWorkspace(
    nodeId: string,
    target: Workspace,
    position?: 'before' | 'after'
  ): void {
    const dragging = options.tree.draggingWorkspace.value;
    if (dragging === undefined || dragging.nodeId !== nodeId) return;
    const source = workspacesForNode(nodeId).find(
      (workspace) => workspace.id === dragging.workspaceId
    );
    if (source === undefined) {
      options.tree.endDrag();
      return;
    }
    const sourceGroupName = source.groupName?.trim() || null;
    const targetGroupName = target.groupName?.trim() || null;
    if (sourceGroupName === targetGroupName) {
      options.tree.reorder(nodeId, target.id, position);
      return;
    }
    options.tree.endDrag();
    void updateWorkspaceGroup(nodeId, source, targetGroupName);
  }

  function moveWorkspaceToGroup(nodeId: string, groupName: string | null): void {
    const dragging = options.tree.draggingWorkspace.value;
    if (dragging === undefined || dragging.nodeId !== nodeId) return;
    options.tree.endDrag();
    const source = workspacesForNode(nodeId).find(
      (workspace) => workspace.id === dragging.workspaceId
    );
    if (source === undefined) return;
    void updateWorkspaceGroup(nodeId, source, groupName);
  }

  async function renameWorkspace(nodeId: string, workspace: Workspace): Promise<void> {
    if (workspace.manageable === false) return;
    let displayName: string;
    try {
      displayName = (
        await ElMessageBox.prompt(
          translate('generated.workspaceTree.enterWorkspaceName'),
          translate('generated.workspaceTree.renameWorkspace'),
          {
            inputValue: options.tabLabel(workspace),
            inputValidator: (value) => {
              const length = value.trim().length;
              if (length === 0) return translate('generated.workspaceTree.workspaceNameRequired');
              return length <= 255 || translate('generated.workspaceTree.workspaceNameTooLong');
            },
            confirmButtonText: translate('generated.workspaceTree.save'),
            cancelButtonText: translate('generated.workspaceTree.cancel')
          }
        )
      ).value.trim();
    } catch {
      return;
    }
    options.loading.value = true;
    try {
      await options.request(
        `/api/workspaces/${encodeURIComponent(workspace.id)}?nodeId=${encodeURIComponent(nodeId)}`,
        { method: 'PATCH', body: JSON.stringify({ displayName }) }
      );
      const updatedWorkspace = { ...workspace, displayName };
      const updated = workspacesForNode(nodeId).map((candidate) =>
        candidate.id === workspace.id ? updatedWorkspace : candidate
      );
      cacheNodeWorkspaces(nodeId, updated);
      if (options.workspaceTarget.value?.nodeId === nodeId) options.workspaces.value = [...updated];
      options.tabs.updateLabel(nodeId, workspace.id, options.tabLabel(updatedWorkspace));
    } catch (error) {
      options.notice.value = options.errorMessage(error);
    } finally {
      options.loading.value = false;
    }
  }

  async function removeWorkspace(nodeId: string, workspace: Workspace): Promise<void> {
    if (!canOrganizeWorkspaceGroups(nodeId)) return;
    try {
      await ElMessageBox.confirm(
        translate(
          'generated.workbenchWorkspaceTreeController.unregisterThisDoesNotDeleteTheLocal',
          { value0: options.tabLabel(workspace) }
        ),
        translate('generated.workbenchWorkspaceTreeController.unregisterWorkspace'),
        {
          confirmButtonText: translate('generated.workbenchWorkspaceTreeController.unregister'),
          cancelButtonText: translate('generated.workbenchWorkspaceTreeController.cancel'),
          type: 'warning'
        }
      );
    } catch {
      return;
    }
    options.loading.value = true;
    try {
      await options.request(
        `/api/workspaces/${encodeURIComponent(workspace.id)}?nodeId=${encodeURIComponent(nodeId)}`,
        { method: 'DELETE' }
      );
      const remaining = workspacesForNode(nodeId).filter((item) => item.id !== workspace.id);
      cacheNodeWorkspaces(nodeId, remaining);
      if (options.workspaceTarget.value?.nodeId === nodeId) {
        options.workspaces.value = remaining;
        options.sessions.value = options.sessions.value.filter(
          (session) => session.workspaceId !== workspace.id
        );
        if (options.workspaceTarget.value?.workspaceId === workspace.id) {
          options.clearWorkspace();
          options.selectedSessionId.value = undefined;
          options.selectedRunId.value = undefined;
        }
      }
      options.tabs.removeWhere((tab) => tab.nodeId === nodeId && tab.workspaceId === workspace.id);
      options.notice.value = translate(
        'generated.workbenchWorkspaceTreeController.theWorkspaceWasUnregisteredItsLocalDirectory'
      );
    } catch (error) {
      options.notice.value = translate(
        'generated.workbenchWorkspaceTreeController.unableToUnregisterTheWorkspace',
        { value0: options.errorMessage(error) }
      );
    } finally {
      options.loading.value = false;
    }
  }

  async function cleanupWorkspaceSessions(
    nodeId: string,
    workspace: Workspace,
    inactiveDays: number
  ): Promise<WorkspaceSessionCleanupResult | undefined> {
    if (workspace.manageable === false || !options.cleanupSessionsEnabled(nodeId)) return undefined;
    options.loading.value = true;
    try {
      const result = await options.request<WorkspaceSessionCleanupResult>(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/sessions/cleanup`,
        {
          method: 'POST',
          body: JSON.stringify({ nodeId, inactiveDays })
        }
      );
      if (
        options.workspaceTarget.value?.nodeId === nodeId &&
        options.workspaceTarget.value?.workspaceId === workspace.id
      )
        await options.refreshWorkspaceSessions(workspace.id);
      return result;
    } catch (error) {
      throw new Error(options.errorMessage(error));
    } finally {
      options.loading.value = false;
    }
  }

  return {
    updateWorkspaceBranch,
    updateWorkspaceMetadata,
    rememberWorkspace,
    closeWorkspaceTab,
    closeUnpinnedWorkspaceTabs,
    activateWorkspaceTab,
    openWorkspaceTab,
    cacheNodeWorkspaces,
    workspacesForNode,
    orderedWorkspaces,
    toggleNodeExpansion,
    refreshNodeWorkspaces,
    refreshWorkspaceTree,
    openWorkspaceFromTree,
    startWorkspaceDrag,
    reorderWorkspace,
    moveWorkspaceToGroup,
    moveWorkspaceGroup,
    renameWorkspace,
    cleanupWorkspaceSessions,
    removeWorkspace
  };
}
