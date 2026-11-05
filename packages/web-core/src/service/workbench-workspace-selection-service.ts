import type { MessageFeedback } from '../model/message-feedback.js';
import { ref, type Ref } from 'vue';
import type {
  Session,
  Workspace,
  WorkspaceTarget,
  NodeWorkbenchManifest
} from '../model/workbench.js';
import type { WorkspaceCacheView } from './workspace-view-cache-service.js';
import { translate } from './locale-preference-service.js';
import { errorCode } from '../util/api-error.js';
import { sessionHasNativeIdentity } from '../util/session-presentation.js';

interface WorkbenchWorkspaceSelectionOptions {
  readonly workspaceTarget: Ref<WorkspaceTarget | undefined>;
  readonly selectedSessionId: Ref<string | undefined>;
  readonly selectedRunId: Ref<string | undefined>;
  readonly workspaces: Ref<Workspace[]>;
  readonly sessions: Ref<Session[]>;
  readonly draftOpen: Ref<boolean>;
  readonly profilesLoading: Ref<boolean>;
  readonly manifest: Ref<NodeWorkbenchManifest | undefined>;
  readonly manifestLoading: Ref<boolean>;
  readonly hasNode: (nodeId: string) => boolean;
  readonly isHostAvailable: (nodeId: string) => boolean;
  readonly cachedWorkspaces: (nodeId: string) => readonly Workspace[];
  readonly cacheWorkspaces: (nodeId: string, values: readonly Workspace[]) => void;
  readonly rememberTarget: (target: WorkspaceTarget) => void;
  readonly invalidateWorkspace: (target: WorkspaceTarget) => void;
  readonly deactivateCache: () => void;
  readonly clearContent: () => void;
  readonly showWorkbench: () => void;
  readonly closeSidebar: () => void;
  readonly restoreProfiles: (nodeId: string) => void;
  readonly restoreManifest: (nodeId: string) => NodeWorkbenchManifest | undefined;
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
  options: WorkbenchWorkspaceSelectionOptions
) {
  let selectionRevision = 0;
  const loading = ref(false);

  function clear(): void {
    selectionRevision += 1;
    loading.value = false;
    options.stopWatch();
    options.deactivateCache();
    options.workspaceTarget.value = undefined;
    options.selectedSessionId.value = undefined;
    options.selectedRunId.value = undefined;
    options.workspaces.value = [];
    options.sessions.value = [];
    options.manifest.value = undefined;
    options.manifestLoading.value = false;
    options.draftOpen.value = false;
    options.clearContent();
    options.resetQueue();
  }

  async function select(target: WorkspaceTarget, openDraft = true): Promise<boolean> {
    if (!options.hasNode(target.nodeId)) {
      options.invalidateWorkspace(target);
      return false;
    }
    const revision = ++selectionRevision;
    loading.value = false;
    const previous = options.workspaceTarget.value;
    const switching =
      previous?.nodeId !== target.nodeId || previous.workspaceId !== target.workspaceId;
    if (switching) {
      options.saveCurrent();
      options.stopWatch();
      options.deactivateCache();
      options.selectedSessionId.value = undefined;
      options.selectedRunId.value = undefined;
      options.draftOpen.value = false;
      options.clearContent();
      options.workspaceTarget.value = { nodeId: target.nodeId, workspaceId: target.workspaceId };
      options.restoreProfiles(target.nodeId);
    }
    const selected = options.workspaceTarget.value!;
    const current = () =>
      selectionRevision === revision && options.workspaceTarget.value === selected;

    options.closeSidebar();
    options.showWorkbench();
    options.workspaces.value = [...options.cachedWorkspaces(target.nodeId)];
    const workspace = options.workspaces.value.find(
      (candidate) => candidate.id === target.workspaceId
    );
    if (workspace === undefined) options.rememberTarget(target);
    else options.rememberWorkspace(target.nodeId, workspace);

    if (!options.isHostAvailable(target.nodeId)) {
      options.stopWatch();
      options.deactivateCache();
      options.workspaces.value = [];
      options.sessions.value = [];
      options.selectedSessionId.value = undefined;
      options.selectedRunId.value = undefined;
      options.clearContent();
      options.manifest.value = undefined;
      options.manifestLoading.value = false;
      return true;
    }

    options.manifest.value = options.restoreManifest(target.nodeId);
    options.manifestLoading.value = options.manifest.value === undefined;
    const cache = options.viewCache(target.nodeId, target.workspaceId);
    const restoreView = switching || !options.isCacheActive(target.nodeId, target.workspaceId);
    if (restoreView) {
      options.activateCache(target.nodeId, target.workspaceId);
      options.restoreWorkspaceView(target.nodeId, target.workspaceId);
      if (cache.files !== undefined || cache.git !== undefined)
        options.refreshVisibleTool(target.nodeId, target.workspaceId);
      options.sessions.value = [...cache.sessions];
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
    void options.refreshManifest(target.nodeId);
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
      options.workspaces.value = [...result.workspaces];
      options.rememberWorkspace(target.nodeId, workspace);
      if (startWatch) void options.startWatch(target.workspaceId);
    } catch (error) {
      if (!current()) return;
      if (
        [
          'FORBIDDEN',
          'NODE_NOT_FOUND',
          'WORKSPACE_NOT_FOUND',
          'REQUEST_FAILED_403',
          'REQUEST_FAILED_404'
        ].includes(errorCode(error) ?? '')
      )
        options.invalidateWorkspace(target);
      options.notice(
        translate('generated.workbenchWorkspaceSelectionService.unableToLoadNodeWorkspaces', {
          value0: options.errorMessage(error)
        }),
        'error',
        error
      );
    } finally {
      if (current()) loading.value = false;
    }
  }

  return { select, clear, loading, currentSelectionRevision: () => selectionRevision };
}
