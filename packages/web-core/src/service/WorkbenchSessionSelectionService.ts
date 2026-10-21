import type { WorkspaceTarget } from '../model/workbench.js';
import type { Ref } from 'vue';
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
import type { SessionContextUsage } from './ConversationStateService.js';
import { CONVERSATION_INITIAL_SEGMENT_LIMIT } from '../util/conversation-history.js';
import {
  parseConversationSegmentPage,
  segmentPageAsTurnPage
} from '../util/conversation-segments.js';
import { translate } from './LocalePreferenceService.js';
import { ApiError } from '../util/api-error.js';

interface OpenSessionOptions {
  readonly preserveMobileWorkspaceSurface?: boolean;
  readonly deferInitialScroll?: boolean;
  readonly skipSaveCurrent?: boolean;
  readonly markReadAfterOpen?: boolean;
}

export interface WorkbenchSessionSelectionOptions {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Ref<string | undefined>;
  readonly selectedRunId: Ref<string | undefined>;
  readonly sessions: Ref<Session[]>;
  readonly runs: Ref<AgentRun[]>;
  readonly turns: Ref<ConversationTurn[]>;
  readonly nextCursor: Ref<string | null>;
  readonly loadingInitial: Ref<boolean>;
  readonly initialLoadFailed: Ref<boolean>;
  readonly contextUsage: Ref<SessionContextUsage | null | undefined>;
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
  readonly restoreCachedDetail: (sessionId: string) => CachedSessionDetail | undefined;
  readonly cachedQueue: (nodeId: string, workspaceId: string, sessionId: string) => WorkspaceQueue;
  readonly restoreProjection: (turns: readonly ConversationTurn[]) => void;
  readonly resetProjection: () => void;
  readonly openRun: (runId: string) => void;
  readonly scrollLatest: () => Promise<void>;
  readonly beginInitialRender: () => Promise<void>;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly sessionPathId: (sessionId: string) => string;
  readonly replaceSession: (previousId: string, next: Session) => void;
  readonly canWatch: (session: Session) => boolean;
  readonly beginWatch: (sessionId: string) => Promise<void> | undefined;
  readonly applySnapshot: (sessionId: string, page: ConversationTurnPage) => boolean;
  readonly mergeTurns: (page: ConversationTurnPage) => boolean;
  readonly notice: (value: string) => void;
  readonly errorMessage: (error: unknown) => string;
}

const EMPTY_QUEUE: WorkspaceQueue = { version: 0, paused: false, items: [] };
export function createWorkbenchSessionSelectionService(options: WorkbenchSessionSelectionOptions) {
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
    options.selectedSessionId.value = sessionId;
    if (switching) {
      options.queue.value =
        options.workspaceTarget.value?.workspaceId === undefined
          ? EMPTY_QUEUE
          : options.cachedQueue(nodeId, options.workspaceTarget.value?.workspaceId, sessionId);
      options.applyComposerConfiguration(session, false);
      const cached = options.restoreCachedDetail(sessionId);
      options.selectedRunId.value = undefined;
      if (cached !== undefined) {
        options.restoreProjection(options.turns.value);
        const active = activeRun(options.runs.value, sessionId);
        if (active !== undefined) options.openRun(active.id);
        if (!openOptions.deferInitialScroll) void options.scrollLatest();
      } else {
        options.turns.value = [];
        options.nextCursor.value = null;
        options.resetProjection();
        options.contextUsage.value = undefined;
        options.runs.value = [];
      }
    }
    return { switching };
  }

  async function openSession(
    sessionId: string,
    openOptions: OpenSessionOptions = {}
  ): Promise<void> {
    const nodeId = options.workspaceTarget.value?.nodeId;
    const workspaceId = options.workspaceTarget.value?.workspaceId;
    if (nodeId === undefined) return;
    const requestId = options.nextRequest();
    options.loadingInitial.value = true;
    options.initialLoadFailed.value = false;
    const { switching } = prepare(sessionId, nodeId, openOptions);
    const isCurrent = () =>
      current(
        requestId,
        nodeId,
        sessionId,
        openOptions.markReadAfterOpen ? workspaceId : undefined
      );
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
      const initialRender = options.beginInitialRender();
      if (watchable) await options.beginWatch(sessionId);
      else {
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
      await initialRender;
      if (!isCurrent()) return;
      if (switching || changed || !openOptions.deferInitialScroll) {
        options.positioning.value = true;
        await options.scrollLatest();
      }
      options.positioning.value = false;
      if (openOptions.markReadAfterOpen && isCurrent())
        await options.markSessionRead(nodeId, workspaceId!, sessionResult.session.id);
    } catch (error) {
      if (!isCurrent()) return;
      options.positioning.value = false;
      options.initialLoadFailed.value = true;
      options.notice(
        translate('generated.workbenchSessionSelectionService.unableToLoadConversationHistory', {
          value0: options.errorMessage(error)
        })
      );
    } finally {
      if (isCurrent()) {
        options.loadingInitial.value = false;
      }
    }
  }

  async function selectSession(sessionId: string): Promise<void> {
    if (options.selectedSessionId.value === sessionId && !options.draftOpen.value) {
      options.closeMobileSurface();
      return;
    }
    await openSession(sessionId);
  }

  async function openWorkspaceTabSession(sessionId: string): Promise<void> {
    const target = options.workspaceTarget.value;
    if (target === undefined) return;
    if (options.selectedSessionId.value === sessionId && !options.draftOpen.value) {
      options.closeMobileSurface();
      if (options.loadingInitial.value) return;
      if (!options.initialLoadFailed.value) {
        await options.markSessionRead(target.nodeId, target.workspaceId, sessionId);
        return;
      }
    }
    await openSession(sessionId, { markReadAfterOpen: true });
  }

  return { openSession, selectSession, openWorkspaceTabSession };
}

function activeRun(runs: readonly AgentRun[], sessionId: string): AgentRun | undefined {
  return runs.find(
    (run) =>
      run.sessionId === sessionId && ['STARTING', 'RUNNING', 'CANCELLING'].includes(run.status)
  );
}
