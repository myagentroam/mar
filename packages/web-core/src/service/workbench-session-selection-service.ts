import type { MessageFeedback } from '../model/message-feedback.js';
import type { WorkspaceTarget } from '../model/workbench.js';
import type { AsideSession } from './workbench-aside-service.js';
import type { createWorkspaceSessionPaneLoader } from './workspace-session-pane-loader.js';
import { computed, getCurrentScope, nextTick, ref, type Ref } from 'vue';
import type {
  AgentRun,
  CachedSessionDetail,
  ConversationTurn,
  ConversationTurnPage,
  RunnerCommand,
  Session,
  WorkspaceQueue
} from '../model/workbench.js';
import { translate } from './locale-preference-service.js';
import { errorCode } from '../util/api-error.js';
import type { createWorkbenchAsideService } from './workbench-aside-service.js';

export interface OpenSessionOptions {
  readonly throwOnFailure?: boolean;
  readonly preserveMobileWorkspaceSurface?: boolean;
  readonly deferInitialScroll?: boolean;
  readonly skipSaveCurrent?: boolean;
  readonly markReadAfterOpen?: boolean;
  readonly onSessionResolved?: (session: Session) => void;
}

interface OpeningSession {
  requestId: number;
  preparing: boolean;
  readonly nodeId: string;
  readonly workspaceId: string | undefined;
  readonly sessionId: string;
  session?: Session;
  onSessionResolved?: (session: Session) => void;
  markRead: boolean;
}

export interface WorkbenchSessionSelectionOptions {
  readonly aside: ReturnType<typeof createWorkbenchAsideService>;
  readonly canOpenAside: () => boolean;
  readonly saveAside: () => void;
  readonly focusMain: () => void;
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Ref<string | undefined>;
  readonly selectedRunId: Ref<string | undefined>;
  readonly sessions: Ref<Session[]>;
  readonly runs: Readonly<Ref<readonly AgentRun[]>>;
  readonly turns: Readonly<Ref<readonly ConversationTurn[]>>;
  readonly loadingInitial: Ref<boolean>;
  readonly initialLoadFailed: Ref<boolean>;
  readonly queue: Ref<WorkspaceQueue>;
  readonly positioning: Ref<boolean>;
  readonly draftOpen: Ref<boolean>;
  readonly composerMode: Ref<'message' | 'steer'>;
  readonly selectedCommand: Ref<RunnerCommand | undefined>;
  readonly commandPickerOpen: Ref<boolean>;
  readonly nextRequest: () => number;
  readonly currentRequest: () => number;
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
  readonly applyComposerConfiguration: (
    session: Session | undefined,
    authoritative?: boolean
  ) => void;
  readonly restoreCachedDetail: (sessionId: string) => Readonly<CachedSessionDetail> | undefined;
  readonly cachedQueue: (nodeId: string, workspaceId: string, sessionId: string) => WorkspaceQueue;
  readonly installCachedDetail: (detail: Readonly<CachedSessionDetail>) => void;
  readonly clearActiveContent: () => void;
  readonly openRun: (runId: string) => void;
  readonly scrollLatest: () => Promise<void>;
  readonly beginInitialRender: () => Promise<void>;
  readonly createPaneLoader: (
    projection: Omit<
      Parameters<typeof createWorkspaceSessionPaneLoader>[0],
      'runs' | 'readSession' | 'readInitialHistory'
    >
  ) => ReturnType<typeof createWorkspaceSessionPaneLoader>;
  readonly replaceSession: (previousId: string, next: Session) => void;
  readonly canWatch: (session: Session) => boolean;
  readonly hasInitialSnapshot: (sessionId: string) => boolean;
  readonly beginWatch: (sessionId: string) => Promise<boolean>;
  readonly applySnapshot: (sessionId: string, page: ConversationTurnPage) => boolean;
  readonly mergeTurns: (page: ConversationTurnPage) => boolean;
  readonly notice: MessageFeedback;
  readonly errorMessage: (error: unknown) => string;
}

const EMPTY_QUEUE: WorkspaceQueue = { version: 0, paused: false, items: [] };
export function createWorkbenchSessionSelectionService(options: WorkbenchSessionSelectionOptions) {
  const scope = getCurrentScope();
  const paneLoader = options.createPaneLoader({
    replaceSession: (id, session) => options.replaceSession(id, session),
    applyComposerConfiguration: (session, authoritative) =>
      options.applyComposerConfiguration(session, authoritative),
    markActive: (session) => {
      options.sessions.value = options.sessions.value.map((candidate) =>
        candidate.id === session.id && candidate.workspaceId === session.workspaceId
          ? { ...candidate, activity: 'MANAGED_ACTIVE' }
          : candidate
      );
    },
    openRun: (id) => options.openRun(id),
    canWatch: (session) => options.canWatch(session),
    beginWatch: (id) => options.beginWatch(id),
    applySnapshot: (id, page) => options.applySnapshot(id, page),
    mergeTurns: (page) => options.mergeTurns(page),
    saveCurrent: () => options.saveCurrent()
  });
  let opening: OpeningSession | undefined;
  const restoredContent = ref(false);
  let positioningRequest: number | undefined;
  const loadingInitialContent = computed(
    () => options.loadingInitial.value && !restoredContent.value
  );
  function promoteAside(sessionId: string): void {
    const workspace = options.workspaceTarget.value;
    if (workspace === undefined || !options.aside.current(workspace).sessions.includes(sessionId))
      return;
    const session = options.sessions.value.find((candidate) => candidate.id === sessionId);
    if (session !== undefined && session.workspaceId !== workspace.workspaceId) return;
    options.saveAside();
    options.aside.closeSession({ ...workspace, sessionId });
  }

  function openAsideSession(target: AsideSession): boolean {
    const workspace = options.workspaceTarget.value;
    if (workspace?.nodeId !== target.nodeId || workspace.workspaceId !== target.workspaceId)
      return false;
    const { sessionId } = target;
    if (!options.draftOpen.value && options.selectedSessionId.value === sessionId) {
      options.focusMain();
      return true;
    }
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
    if (!options.draftOpen.value && options.selectedSessionId.value === nextSessionId) {
      options.aside.closeSession(target);
      options.focusMain();
      return true;
    }
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
  function current(
    requestId: number,
    nodeId: string,
    sessionId: string,
    workspaceId?: string
  ): boolean {
    return (
      (scope === undefined || scope.active) &&
      requestId === options.currentRequest() &&
      options.workspaceTarget.value?.nodeId === nodeId &&
      (workspaceId === undefined || options.workspaceTarget.value.workspaceId === workspaceId) &&
      options.selectedSessionId.value === sessionId
    );
  }

  function prepare(sessionId: string, nodeId: string, openOptions: OpenSessionOptions) {
    if (!openOptions.preserveMobileWorkspaceSurface) options.closeMobileSurface();
    const switching = options.selectedSessionId.value !== sessionId;
    let restored = false;
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
    options.draftOpen.value = false;
    if (switching) {
      options.composerMode.value = 'message';
      options.selectedCommand.value = undefined;
      options.commandPickerOpen.value = false;
    }
    let activeRunId: string | undefined;
    if (switching) {
      // Detach the old identity before replacing its projection. Synchronous observers must not
      // associate the previous window with the new Session during this handoff.
      options.selectedSessionId.value = undefined;
      options.queue.value =
        options.workspaceTarget.value?.workspaceId === undefined
          ? EMPTY_QUEUE
          : options.cachedQueue(nodeId, options.workspaceTarget.value?.workspaceId, sessionId);
      options.applyComposerConfiguration(session, false);
      const cached = options.restoreCachedDetail(sessionId);
      options.selectedRunId.value = undefined;
      if (cached !== undefined) {
        restored = true;
        options.installCachedDetail(cached);
        const active = activeRun(options.runs.value, sessionId);
        activeRunId = active?.id;
      } else {
        options.clearActiveContent();
      }
    }
    options.selectedSessionId.value = sessionId;
    return { switching, restored, activeRunId };
  }

  async function positionRestoredContent(
    requestId: number,
    isCurrent: () => boolean
  ): Promise<void> {
    positioningRequest = requestId;
    options.positioning.value = true;
    try {
      // The shared scroll element may still contain the previous conversation.
      await nextTick();
      if (isCurrent() && options.positioning.value) await options.scrollLatest();
    } finally {
      if (positioningRequest === requestId) {
        positioningRequest = undefined;
        if (scope?.active !== false) options.positioning.value = false;
      }
    }
  }

  async function openSession(
    sessionId: string,
    openOptions: OpenSessionOptions = {}
  ): Promise<void> {
    const nodeId = options.workspaceTarget.value?.nodeId;
    const workspaceId = options.workspaceTarget.value?.workspaceId;
    if (nodeId === undefined) return;
    promoteAside(sessionId);
    const initialRequestId = options.nextRequest();
    const operation: OpeningSession = {
      requestId: initialRequestId,
      preparing: true,
      nodeId,
      workspaceId,
      sessionId,
      markRead: false
    };
    opening = operation;
    positioningRequest = undefined;
    options.positioning.value = false;
    options.loadingInitial.value = true;
    options.initialLoadFailed.value = false;
    const { switching, restored, activeRunId } = prepare(sessionId, nodeId, openOptions);
    operation.preparing = false;
    if (opening !== operation) return;
    if (
      options.workspaceTarget.value?.nodeId !== nodeId ||
      options.selectedSessionId.value !== sessionId
    ) {
      opening = undefined;
      return;
    }
    const requestId = options.currentRequest();
    operation.requestId = requestId;
    const readWorkspaceId = options.workspaceTarget.value?.workspaceId;
    if (activeRunId !== undefined) options.openRun(activeRunId);
    const hasContent = options.turns.value.some((turn) => turn.items.length > 0);
    // Cached content stays readable; Watch synchronization has its own status.
    restoredContent.value = hasContent;
    const isCurrent = () => current(requestId, nodeId, sessionId, readWorkspaceId);
    const cachedPositioning =
      restored && hasContent && !openOptions.deferInitialScroll
        ? positionRestoredContent(requestId, isCurrent)
        : undefined;
    try {
      const loaded = await paneLoader.load({
        nodeId,
        workspaceId: readWorkspaceId,
        sessionId,
        isCurrent,
        onResolved: (session) => {
          openOptions.onSessionResolved?.(session);
          if (!isCurrent()) return;
          operation.session = session;
          operation.onSessionResolved?.(session);
        }
      });
      if (loaded === undefined || !isCurrent()) return;
      if (!hasContent) await options.beginInitialRender();
      if (!isCurrent()) return;
      // Restored content was already positioned; synchronization must not interrupt reading.
      if (!hasContent && (switching || loaded.changed || !openOptions.deferInitialScroll)) {
        options.positioning.value = true;
        await options.scrollLatest();
      }
      await cachedPositioning;
      if (!isCurrent()) return;
      options.positioning.value = false;
      if (
        (openOptions.markReadAfterOpen || operation.markRead) &&
        loaded.session.workspaceId === workspaceId &&
        current(requestId, nodeId, sessionId, workspaceId)
      )
        void Promise.resolve(
          options.markSessionRead(nodeId, workspaceId!, loaded.session.id)
        ).catch(() => undefined);
    } catch (error) {
      await cachedPositioning;
      if (!isCurrent()) return;
      options.positioning.value = false;
      if (errorCode(error) === 'WATCH_CANCELLED') {
        if (openOptions.throwOnFailure) throw error;
        return;
      }
      options.initialLoadFailed.value = true;
      if (openOptions.throwOnFailure) throw error;
      options.notice(
        translate('generated.workbenchSessionSelectionService.unableToLoadConversationHistory', {
          value0: options.errorMessage(error)
        }),
        'error',
        error
      );
    } finally {
      if (opening === operation) opening = undefined;
      if (isCurrent()) {
        options.loadingInitial.value = false;
      }
    }
  }

  async function selectSession(sessionId: string): Promise<void> {
    await openWorkspaceTabSession(sessionId);
  }

  async function openWorkspaceTabSession(
    sessionId: string,
    onSessionResolved?: (session: Session) => void
  ): Promise<void> {
    const target = options.workspaceTarget.value;
    if (target === undefined) return;
    promoteAside(sessionId);
    if (options.selectedSessionId.value === sessionId && !options.draftOpen.value) {
      options.closeMobileSurface();
      if (options.loadingInitial.value) {
        if (
          (opening?.preparing === true || opening?.requestId === options.currentRequest()) &&
          opening.nodeId === target.nodeId &&
          opening.workspaceId === target.workspaceId &&
          opening.sessionId === sessionId
        ) {
          if (onSessionResolved !== undefined) {
            if (opening.session !== undefined) onSessionResolved(opening.session);
            else opening.onSessionResolved = onSessionResolved;
          }
          opening.markRead = true;
        }
        return;
      }
      if (!options.initialLoadFailed.value && options.hasInitialSnapshot(sessionId)) {
        const session = options.sessions.value.find(
          (item) => item.id === sessionId && item.workspaceId === target.workspaceId
        );
        if (session === undefined && onSessionResolved !== undefined) {
          await openSession(sessionId, { markReadAfterOpen: true, onSessionResolved });
          return;
        }
        if (session !== undefined) onSessionResolved?.(session);
        void Promise.resolve(
          options.markSessionRead(target.nodeId, target.workspaceId, sessionId)
        ).catch(() => undefined);
        return;
      }
    }
    await openSession(sessionId, {
      markReadAfterOpen: true,
      ...(onSessionResolved === undefined ? {} : { onSessionResolved })
    });
  }

  return {
    openSession,
    selectSession,
    openWorkspaceTabSession,
    openAsideSession,
    closeAsideSession,
    replaceAsideSession,
    removeMissingAside,
    loadingInitialContent
  };
}

function activeRun(runs: readonly AgentRun[], sessionId: string): AgentRun | undefined {
  return runs.find(
    (run) =>
      run.sessionId === sessionId && ['STARTING', 'RUNNING', 'CANCELLING'].includes(run.status)
  );
}
