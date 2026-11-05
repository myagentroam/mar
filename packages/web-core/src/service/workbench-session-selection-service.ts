import type { WorkspaceTab, Workspace, WorkspaceTarget, Session } from '../model/workbench.js';
import type { AsideSession, createWorkbenchAsideService } from './workbench-aside-service.js';
import type { WorkspacePaneOpenOptions } from './workspace-session-pane-controller.js';
import { computed, ref, type Ref } from 'vue';

export function createWorkbenchSessionSelectionState(
  workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>
) {
  const sessionId = ref<string>();
  const draftOpen = ref(false);
  const draftTarget = computed(() => {
    const workspace = workspaceTarget.value;
    if (workspace === undefined) return undefined;
    const id = sessionId.value;
    return draftOpen.value || id === undefined || id.startsWith('draft:')
      ? { kind: 'workspace' as const, ...workspace }
      : { kind: 'session' as const, ...workspace, sessionId: id };
  });
  return {
    sessionId: computed(() => sessionId.value),
    draftOpen: computed(() => draftOpen.value),
    draftTarget,
    setSession: (id: string | undefined) => {
      sessionId.value = id;
    },
    setDraftOpen: (open: boolean) => {
      draftOpen.value = open;
    }
  };
}

export interface WorkbenchSessionSelectionOptions {
  readonly secondaryPane: {
    readonly target: Readonly<Ref<AsideSession | undefined>>;
    readonly reloadChecked: () => Promise<void>;
  };
  readonly aside: Pick<
    ReturnType<typeof createWorkbenchAsideService>,
    'current' | 'openSession' | 'closeSession' | 'removeMissing' | 'replaceSession'
  >;
  readonly canOpenAside: () => boolean;
  readonly saveAside: () => void;
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Readonly<Ref<string | undefined>>;
  readonly setSelectedSessionId: (id: string | undefined) => void;
  readonly sessions: Readonly<Ref<readonly Session[]>>;
  readonly draftOpen: Readonly<Ref<boolean>>;
  readonly setDraftOpen: (open: boolean) => void;
  readonly closeMobileSurface: () => void;
  readonly workspaceTabId: (nodeId: string, workspaceId: string) => string;
  readonly ensureSessionVisible: (tabId: string, index: number) => void;
  readonly markSessionRead: (
    nodeId: string,
    workspaceId: string,
    sessionId: string
  ) => void | Promise<void>;
  readonly saveCurrent: () => void;
  readonly selectWorkspace: (target: WorkspaceTarget, openDraft?: boolean) => Promise<boolean>;
  readonly pane: {
    readonly open: (sessionId: string, options?: WorkspacePaneOpenOptions) => Promise<void>;
    readonly openTab: (
      sessionId: string,
      onSessionResolved?: (session: Session) => void
    ) => Promise<void>;
    readonly loadingContent: Readonly<Ref<boolean>>;
  };
}

export function createWorkbenchSessionSelectionService(options: WorkbenchSessionSelectionOptions) {
  async function openAsideTarget(sessionId: string): Promise<void> {
    const target = options.secondaryPane.target.value;
    if (target === undefined) return;
    if (target.sessionId !== sessionId && !openAsideSession({ ...target, sessionId })) return;
    await options.secondaryPane.reloadChecked();
  }
  function openAsideSession(target: AsideSession): boolean {
    const workspace = options.workspaceTarget.value;
    if (workspace?.nodeId !== target.nodeId || workspace.workspaceId !== target.workspaceId)
      return false;
    const { sessionId } = target;
    if (!options.canOpenAside()) return false;
    const active = options.aside.current(workspace).active;
    if (active?.kind === 'session' && active.sessionId === sessionId) return true;
    options.saveAside();
    options.aside.openSession(target);
    return true;
  }

  function closeAsideSession(target: AsideSession): void {
    const workspace = options.workspaceTarget.value;
    if (workspace?.nodeId !== target.nodeId || workspace.workspaceId !== target.workspaceId) return;
    const { sessionId } = target;
    if (!options.aside.current(workspace).sessions.includes(sessionId)) return;
    const active = options.aside.current(workspace).active;
    if (active?.kind === 'session' && active.sessionId === sessionId) options.saveAside();
    options.aside.closeSession(target);
  }

  function replaceAsideSession(target: AsideSession, nextSessionId: string): boolean {
    const workspace = options.workspaceTarget.value;
    if (
      workspace?.nodeId !== target.nodeId ||
      workspace.workspaceId !== target.workspaceId ||
      !options.aside.current(workspace).sessions.includes(target.sessionId)
    )
      return false;
    if (nextSessionId === target.sessionId) return true;
    const active = options.aside.current(workspace).active;
    if (active?.kind === 'session' && active.sessionId === target.sessionId) options.saveAside();
    return options.aside.replaceSession(target, nextSessionId);
  }

  function removeMissingAside(workspace: WorkspaceTarget, sessionIds: readonly string[]): void {
    const current = options.workspaceTarget.value;
    const active = options.aside.current(workspace).active;
    if (
      current?.nodeId === workspace.nodeId &&
      current.workspaceId === workspace.workspaceId &&
      active?.kind === 'session' &&
      sessionIds.includes(active.sessionId)
    )
      options.saveAside();
    options.aside.removeMissing(workspace, sessionIds);
  }
  function prepareTarget(
    sessionId: string,
    nodeId: string,
    openOptions: WorkspacePaneOpenOptions
  ): { switching: boolean; session: Session | undefined } {
    if (!openOptions.preserveMobileWorkspaceSurface) options.closeMobileSurface();
    const switching = options.selectedSessionId.value !== sessionId;
    const session = options.sessions.value.find(
      (item) =>
        item.id === sessionId &&
        (!openOptions.markReadAfterOpen ||
          item.workspaceId === options.workspaceTarget.value?.workspaceId)
    );
    if (switching && session !== undefined && !openOptions.markReadAfterOpen)
      options.markSessionRead(nodeId, session.workspaceId, sessionId);
    if (session !== undefined) {
      const tabId = options.workspaceTabId(nodeId, session.workspaceId);
      const index = options.sessions.value
        .filter((candidate) => candidate.workspaceId === session.workspaceId)
        .findIndex((candidate) => candidate.id === session.id);
      options.ensureSessionVisible(tabId, index);
    }
    if (!openOptions.skipSaveCurrent) options.saveCurrent();
    if (session !== undefined && options.workspaceTarget.value?.workspaceId !== session.workspaceId)
      void options.selectWorkspace({ nodeId, workspaceId: session.workspaceId }, false);
    options.setDraftOpen(false);
    return { switching, session };
  }

  return {
    restoreDraftSelection: () => {
      options.setDraftOpen(true);
      options.setSelectedSessionId(undefined);
    },
    prepareTarget,
    openSession: options.pane.open,
    selectSession: options.pane.openTab,
    openWorkspaceTabSession: options.pane.openTab,
    openAsideSession,
    openAsideTarget,
    closeAsideSession,
    replaceAsideSession,
    removeMissingAside,
    loadingInitialContent: options.pane.loadingContent
  };
}

/** The session selection owns its target and connects navigation after Pane assembly. */
export function createWorkbenchSessionSelection(
  workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>
) {
  const state = createWorkbenchSessionSelectionState(workspaceTarget);
  return {
    ...state,
    connect(
      options: Omit<
        WorkbenchSessionSelectionOptions,
        | 'workspaceTarget'
        | 'selectedSessionId'
        | 'setSelectedSessionId'
        | 'draftOpen'
        | 'setDraftOpen'
      >
    ) {
      return createWorkbenchSessionSelectionService({
        ...options,
        workspaceTarget,
        selectedSessionId: state.sessionId,
        setSelectedSessionId: state.setSession,
        draftOpen: state.draftOpen,
        setDraftOpen: state.setDraftOpen
      });
    }
  };
}

export interface WorkbenchSelectionView {
  activateWorkspaceTab: (tab: WorkspaceTab) => Promise<void>;
  activeWorkspaceTabId: string | undefined;
  closeWorkspaceTab: (tab: WorkspaceTab, force?: boolean) => void;
  workspaceTarget: WorkspaceTarget | undefined;
  workspaceTabs: {
    readonly id: string;
    readonly nodeId: string;
    readonly nodeLabel?: string;
    readonly workspaceId: string;
    readonly label: string;
    readonly lastActiveAt: number;
    readonly selectedSessionId?: string;
    readonly pinned?: boolean;
  }[];
  workspaceTabLabel: (workspace: Workspace) => string;
  workspaceTabNodeLabel: (tab: WorkspaceTab) => string;
  moveWorkspaceTab: (tabId: string, targetIndex: number) => void;
  pinWorkspaceTab: (tabId: string, pinned: boolean) => void;
  workspaceSelectionLoading: boolean;
  retryWorkspaceSelection: () => void;
  selectedSessionId: string | undefined;
  openSessionFromList: (sessionId: string) => Promise<void>;
  openSessionGroupTarget: (target: {
    nodeId: string;
    workspaceId: string;
    sessionId: string;
  }) => Promise<void>;
  openNewSessionComposer: () => void;
  draftSessionOpen: boolean;
}
