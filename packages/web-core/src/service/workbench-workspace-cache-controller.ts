import type { WorkspaceTarget } from '../model/workbench.js';
import { nextTick, type Ref } from 'vue';
import type {
  AgentRun,
  CachedSessionDetail,
  ConversationTurn,
  ComposerSkillToken,
  RunnerDefaultConfiguration,
  Session,
  WorkspaceQueue
} from '../model/workbench.js';
import type { createWorkspaceSessionPagingService } from './workspace-session-paging-service.js';
import type {
  createWorkspaceViewCacheService,
  WorkspaceCacheView
} from './workspace-view-cache-service.js';
import type { SessionContextUsage } from './conversation-state-service.js';
import type { WorkspaceInspectorHandle } from './workbench-surface-state-service.js';
export type { WorkspaceInspectorHandle } from './workbench-surface-state-service.js';

interface WorkbenchWorkspaceCacheControllerOptions {
  readonly cacheService: ReturnType<typeof createWorkspaceViewCacheService>;
  readonly paging: ReturnType<typeof createWorkspaceSessionPagingService>;
  readonly sessions: Ref<Session[]>;
  readonly runs: Readonly<Ref<readonly AgentRun[]>>;
  readonly turns: Readonly<Ref<readonly ConversationTurn[]>>;
  readonly nextCursor: Readonly<Ref<string | null>>;
  readonly contextUsage: Readonly<Ref<SessionContextUsage | null | undefined>>;
  readonly queue: Ref<WorkspaceQueue>;
  readonly draftOpen: Ref<boolean>;
  readonly input: Ref<string>;
  readonly skillTokens: Ref<readonly ComposerSkillToken[]>;
  readonly references?: Ref<readonly import('@myagentroam/protocol').ComposerReference[]>;
  readonly runner: Readonly<Ref<Session['runner']>>;
  readonly modelId: Readonly<Ref<string>>;
  readonly effort: Readonly<Ref<RunnerDefaultConfiguration['effort']>>;
  readonly access: Readonly<Ref<RunnerDefaultConfiguration['access']>>;
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Ref<string | undefined>;
  readonly inspector: Ref<WorkspaceInspectorHandle | null | undefined>;
  readonly restoreDraftConfiguration: (configuration: RunnerDefaultConfiguration) => void;
  readonly persistDraft: () => void;
  readonly flushConversation: () => void;
  readonly tabId: (nodeId: string, workspaceId: string) => string;
  readonly maximumDetails: number;
}

/** Owns capture and restoration of the Node + Workspace scoped view cache. */
export function createWorkbenchWorkspaceCacheController(
  options: WorkbenchWorkspaceCacheControllerOptions
) {
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
    options.flushConversation();
    options.cacheService.captureActive(
      {
        sessions: options.sessions.value,
        ...(options.inspector.value == null
          ? {}
          : { inspector: options.inspector.value.snapshot() }),
        draft: {
          input: options.input.value,
          skillTokens: options.skillTokens.value,
          references: options.references?.value ?? [],
          runner: options.runner.value,
          modelId: options.modelId.value,
          effort: options.effort.value,
          access: options.access.value
        },
        ...(options.selectedSessionId.value === undefined
          ? {}
          : {
              selectedSessionId: options.selectedSessionId.value,
              queue: options.queue.value,
              detail: {
                sessionId: options.selectedSessionId.value,
                runs: options.runs.value,
                // Conversation projection already owns the bounded immutable window. Re-running
                // its JSON-size limiter here blocks Workspace switches during a long active Run.
                turns: options.turns.value,
                nextCursor: options.nextCursor.value,
                contextUsage: options.contextUsage.value ?? null,
                lastAccessedAt: Date.now()
              } as CachedSessionDetail,
              detailHistoryAlreadyBounded: true
            })
      },
      options.maximumDetails
    );
  }

  function restoreWorkspaceInspector(nodeId: string, workspaceId: string): void {
    const snapshot = workspaceViewCache(nodeId, workspaceId).inspector;
    if (snapshot === undefined) return;
    const inspector = options.inspector.value;
    if (inspector != null) {
      inspector.restoreWorkspace(nodeId, workspaceId, snapshot);
      return;
    }
    void nextTick(() => {
      if (
        options.workspaceTarget.value?.nodeId === nodeId &&
        options.workspaceTarget.value?.workspaceId === workspaceId
      )
        options.inspector.value?.restore(snapshot);
    });
  }

  function restoreWorkspaceDraft(cache: WorkspaceCacheView | undefined): void {
    const draft = cache?.draft;
    if (draft === undefined) {
      options.input.value = '';
      options.skillTokens.value = [];
      if (options.references !== undefined) options.references.value = [];
      return;
    }
    options.restoreDraftConfiguration(draft);
    options.input.value = draft.input;
    options.skillTokens.value = draft.skillTokens;
    if (options.references !== undefined) options.references.value = draft.references ?? [];
  }

  function restoreCachedSessionDetail(
    sessionId: string
  ): Readonly<CachedSessionDetail> | undefined {
    const nodeId = options.workspaceTarget.value?.nodeId;
    const workspaceId = options.workspaceTarget.value?.workspaceId;
    if (nodeId === undefined || workspaceId === undefined) return undefined;
    const detail = options.cacheService.touchDetail(nodeId, workspaceId, sessionId);
    return detail;
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
    restoreWorkspaceInspector,
    restoreWorkspaceDraft,
    restoreCachedSessionDetail,
    updateCachedContext,
    syncCachedRunStatus,
    cacheRunSnapshotFor,
    cacheRunSnapshot,
    cacheConversationTurn,
    replaceConversationTurns
  };
}
