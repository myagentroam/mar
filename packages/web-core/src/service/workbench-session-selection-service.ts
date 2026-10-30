import type { MessageFeedback } from '../model/message-feedback.js';
import type { WorkspaceTarget } from '../model/workbench.js';
import { computed, nextTick, ref, type Ref } from 'vue';
import type {
  AgentRun,
  CachedSessionDetail,
  ConversationTurn,
  ConversationTurnPage,
  ConversationSegmentPage,
  RunnerCommand,
  Session,
  WorkspaceQueue
} from '../model/workbench.js';
import { CONVERSATION_INITIAL_SEGMENT_LIMIT } from '../util/conversation-history.js';
import {
  parseConversationSegmentPage,
  segmentPageAsTurnPage
} from '../util/conversation-segments.js';
import { translate } from './locale-preference-service.js';
import { ApiError, errorCode } from '../util/api-error.js';

export interface OpenSessionOptions {
  readonly throwOnFailure?: boolean;
  readonly preserveMobileWorkspaceSurface?: boolean;
  readonly deferInitialScroll?: boolean;
  readonly skipSaveCurrent?: boolean;
  readonly markReadAfterOpen?: boolean;
  readonly onSessionResolved?: (session: Session) => void;
}

interface OpeningSession {
  readonly requestId: number;
  readonly nodeId: string;
  readonly workspaceId: string | undefined;
  readonly sessionId: string;
  session?: Session;
  onSessionResolved?: (session: Session) => void;
  markRead: boolean;
}

export interface WorkbenchSessionSelectionOptions {
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
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly sessionPathId: (sessionId: string) => string;
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
  let opening: OpeningSession | undefined;
  const restoredContent = ref(false);
  let positioningRequest: number | undefined;
  const loadingInitialContent = computed(
    () => options.loadingInitial.value && !restoredContent.value
  );
  function current(
    requestId: number,
    nodeId: string,
    sessionId: string,
    workspaceId?: string
  ): boolean {
    return (
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
    if (activeRunId !== undefined) options.openRun(activeRunId);
    return { switching, restored };
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
        options.positioning.value = false;
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
    const requestId = options.nextRequest();
    const operation: OpeningSession = {
      requestId,
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
    const { switching, restored } = prepare(sessionId, nodeId, openOptions);
    const hasContent = options.turns.value.some((turn) => turn.items.length > 0);
    // Cached content stays readable; Watch synchronization has its own status.
    restoredContent.value = hasContent;
    const isCurrent = () =>
      current(
        requestId,
        nodeId,
        sessionId,
        openOptions.markReadAfterOpen ? workspaceId : undefined
      );
    const cachedPositioning =
      restored && hasContent && !openOptions.deferInitialScroll
        ? positionRestoredContent(requestId, isCurrent)
        : undefined;
    try {
      const encodedId = options.sessionPathId(sessionId);
      const sessionResult = await options.request<{ session: Session }>(
        `/api/agent-sessions/${encodedId}?nodeId=${encodeURIComponent(nodeId)}`
      );
      if (!isCurrent()) return;
      if (openOptions.markReadAfterOpen && sessionResult.session.workspaceId !== workspaceId)
        throw new ApiError(
          'SESSION_NOT_FOUND',
          'The session does not belong to the selected Workspace.'
        );
      openOptions.onSessionResolved?.(sessionResult.session);
      operation.session = sessionResult.session;
      operation.onSessionResolved?.(sessionResult.session);
      const active = activeRun(options.runs.value, sessionResult.session.id);
      options.replaceSession(sessionId, sessionResult.session);
      options.applyComposerConfiguration(sessionResult.session, true);
      if (active !== undefined) {
        options.sessions.value = options.sessions.value.map((candidate) =>
          candidate.id === sessionResult.session.id
            ? { ...candidate, activity: 'MANAGED_ACTIVE' }
            : candidate
        );
        options.openRun(active.id);
      }
      const watchable = options.canWatch(sessionResult.session);
      let page: ConversationTurnPage | undefined;
      if (watchable) {
        const loaded = await options.beginWatch(sessionId);
        if (!loaded)
          throw new ApiError(
            'SESSION_HISTORY_INITIAL_FAILED',
            'The initial session snapshot has not been applied.'
          );
      } else {
        const segmentPage = await options.request<ConversationSegmentPage | ConversationTurnPage>(
          `/api/agent-sessions/${encodedId}/turns?nodeId=${encodeURIComponent(nodeId)}&limit=${CONVERSATION_INITIAL_SEGMENT_LIMIT}&unit=SEGMENT`
        );
        page = parseConversationSegmentPage(segmentPage) ?? segmentPageAsTurnPage(segmentPage);
      }
      if (!isCurrent()) return;
      const changed =
        page === undefined || watchable
          ? false
          : active === undefined
            ? options.applySnapshot(sessionResult.session.id, page)
            : options.mergeTurns(page);
      options.saveCurrent();
      if (!hasContent) await options.beginInitialRender();
      if (!isCurrent()) return;
      // Restored content was already positioned; synchronization must not interrupt reading.
      if (!hasContent && (switching || changed || !openOptions.deferInitialScroll)) {
        options.positioning.value = true;
        await options.scrollLatest();
      }
      await cachedPositioning;
      if (!isCurrent()) return;
      options.positioning.value = false;
      if (
        (openOptions.markReadAfterOpen || operation.markRead) &&
        sessionResult.session.workspaceId === workspaceId &&
        current(requestId, nodeId, sessionId, workspaceId)
      )
        void Promise.resolve(
          options.markSessionRead(nodeId, workspaceId!, sessionResult.session.id)
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
    if (options.selectedSessionId.value === sessionId && !options.draftOpen.value) {
      options.closeMobileSurface();
      if (options.loadingInitial.value) {
        if (
          opening?.requestId === options.currentRequest() &&
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

  return { openSession, selectSession, openWorkspaceTabSession, loadingInitialContent };
}

function activeRun(runs: readonly AgentRun[], sessionId: string): AgentRun | undefined {
  return runs.find(
    (run) =>
      run.sessionId === sessionId && ['STARTING', 'RUNNING', 'CANCELLING'].includes(run.status)
  );
}
