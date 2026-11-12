/**
 * Owns Workspace target identity and its selection revision before application ports connect.
 * Connected selection coordinates cache/profile/catalog restoration and ignores stale async work.
 * Cache contents, Watch leases and Pane state remain with their domain owners; no file protocol here.
 */
import type { MessageFeedback } from '../model/message-feedback.js';
import { computed, ref, type Ref } from 'vue';

export function createWorkbenchWorkspaceSelectionState() {
  const target = ref<WorkspaceTarget>();
  return {
    ...createSelectionRevision(),
    target: computed(() => target.value),
    setTarget: (next: WorkspaceTarget | undefined) => {
      target.value = next;
    }
  };
}
function createSelectionRevision() {
  let revision = 0;
  return {
    currentSelectionRevision: () => revision,
    nextSelectionRevision: () => ++revision
  };
}
import type { Session, Workspace, WorkspaceTarget } from '../model/workbench.js';
import type { WorkspaceCacheView } from './workspace-view-cache-service.js';
import { translate } from './locale-preference-service.js';
import { errorCode } from '../util/api-error.js';
import { sessionHasNativeIdentity } from '../util/session-presentation.js';

interface WorkbenchWorkspaceSelectionOptions {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly setWorkspaceTarget: (target: WorkspaceTarget | undefined) => void;
  readonly selectedSessionId: Readonly<Ref<string | undefined>>;
  readonly setSelectedSessionId: (id: string | undefined) => void;
  readonly workspaces: Readonly<Ref<readonly Workspace[]>>;
  readonly replaceWorkspaces: (workspaces: readonly Workspace[]) => void;
  readonly sessions: Readonly<Ref<readonly Session[]>>;
  readonly replaceSessions: (sessions: readonly Session[]) => void;
  readonly draftOpen: Readonly<Ref<boolean>>;
  readonly setDraftOpen: (open: boolean) => void;
  readonly profilesLoading: Readonly<Ref<boolean>>;
  readonly hasNode: (nodeId: string) => boolean;
  readonly isHostAvailable: (nodeId: string) => boolean;
  readonly isNetworkUnavailable: () => boolean;
  readonly cachedWorkspaces: (nodeId: string) => readonly Workspace[];
  readonly cacheWorkspaces: (nodeId: string, values: readonly Workspace[]) => void;
  readonly rememberTarget: (target: WorkspaceTarget) => void;
  readonly invalidateWorkspace: (target: WorkspaceTarget) => void;
  readonly deactivateCache: () => void;
  readonly clearContent: () => void;
  readonly showWorkbench: () => void;
  readonly closeSidebar: () => void;
  readonly restoreProfiles: (nodeId: string) => void;
  readonly selectManifestNode: (nodeId?: string) => void;
  readonly refreshManifest: (nodeId: string) => Promise<void>;
  readonly refreshTransport: (nodeId: string) => void;
  readonly request: <T>(path: string) => Promise<T>;
  readonly notice: MessageFeedback;
  readonly errorMessage: (error: unknown) => string;
  readonly stopWatch: () => void;
  readonly startWatch: (workspaceId: string) => Promise<unknown>;
  readonly saveCurrent: () => void;
  readonly activateCache: (nodeId: string, workspaceId: string) => void;
  readonly isCacheActive: (nodeId: string, workspaceId: string) => boolean;
  readonly restoreWorkspaceView: (nodeId: string, workspaceId: string) => void;
  readonly refreshVisibleTool: (nodeId: string, workspaceId: string) => void;
  readonly initializePaging: (tabId: string) => void;
  readonly tabId: (nodeId: string, workspaceId: string) => string;
  readonly rememberWorkspace: (nodeId: string, workspace: Workspace) => void;
  readonly viewCache: (nodeId: string, workspaceId: string) => WorkspaceCacheView;
  readonly resetQueue: () => void;
  readonly openSession: (
    sessionId: string,
    options?: { readonly skipSaveCurrent?: boolean }
  ) => Promise<void>;
  readonly openDraft: () => void;
  readonly restoreDraft: (cache: WorkspaceCacheView | undefined) => void;
  readonly hasProfiles: (nodeId: string) => boolean;
  readonly loadProfiles: (nodeId: string) => Promise<void>;
  readonly takeRestoredSelection: (
    nodeId: string,
    workspaceId: string
  ) => { readonly selectedSessionId?: string } | undefined;
  readonly restoreSession: (workspaceId: string, sessionId?: string) => Promise<void>;
}

/** Owns the only Workspace activation path; requests never gate the foreground selection. */
export function createWorkbenchWorkspaceSelectionService(
  options: WorkbenchWorkspaceSelectionOptions,
  revision = createSelectionRevision()
) {
  const loading = ref(false);

  function clear(): void {
    revision.nextSelectionRevision();
    loading.value = false;
    options.stopWatch();
    options.deactivateCache();
    options.setWorkspaceTarget(undefined);
    options.setSelectedSessionId(undefined);
    options.replaceWorkspaces([]);
    options.replaceSessions([]);
    options.selectManifestNode();
    options.setDraftOpen(false);
    options.clearContent();
    options.resetQueue();
  }

  async function select(target: WorkspaceTarget, openDraft = true): Promise<boolean> {
    if (!options.hasNode(target.nodeId)) {
      options.invalidateWorkspace(target);
      return false;
    }
    const selectionRevision = revision.nextSelectionRevision();
    loading.value = false;
    const previous = options.workspaceTarget.value;
    const switching =
      previous?.nodeId !== target.nodeId || previous.workspaceId !== target.workspaceId;
    if (switching) {
      options.saveCurrent();
      options.stopWatch();
      options.deactivateCache();
      options.setSelectedSessionId(undefined);
      options.setDraftOpen(false);
      options.clearContent();
      options.setWorkspaceTarget({ nodeId: target.nodeId, workspaceId: target.workspaceId });
      options.restoreProfiles(target.nodeId);
    }
    const selected = options.workspaceTarget.value!;
    const current = () =>
      revision.currentSelectionRevision() === selectionRevision &&
      options.workspaceTarget.value === selected;

    options.closeSidebar();
    options.showWorkbench();
    options.replaceWorkspaces([...options.cachedWorkspaces(target.nodeId)]);
    const workspace = options.workspaces.value.find(
      (candidate) => candidate.id === target.workspaceId
    );
    if (workspace === undefined) options.rememberTarget(target);
    else options.rememberWorkspace(target.nodeId, workspace);

    if (!options.isHostAvailable(target.nodeId)) {
      options.stopWatch();
      options.deactivateCache();
      options.replaceWorkspaces([]);
      options.replaceSessions([]);
      options.setSelectedSessionId(undefined);
      options.clearContent();
      options.selectManifestNode();
      return true;
    }

    options.selectManifestNode(target.nodeId);
    const cache = options.viewCache(target.nodeId, target.workspaceId);
    const restoreView = switching || !options.isCacheActive(target.nodeId, target.workspaceId);
    if (restoreView) {
      options.activateCache(target.nodeId, target.workspaceId);
      options.restoreWorkspaceView(target.nodeId, target.workspaceId);
      if (cache.files !== undefined || cache.git !== undefined)
        options.refreshVisibleTool(target.nodeId, target.workspaceId);
      options.replaceSessions(cache.sessions);
      options.restoreDraft(cache);
    }
    options.initializePaging(options.tabId(target.nodeId, target.workspaceId));
    options.resetQueue();
    const keepSelected =
      !switching &&
      options.selectedSessionId.value !== undefined &&
      options.sessions.value.some((session) => session.id === options.selectedSessionId.value);
    const stored = options.takeRestoredSelection(target.nodeId, target.workspaceId);
    const cachedSession = cache.sessions.find((session) => session.id === cache.selectedSessionId);
    if (
      openDraft &&
      restoreView &&
      cachedSession !== undefined &&
      sessionHasNativeIdentity(cachedSession)
    )
      void options.openSession(cachedSession.id, { skipSaveCurrent: true });
    else if (openDraft && stored !== undefined) {
      options.openDraft();
      void options.restoreSession(target.workspaceId, stored.selectedSessionId);
    } else if (openDraft && !keepSelected) options.openDraft();
    if (workspace !== undefined) void options.startWatch(target.workspaceId);
    if (restoreView || (!options.hasProfiles(target.nodeId) && !options.profilesLoading.value))
      void options.loadProfiles(target.nodeId);
    options.refreshTransport(target.nodeId);
    loading.value = true;
    void refresh(selected, current, workspace === undefined);
    return true;
  }

  async function refresh(
    target: WorkspaceTarget,
    current: () => boolean,
    startWatch: boolean
  ): Promise<void> {
    // One activation owns feedback for both independent metadata reads.
    const manifest = options.refreshManifest(target.nodeId).then(
      () => undefined,
      (error: unknown) => ({ error })
    );
    let workspaceConfirmed = false;
    try {
      const result = await options.request<{ workspaces: Workspace[] }>(
        `/api/workspaces?nodeId=${encodeURIComponent(target.nodeId)}`
      );
      if (!current()) return;
      options.cacheWorkspaces(target.nodeId, result.workspaces);
      const workspace = result.workspaces.find((candidate) => candidate.id === target.workspaceId);
      if (workspace === undefined) {
        options.invalidateWorkspace(target);
        options.notice(
          translate('generated.workbenchWorkspaceSelectionService.thisWorkspaceIsNoLongerInThe'),
          'error'
        );
        return;
      }
      options.replaceWorkspaces([...result.workspaces]);
      workspaceConfirmed = true;
      options.rememberWorkspace(target.nodeId, workspace);
      if (startWatch) void options.startWatch(target.workspaceId);
      const failure = await manifest;
      if (!current()) return;
      if (failure !== undefined) throw failure.error;
    } catch (error) {
      if (!current()) return;
      if (errorCode(error) === 'NETWORK_UNAVAILABLE' && options.isNetworkUnavailable()) return;
      if (errorCode(error) === 'NODE_OFFLINE' && !options.isHostAvailable(target.nodeId)) return;
      if (
        !workspaceConfirmed &&
        [
          'FORBIDDEN',
          'NODE_NOT_FOUND',
          'WORKSPACE_NOT_FOUND',
          'REQUEST_FAILED_403',
          'REQUEST_FAILED_404'
        ].includes(errorCode(error) ?? '')
      )
        options.invalidateWorkspace(target);
      else if (!options.workspaces.value.some((workspace) => workspace.id === target.workspaceId))
        return; // The existing Workspace recovery panel owns an uncached activation failure.
      options.notice(
        translate('generated.workbenchWorkspaceSelectionService.unableToLoadWorkspace', {
          value0: options.errorMessage(error)
        }),
        'error',
        error
      );
    } finally {
      if (current()) loading.value = false;
    }
  }

  return { select, clear, loading, currentSelectionRevision: revision.currentSelectionRevision };
}

/** A workspace selection owns its target before its cross-domain ports are connected. */
export function createWorkbenchWorkspaceSelection() {
  const state = createWorkbenchWorkspaceSelectionState();
  return {
    target: state.target,
    currentSelectionRevision: state.currentSelectionRevision,
    connect(
      options: Omit<WorkbenchWorkspaceSelectionOptions, 'workspaceTarget' | 'setWorkspaceTarget'>
    ) {
      return createWorkbenchWorkspaceSelectionService(
        {
          ...options,
          workspaceTarget: state.target,
          setWorkspaceTarget: state.setTarget
        },
        state
      );
    }
  };
}
