import type { WorkspaceTarget } from '../model/workbench.js';
import type { Ref } from 'vue';
import type {
  AgentRun,
  CachedSessionDetail,
  ConversationTurn,
  RunnerDefaultConfiguration,
  Session,
  WorkspaceQueue
} from '../model/workbench.js';
import type { createWorkspaceSessionPagingService } from './workspace-session-paging-service.js';
import {
  createWorkspaceViewCacheService,
  type WorkspaceCacheView
} from './workspace-view-cache-service.js';
import type { WorkspaceContentSearchSnapshot } from './workspace-content-search-service.js';
import type { WorkspaceFileTreeSnapshot } from './workspace-file-tree-service.js';
import type { WorkspaceGitSnapshot } from './workspace-git-service.js';
import type { WorkspaceSessionListSnapshot } from './workspace-session-service.js';
import type { WorkspaceFileWorkbenchSnapshot } from '../model/workspace-file-workbench.js';

interface WorkbenchWorkspaceCacheControllerOptions {
  readonly cacheService: ReturnType<typeof createWorkspaceViewCacheService>;
  readonly paging: ReturnType<typeof createWorkspaceSessionPagingService>;
  readonly sessions: Readonly<Ref<readonly Session[]>>;
  readonly sessionList?: {
    snapshot(): WorkspaceSessionListSnapshot;
    restore(snapshot: WorkspaceSessionListSnapshot | undefined): void;
  };
  readonly captureDetail: (sessionId: string) => CachedSessionDetail;
  readonly queue: Readonly<Ref<WorkspaceQueue>>;
  readonly runner: Readonly<Ref<Session['runner']>>;
  readonly modelId: Readonly<Ref<string>>;
  readonly effort: Readonly<Ref<RunnerDefaultConfiguration['effort']>>;
  readonly access: Readonly<Ref<RunnerDefaultConfiguration['access']>>;
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Ref<string | undefined>;
  readonly fileWorkbench: {
    snapshot(): WorkspaceFileWorkbenchSnapshot;
    restore(snapshot: WorkspaceFileWorkbenchSnapshot): void;
  };
  readonly search?: {
    snapshot(previous: WorkspaceContentSearchSnapshot | undefined): WorkspaceContentSearchSnapshot;
    restore(snapshot: WorkspaceContentSearchSnapshot | undefined): void;
  };
  readonly files?: {
    snapshot(): WorkspaceFileTreeSnapshot;
    restore(snapshot: WorkspaceFileTreeSnapshot | undefined): void;
  };
  readonly git?: {
    snapshot(): WorkspaceGitSnapshot;
    restore(snapshot: WorkspaceGitSnapshot | undefined): void;
  };
  readonly restoreDraftConfiguration: (configuration: RunnerDefaultConfiguration) => void;
  readonly persistDraft: () => void;
  readonly flushConversation: () => void;
  readonly tabId: (nodeId: string, workspaceId: string) => string;
  readonly maximumDetails: number;
  readonly otherVisibleSessionId?: () => string | undefined;
}

/** Owns capture and restoration of the Node + Workspace scoped view cache. */
function connectWorkspaceCache(options: WorkbenchWorkspaceCacheControllerOptions) {
  const workspaceViewCache = (nodeId: string, workspaceId: string) =>
    options.cacheService.view(nodeId, workspaceId);

  function discardWorkspaceViewCache(nodeId: string, workspaceId: string): void {
    options.cacheService.remove(nodeId, workspaceId);
    options.paging.remove(options.tabId(nodeId, workspaceId));
  }

  function discardNodeViewCaches(nodeId: string): void {
    options.cacheService.removeNode(nodeId);
    options.paging.removeNode(nodeId);
  }

  function saveCurrentWorkspaceView(): void {
    options.persistDraft();
    if (!options.cacheService.hasActive()) return;
    const sessionId = options.selectedSessionId.value;
    if (sessionId === undefined) options.flushConversation();
    options.cacheService.captureActive(
      {
        sessions: options.sessions.value,
        ...(options.sessionList === undefined
          ? {}
          : { sessionList: options.sessionList.snapshot() }),
        fileWorkbench: options.fileWorkbench.snapshot(),
        ...(options.search === undefined
          ? {}
          : {
              search: options.search.snapshot(
                options.workspaceTarget.value === undefined
                  ? undefined
                  : workspaceViewCache(
                      options.workspaceTarget.value.nodeId,
                      options.workspaceTarget.value.workspaceId
                    ).search
              )
            }),
        ...(options.files === undefined ? {} : { files: options.files.snapshot() }),
        ...(options.git === undefined ? {} : { git: options.git.snapshot() }),
        draft: {
          runner: options.runner.value,
          modelId: options.modelId.value,
          effort: options.effort.value,
          access: options.access.value
        },
        ...(sessionId === undefined
          ? {}
          : {
              selectedSessionId: sessionId,
              queue: options.queue.value,
              detail: options.captureDetail(sessionId),
              detailHistoryAlreadyBounded: true
            })
      },
      options.maximumDetails,
      options.otherVisibleSessionId?.()
    );
  }

  function restoreWorkspaceView(nodeId: string, workspaceId: string): void {
    if (
      options.workspaceTarget.value?.nodeId !== nodeId ||
      options.workspaceTarget.value.workspaceId !== workspaceId
    )
      return;
    const cached = workspaceViewCache(nodeId, workspaceId);
    options.sessionList?.restore(cached.sessionList);
    options.files?.restore(cached.files);
    options.git?.restore(cached.git);
    options.search?.restore(cached.search);
    const snapshot = cached.fileWorkbench;
    if (snapshot !== undefined) options.fileWorkbench.restore(snapshot);
  }

  function restoreWorkspaceDraft(cache: WorkspaceCacheView | undefined): void {
    const draft = cache?.draft;
    if (draft !== undefined) options.restoreDraftConfiguration(draft);
  }

  function cacheTarget(sessionId: string): { nodeId: string; workspaceId: string } | undefined {
    const session = options.sessions.value.find((candidate) => candidate.id === sessionId);
    const nodeId = options.workspaceTarget.value?.nodeId;
    if (session === undefined || nodeId === undefined) return undefined;
    return { nodeId, workspaceId: session.workspaceId };
  }

  function updateCachedContext(
    sessionId: string,
    context: CachedSessionDetail['contextUsage']
  ): void {
    const target = cacheTarget(sessionId);
    if (target !== undefined)
      options.cacheService.updateContext(target.nodeId, target.workspaceId, sessionId, context);
  }

  function syncCachedRunStatus(
    sessionId: string,
    runId: string,
    status: ConversationTurn['status']
  ): void {
    const target = cacheTarget(sessionId);
    if (target !== undefined)
      options.cacheService.syncRunStatus(
        target.nodeId,
        target.workspaceId,
        sessionId,
        runId,
        status
      );
  }

  const cacheRunSnapshotFor = (nodeId: string, workspaceId: string, run: AgentRun) =>
    options.cacheService.cacheRun(nodeId, workspaceId, run);

  function cacheRunSnapshot(run: AgentRun): void {
    const nodeId = options.workspaceTarget.value?.nodeId;
    if (run.sessionId === undefined || nodeId === undefined) return;
    const workspaceId =
      run.workspaceId ??
      options.sessions.value.find((session) => session.id === run.sessionId)?.workspaceId;
    if (workspaceId !== undefined) cacheRunSnapshotFor(nodeId, workspaceId, run);
  }

  function cacheConversationTurn(turn: ConversationTurn): void {
    const session = options.sessions.value.find((candidate) => candidate.id === turn.sessionId);
    const nodeId = options.workspaceTarget.value?.nodeId;
    if (session !== undefined && nodeId !== undefined)
      options.cacheService.cacheTurn(nodeId, session.workspaceId, turn);
  }

  function replaceConversationTurns(
    sessionId: string,
    turns: readonly ConversationTurn[],
    nextCursor: string | null
  ): void {
    const session = options.sessions.value.find((candidate) => candidate.id === sessionId);
    const nodeId = options.workspaceTarget.value?.nodeId;
    if (session !== undefined && nodeId !== undefined)
      options.cacheService.replaceTurns(nodeId, session.workspaceId, sessionId, turns, nextCursor);
  }

  return {
    workspaceViewCache,
    discardWorkspaceViewCache,
    discardNodeViewCaches,
    saveCurrentWorkspaceView,
    restoreWorkspaceView,
    restoreWorkspaceDraft,
    updateCachedContext,
    syncCachedRunStatus,
    cacheRunSnapshotFor,
    cacheRunSnapshot,
    cacheConversationTurn,
    replaceConversationTurns
  };
}

/** Owns the cache storage and connects its capture and restore ports once available. */
export function createWorkbenchWorkspaceCache(
  tabId: (nodeId: string, workspaceId: string) => string
) {
  const cache = createWorkspaceViewCacheService(tabId);
  return {
    cache,
    connect: (options: Omit<WorkbenchWorkspaceCacheControllerOptions, 'cacheService' | 'tabId'>) =>
      connectWorkspaceCache({ ...options, cacheService: cache, tabId })
  };
}
