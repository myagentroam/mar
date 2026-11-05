import { computed, getCurrentScope, nextTick, ref, watch, type Ref } from 'vue';
import type { AgentRun, ConversationTurnPage, Session } from '../model/workbench.js';
import { ApiError } from '../util/api-error.js';

export function createWorkspaceSessionPaneWatchGate<
  T extends { readonly sessionId?: string }
>(options: {
  readonly target: () => T | undefined;
  readonly revision: () => number;
  readonly visible: () => boolean;
  readonly waitReady: () => Promise<boolean>;
  readonly begin: (sessionId: string) => Promise<boolean>;
}) {
  return async (sessionId: string): Promise<boolean> => {
    const target = options.target();
    const revision = options.revision();
    if (
      !(await options.waitReady()) ||
      target === undefined ||
      target !== options.target() ||
      target.sessionId !== sessionId ||
      revision !== options.revision() ||
      !options.visible()
    )
      throw new ApiError('WATCH_CANCELLED', 'The session selection was stopped or replaced.');
    return options.begin(sessionId);
  };
}
import { errorCode } from '../util/api-error.js';
import type { DraftTarget } from './session-draft-service.js';

/** Owns the initial-content and positioning state for one Pane. */
export function createWorkspaceSessionPaneRenderLifecycle(options: {
  readonly loading: Ref<boolean>;
  readonly failed: Ref<boolean>;
  readonly failureCause: Ref<unknown>;
  readonly positioning?: Ref<boolean>;
  readonly content?: { readonly hasContent: () => boolean; readonly openRun: (id: string) => void };
  readonly beginInitialRender: () => Promise<void>;
  readonly scrollLatest: (isCurrent: () => boolean) => Promise<void>;
}) {
  const scope = getCurrentScope();
  const positioning = options.positioning ?? ref(false);
  const restoredContent = ref(false);
  let positioningRequest: number | undefined;
  function begin(): void {
    positioningRequest = undefined;
    positioning.value = false;
    options.loading.value = true;
    options.failed.value = false;
    options.failureCause.value = undefined;
  }
  async function positionRestored(requestId: number, isCurrent: () => boolean): Promise<void> {
    positioningRequest = requestId;
    positioning.value = true;
    try {
      await nextTick();
      if (isCurrent() && positioning.value) await options.scrollLatest(isCurrent);
    } finally {
      if (positioningRequest === requestId) {
        positioningRequest = undefined;
        if (scope?.active !== false) positioning.value = false;
      }
    }
  }
  async function finish(input: {
    readonly isCurrent: () => boolean;
    readonly initialRender: boolean;
    readonly shouldScroll: () => boolean;
    readonly cachedPositioning?: Promise<void> | undefined;
  }): Promise<void> {
    if (input.initialRender) await options.beginInitialRender();
    if (!input.isCurrent()) return;
    if (input.shouldScroll()) {
      positioning.value = true;
      await options.scrollLatest(input.isCurrent);
    }
    await input.cachedPositioning;
    if (input.isCurrent()) positioning.value = false;
  }
  async function openRestored(input: {
    readonly loader: ReturnType<typeof createWorkspaceSessionPaneLoader>;
    readonly nodeId: string;
    readonly workspaceId: string | undefined;
    readonly sessionId: string;
    readonly requestId: number;
    readonly isCurrent: () => boolean;
    readonly restored: boolean;
    readonly switching: boolean;
    readonly deferInitialScroll: boolean;
    readonly activeRunId: string | undefined;
    readonly onResolved: (session: Session) => void;
    readonly onLoaded: (session: Session) => void;
    readonly onSettle: () => void;
    readonly throwOnFailure: boolean;
  }): Promise<void> {
    if (options.content === undefined) throw new Error('Pane content is not configured.');
    if (input.activeRunId !== undefined) options.content.openRun(input.activeRunId);
    const hasContent = options.content.hasContent();
    restoredContent.value = hasContent;
    const cachedPositioning =
      input.restored && hasContent && !input.deferInitialScroll
        ? positionRestored(input.requestId, input.isCurrent)
        : undefined;
    await input.loader.read({
      nodeId: input.nodeId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      isCurrent: input.isCurrent,
      onResolved: input.onResolved,
      loading: options.loading,
      failed: options.failed,
      failureCause: options.failureCause,
      throwOnFailure: input.throwOnFailure,
      beforeFailure: async () => {
        await cachedPositioning;
      },
      onFailure: () => {
        positioning.value = false;
      },
      onSettle: input.onSettle,
      afterLoad: async (loaded) => {
        await finish({
          isCurrent: input.isCurrent,
          initialRender: !hasContent,
          shouldScroll: () =>
            !hasContent && (input.switching || loaded.changed || !input.deferInitialScroll),
          cachedPositioning
        });
        if (input.isCurrent()) input.onLoaded(loaded.session);
      }
    });
  }
  return {
    begin,
    setRestoredContent: (present: boolean) => {
      restoredContent.value = present;
    },
    loadingContent: computed(() => options.loading.value && !restoredContent.value),
    positionRestored,
    finish,
    openRestored,
    read: (
      loader: ReturnType<typeof createWorkspaceSessionPaneLoader>,
      input: Omit<
        Parameters<ReturnType<typeof createWorkspaceSessionPaneLoader>['read']>[0],
        'loading' | 'failed' | 'failureCause'
      >
    ) =>
      loader.read({
        ...input,
        loading: options.loading,
        failed: options.failed,
        failureCause: options.failureCause
      }),
    clearPosition: () => {
      positioning.value = false;
    }
  };
}

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
  const read = createWorkspaceSessionPaneRead(load);
  return { load, read };
}

export function createWorkspaceSessionPaneRead(
  load: (input: {
    readonly nodeId: string;
    readonly workspaceId: string | undefined;
    readonly sessionId: string;
    readonly isCurrent: () => boolean;
    readonly onResolved: (session: Session) => void;
  }) => Promise<{ readonly session: Session; readonly changed: boolean } | undefined>
) {
  return async function read(
    input: Parameters<typeof load>[0] & {
      readonly loading: Ref<boolean>;
      readonly failed: Ref<boolean>;
      readonly failureCause: Ref<unknown>;
      readonly afterLoad: (result: NonNullable<Awaited<ReturnType<typeof load>>>) => Promise<void>;
      readonly beforeFailure?: () => Promise<void>;
      readonly onFailure?: () => void;
      readonly onSettle?: () => void;
      readonly throwOnFailure?: boolean;
    }
  ): Promise<void> {
    try {
      const result = await load(input);
      if (result !== undefined && input.isCurrent()) await input.afterLoad(result);
    } catch (error) {
      await input.beforeFailure?.();
      if (!input.isCurrent()) return;
      input.onFailure?.();
      if (errorCode(error) !== 'WATCH_CANCELLED') {
        input.failed.value = true;
        input.failureCause.value = error;
      }
      if (input.throwOnFailure) throw error;
    } finally {
      input.onSettle?.();
      if (input.isCurrent()) input.loading.value = false;
    }
  };
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
  const renderer = createWorkspaceSessionPaneRenderLifecycle({
    loading: options.loading,
    failed: options.failed,
    failureCause: options.failureCause,
    beginInitialRender: options.beginInitialRender,
    scrollLatest: options.scrollLatest
  });
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
        renderer.begin();
        const restored = options.restore(captured);
        options.loadingContent.value = !restored;
        await renderer.read(options.loader, {
          ...captured,
          isCurrent: current,
          onResolved: () => {},
          afterLoad: async () => {
            let element: HTMLElement | undefined;
            await renderer.finish({
              isCurrent: current,
              initialRender: true,
              shouldScroll: () => {
                element = options.scrollElement();
                return !(
                  restored &&
                  element !== undefined &&
                  element === renderedElement &&
                  renderedTarget?.nodeId === captured.nodeId &&
                  renderedTarget.workspaceId === captured.workspaceId &&
                  renderedTarget.sessionId === captured.sessionId
                );
              }
            });
            if (!current()) return;
            renderedTarget = captured;
            renderedElement = element;
            await options.markRead(captured.nodeId, captured.workspaceId, captured.sessionId);
          },
          onSettle: () => {
            if (current()) options.loadingContent.value = false;
          }
        });
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
  async function reloadChecked(): Promise<void> {
    await (reload?.() ?? Promise.resolve());
    if (options.failed.value)
      throw new ApiError(
        'SESSION_HISTORY_INITIAL_FAILED',
        'The initial session snapshot has not been applied.'
      );
  }
  return { reload: () => reload?.() ?? Promise.resolve(), reloadChecked, stop };
}
