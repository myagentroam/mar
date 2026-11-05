import { getCurrentScope, watch, type Ref } from 'vue';
import type { AgentRun, ConversationTurnPage, Session } from '../model/workbench.js';
import { ApiError } from '../util/api-error.js';
import { errorCode } from '../util/api-error.js';
import type { DraftTarget } from './session-draft-service.js';

/** Loads one Pane's session and initial conversation through its existing reader and Watch. */
export function createWorkspaceSessionPaneLoader(options: {
  readonly runs: Readonly<Ref<readonly AgentRun[]>>;
  readonly readSession: (nodeId: string, sessionId: string) => Promise<{ session: Session }>;
  readonly readInitialHistory: (nodeId: string, sessionId: string) => Promise<ConversationTurnPage>;
  readonly replaceSession: (previousId: string, session: Session) => void;
  readonly applyComposerConfiguration: (session: Session, authoritative: boolean) => void;
  readonly markActive: (session: Session) => void;
  readonly openRun: (runId: string) => void;
  readonly canWatch: (session: Session) => boolean;
  readonly beginWatch: (sessionId: string) => Promise<boolean>;
  readonly applySnapshot: (sessionId: string, page: ConversationTurnPage) => boolean;
  readonly mergeTurns: (page: ConversationTurnPage) => boolean;
  readonly saveCurrent: () => void;
}) {
  async function load(input: {
    readonly nodeId: string;
    readonly workspaceId: string | undefined;
    readonly sessionId: string;
    readonly isCurrent: () => boolean;
    readonly onResolved: (session: Session) => void;
  }): Promise<{ readonly session: Session; readonly changed: boolean } | undefined> {
    const result = await options.readSession(input.nodeId, input.sessionId);
    if (!input.isCurrent()) return undefined;
    if (input.workspaceId !== undefined && result.session.workspaceId !== input.workspaceId)
      throw new ApiError(
        'SESSION_NOT_FOUND',
        'The session does not belong to the selected Workspace.'
      );
    input.onResolved(result.session);
    if (!input.isCurrent()) return undefined;
    const active = options.runs.value.find(
      (run) =>
        run.sessionId === result.session.id &&
        ['STARTING', 'RUNNING', 'CANCELLING'].includes(run.status)
    );
    options.replaceSession(input.sessionId, result.session);
    options.applyComposerConfiguration(result.session, true);
    if (active !== undefined) {
      options.markActive(result.session);
      options.openRun(active.id);
    }
    if (!input.isCurrent()) return undefined;
    const watchable = options.canWatch(result.session);
    let page: ConversationTurnPage | undefined;
    if (watchable) {
      if (!(await options.beginWatch(input.sessionId)))
        throw new ApiError(
          'SESSION_HISTORY_INITIAL_FAILED',
          'The initial session snapshot has not been applied.'
        );
    } else page = await options.readInitialHistory(input.nodeId, input.sessionId);
    if (!input.isCurrent()) return undefined;
    const changed =
      page === undefined
        ? false
        : active === undefined
          ? options.applySnapshot(result.session.id, page)
          : options.mergeTurns(page);
    options.saveCurrent();
    return { session: result.session, changed };
  }
  return { load };
}

/** Coordinates one visible secondary Pane using its existing reader, Watch and target lifecycle. */
export function createWorkspaceSessionPaneLifecycle(options: {
  readonly target: Readonly<Ref<DraftTarget | undefined>>;
  readonly visible: Readonly<Ref<boolean>>;
  readonly loading: Ref<boolean>;
  readonly loadingContent: Ref<boolean>;
  readonly failed: Ref<boolean>;
  readonly failureCause: Ref<unknown>;
  readonly currentRequest: () => number;
  readonly loader: ReturnType<typeof createWorkspaceSessionPaneLoader>;
  readonly restore: (target: Extract<DraftTarget, { kind: 'session' }>) => boolean;
  readonly save: () => void;
  readonly cancel: () => void;
  readonly stopWatch: () => void;
  readonly beginInitialRender: () => Promise<void>;
  readonly scrollElement: () => HTMLElement | undefined;
  readonly scrollLatest: (isCurrent: () => boolean) => Promise<void>;
  readonly markRead: (
    nodeId: string,
    workspaceId: string,
    sessionId: string
  ) => Promise<void> | void;
}) {
  const scope = getCurrentScope();
  let reload: (() => Promise<void>) | undefined;
  let renderedTarget: Extract<DraftTarget, { kind: 'session' }> | undefined;
  let renderedElement: HTMLElement | undefined;
  const stop = watch(
    [
      () => options.target.value?.kind,
      () => options.target.value?.nodeId,
      () => options.target.value?.workspaceId,
      () => (options.target.value?.kind === 'session' ? options.target.value.sessionId : undefined),
      options.visible
    ],
    ([_kind, _nodeId, _workspaceId, _sessionId, visible], _previous, onCleanup) => {
      const target = options.target.value;
      if (
        renderedTarget !== undefined &&
        (target?.kind !== 'session' ||
          renderedTarget.nodeId !== target.nodeId ||
          renderedTarget.workspaceId !== target.workspaceId ||
          renderedTarget.sessionId !== target.sessionId)
      ) {
        renderedTarget = undefined;
        renderedElement = undefined;
      }
      if (!visible || target?.kind !== 'session') return;
      const captured = { ...target };
      const revision = options.currentRequest();
      let cancelled = false;
      const sameTarget = () => {
        const now = options.target.value;
        return (
          !cancelled &&
          (scope === undefined || scope.active) &&
          now?.kind === 'session' &&
          now.nodeId === captured.nodeId &&
          now.workspaceId === captured.workspaceId &&
          now.sessionId === captured.sessionId &&
          options.currentRequest() === revision
        );
      };
      const current = () => sameTarget() && options.visible.value;
      onCleanup(() => {
        if (sameTarget()) options.save();
        cancelled = true;
        options.cancel();
        options.stopWatch();
        options.loading.value = false;
        options.loadingContent.value = false;
        reload = undefined;
      });
      const run = async () => {
        options.loading.value = true;
        const restored = options.restore(captured);
        options.loadingContent.value = !restored;
        options.failed.value = false;
        options.failureCause.value = undefined;
        try {
          const result = await options.loader.load({
            ...captured,
            isCurrent: current,
            onResolved: () => {}
          });
          if (!current() || result === undefined) return;
          await options.beginInitialRender();
          if (!current()) return;
          const element = options.scrollElement();
          const preservePosition =
            restored &&
            element !== undefined &&
            element === renderedElement &&
            renderedTarget?.nodeId === captured.nodeId &&
            renderedTarget.workspaceId === captured.workspaceId &&
            renderedTarget.sessionId === captured.sessionId;
          if (!preservePosition) await options.scrollLatest(current);
          if (!current()) return;
          renderedTarget = captured;
          renderedElement = element;
          await options.markRead(captured.nodeId, captured.workspaceId, captured.sessionId);
        } catch (error) {
          if (current() && errorCode(error) !== 'WATCH_CANCELLED') {
            options.failed.value = true;
            options.failureCause.value = error;
          }
        } finally {
          if (current()) {
            options.loading.value = false;
            options.loadingContent.value = false;
          }
        }
      };
      let pending: Promise<void> | undefined;
      reload = () => {
        if (!current()) return Promise.resolve();
        if (pending !== undefined) return pending;
        const operation = run();
        pending = operation;
        void operation.finally(() => {
          if (pending === operation) pending = undefined;
        });
        return operation;
      };
      void reload();
    },
    { immediate: true, flush: 'sync' }
  );
  return { reload: () => reload?.() ?? Promise.resolve(), stop };
}
