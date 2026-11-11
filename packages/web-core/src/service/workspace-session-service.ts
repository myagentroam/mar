import type { Workspace, WorkspaceTarget, AgentRun, Session } from '../model/workbench.js';
import type {
  WorkspaceSessionCleanupResult,
  SessionGroup,
  SessionRunningCounts
} from '@myagentroam/protocol';
import type { NavigationSnapshot } from './session-navigation-projection.js';
import type { MessageFeedback } from '../model/message-feedback.js';
import { computed, ref, watch, type Ref } from 'vue';
import { translate } from './locale-preference-service.js';

interface SessionPage {
  readonly runningCounts?: SessionRunningCounts;
  readonly sessions: Session[];
  readonly nextCursor: string | null;
}

export interface WorkspaceSessionListSnapshot {
  readonly listedSessionIds: readonly string[];
  readonly runningCounts: SessionRunningCounts;
}

interface SessionPaging {
  readonly nextCursors: Ref<Map<string, string | null>>;
  readonly loadMoreErrors: Ref<Map<string, unknown>>;
  readonly loadingMore: Ref<boolean>;
  initialize(tabId: string): void;
  reset(tabId: string): void;
  append(tabId: string, receivedCount: number, nextCursor: string | null): void;
}

/** Owns the discovery projection shared by navigation and session consumers. */
function createWorkspaceSessionProjection() {
  const sessions = ref<Session[]>([]);
  return {
    sessions: computed(() => sessions.value),
    replaceAll: (values: readonly Session[]) => {
      sessions.value = [...values];
    },
    prepend: (session: Session) => {
      sessions.value = [session, ...sessions.value];
    },
    replaceExisting: (session: Session) => {
      sessions.value = sessions.value.map((current) =>
        current.id === session.id ? session : current
      );
    },
    removeId: (sessionId: string) => {
      sessions.value = sessions.value.filter((session) => session.id !== sessionId);
    },
    removeExact: (session: Session) => {
      sessions.value = sessions.value.filter((current) => current !== session);
    },
    removeWorkspace: (workspaceId: string) => {
      sessions.value = sessions.value.filter((session) => session.workspaceId !== workspaceId);
    },
    retainSelectedInWorkspace: (workspaceId: string, selectedId?: string) => {
      sessions.value = sessions.value.filter(
        (session) => session.workspaceId !== workspaceId || session.id === selectedId
      );
    },
    markManagedActive: (session: Session) => {
      sessions.value = sessions.value.map((current) =>
        current.id === session.id && current.workspaceId === session.workspaceId
          ? { ...current, activity: 'MANAGED_ACTIVE' }
          : current
      );
    }
  };
}

/** Owns discovery and list membership; the Workspace view cache stores its restorable snapshot. */
export function createWorkspaceSessionService(options: {
  readonly runs: Readonly<Ref<readonly AgentRun[]>>;
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Readonly<Ref<string | undefined>>;
  readonly setSelectedSessionId: (id: string | undefined) => void;
  readonly paging: SessionPaging;
  readonly pageSize: number;
  readonly groupingSupported?: () => boolean;
  readonly tabId: (nodeId: string, workspaceId: string) => string;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly notice: MessageFeedback;
  readonly errorMessage: (error: unknown) => string;
}) {
  const projection = createWorkspaceSessionProjection();
  const refreshing = ref(false);
  const groups = ref(new Map<string, SessionGroup>());
  let groupSelectionRevision = 0;
  const runningCounts = ref<SessionRunningCounts>({ MAIN: 0, CHILD: 0 });
  const listedSessionIds = ref<ReadonlySet<string>>(new Set());
  const currentGroup = computed<SessionGroup | undefined>(() => {
    const target = options.workspaceTarget.value;
    if (target === undefined || options.groupingSupported?.() !== true) return undefined;
    return groups.value.get(options.tabId(target.nodeId, target.workspaceId)) ?? 'MAIN';
  });
  const groupQuery = () =>
    currentGroup.value === undefined ? '' : `&sessionGroup=${currentGroup.value}`;

  function selectGroup(group: SessionGroup, deferUntilSupported = false): void {
    const target = options.workspaceTarget.value;
    if (target === undefined || (currentGroup.value === undefined && !deferUntilSupported)) return;
    const id = options.tabId(target.nodeId, target.workspaceId);
    if ((groups.value.get(id) ?? 'MAIN') === group) return;
    groupSelectionRevision += 1;
    groups.value.set(id, group);
  }
  const searchQuery = ref('');
  const searchResults = ref<Session[]>([]);
  const searchNextCursor = ref<string | null>(null);
  const searching = ref(false);
  const loadingMoreSearchResults = ref(false);
  const loadMoreSearchResultsError = ref<unknown>();
  const synchronizationGenerations = new Map<string, number>();
  let latestSnapshot:
    { readonly id: string; readonly generation: number; readonly page: SessionPage } | undefined;
  let pendingSnapshot:
    | {
        id: string;
        generation: number;
        page: SessionPage;
        workspace: WorkspaceTarget;
        visibleCount: number;
      }
    | undefined;
  let searchGeneration = 0;
  let searchContext:
    { workspace: WorkspaceTarget | undefined; group: SessionGroup | undefined } | undefined;
  let loadMoreOperation = 0;

  watch(
    [options.workspaceTarget, currentGroup],
    ([target, group], [previousTarget, previousGroup]) => {
      if (target === undefined || target !== previousTarget || group === previousGroup) return;
      const id = options.tabId(target.nodeId, target.workspaceId);
      synchronizationGenerations.set(id, (synchronizationGenerations.get(id) ?? 0) + 1);
      latestSnapshot = undefined;
      pendingSnapshot = undefined;
      loadMoreOperation += 1;
      options.paging.loadingMore.value = false;
      options.paging.reset(id);
      options.paging.nextCursors.value.set(id, null);
      projection.retainSelectedInWorkspace(target.workspaceId, options.selectedSessionId.value);
      listedSessionIds.value = new Set();
      const query = searchQuery.value;
      clearSearch();
      if (query) void search(query);
    },
    { flush: 'sync' }
  );

  function preserveStablePresentation(current: Session | undefined, next: Session): Session {
    let merged = next;
    if (next.commandStates === undefined && current?.commandStates !== undefined)
      merged = { ...merged, commandStates: current.commandStates };
    if (next.runtime === undefined && current?.runtime !== undefined)
      merged = { ...merged, runtime: current.runtime };
    return merged;
  }

  const markManagedActive = projection.markManagedActive;
  const replaceSessions = projection.replaceAll;

  function preserveManagedActive(current: Session | undefined, next: Session): Session {
    const withStablePresentation = preserveStablePresentation(current, next);
    const hasActiveRun = options.runs.value.some(
      (run) =>
        ['STARTING', 'RUNNING', 'CANCELLING'].includes(run.status) &&
        (run.sessionId === current?.id || run.sessionId === next.id)
    );
    if (
      current?.activity !== 'MANAGED_ACTIVE' ||
      next.activity === 'MANAGED_ACTIVE' ||
      !hasActiveRun
    )
      return withStablePresentation;
    return {
      ...withStablePresentation,
      activity: current.activity,
      ...(current.control === undefined ? {} : { control: current.control }),
      ...(current.runtime === undefined ? {} : { runtime: current.runtime })
    };
  }

  function isManaged(session: Session): boolean {
    return session.nativeControl === 'MAR_MANAGED' || session.control?.level === 'MANAGED';
  }

  function sameNativeSession(left: Session, right: Session): boolean {
    if (left.workspaceId !== right.workspaceId || left.runner !== right.runner) return false;
    if (left.id === right.id) return true;
    const leftNativeId = (left as Session & { readonly externalSessionId?: string })
      .externalSessionId;
    const rightNativeId = (right as Session & { readonly externalSessionId?: string })
      .externalSessionId;
    return (
      typeof leftNativeId === 'string' && leftNativeId.length > 0 && leftNativeId === rightNativeId
    );
  }

  function stableSession(
    current: Session | undefined,
    next: Session,
    authoritativeActivity = false
  ): Session {
    const merged = authoritativeActivity ? next : preserveManagedActive(current, next);
    return current !== undefined && JSON.stringify(current) === JSON.stringify(merged)
      ? current
      : merged;
  }

  function merge(
    next: readonly Session[],
    mergeOptions: {
      readonly authoritativeOrder?: boolean;
      readonly authoritativeActivity?: boolean;
    } = {}
  ): void {
    const currentSessions = projection.sessions.value;
    const byId = new Map(currentSessions.map((session) => [session.id, session]));
    const order = currentSessions.map((session) => session.id);
    for (const session of next) {
      const current = byId.get(session.id);
      const sameNative = [...byId.values()].filter((candidate) =>
        sameNativeSession(candidate, session)
      );
      const managed = sameNative.find(isManaged);
      if (managed !== undefined && !isManaged(session)) {
        for (const duplicate of sameNative)
          if (duplicate.id !== managed.id) byId.delete(duplicate.id);
        continue;
      }
      for (const duplicate of sameNative) {
        if (duplicate.id !== session.id) {
          byId.delete(duplicate.id);
          const index = order.indexOf(duplicate.id);
          if (index >= 0) order[index] = session.id;
        }
      }
      byId.set(
        session.id,
        stableSession(current, session, mergeOptions.authoritativeActivity === true)
      );
      if (!order.includes(session.id)) order.push(session.id);
      if (sameNative.some((candidate) => candidate.id === options.selectedSessionId.value))
        options.setSelectedSessionId(session.id);
    }
    let mergedSessions: Session[];
    if (mergeOptions.authoritativeOrder === true) {
      const orderedIds = new Set(next.map((session) => session.id));
      mergedSessions = [
        ...next.flatMap((session) => {
          const merged = byId.get(session.id);
          return merged === undefined ? [] : [merged];
        }),
        ...order
          .filter((id) => !orderedIds.has(id))
          .flatMap((id) => {
            const merged = byId.get(id);
            return merged === undefined ? [] : [merged];
          })
      ];
    } else
      mergedSessions = order.flatMap((id) => {
        const merged = byId.get(id);
        return merged === undefined ? [] : [merged];
      });
    if (
      mergedSessions.length === currentSessions.length &&
      mergedSessions.every((session, index) => session === currentSessions[index])
    )
      return;
    projection.replaceAll(mergedSessions);
  }

  function applySnapshot(nodeId: string, workspaceId: string, page: SessionPage): void {
    if (page.runningCounts !== undefined) runningCounts.value = page.runningCounts;
    const id = options.tabId(nodeId, workspaceId);
    const generation = (synchronizationGenerations.get(id) ?? 0) + 1;
    synchronizationGenerations.set(id, generation);
    latestSnapshot = { id, generation, page };
    const visibleCount = listedSessionIds.value.size;
    const workspace = options.workspaceTarget.value;
    const isActive = workspace?.nodeId === nodeId && workspace.workspaceId === workspaceId;
    pendingSnapshot = undefined;
    if (isActive) {
      loadMoreOperation += 1;
      options.paging.loadingMore.value = false;
    }
    options.paging.initialize(id);
    options.paging.nextCursors.value.set(id, page.nextCursor);
    options.paging.loadMoreErrors.value.delete(id);
    if (isActive && visibleCount > page.sessions.length && page.nextCursor !== null) {
      pendingSnapshot = { id, generation, page, workspace, visibleCount };
      merge(page.sessions, { authoritativeActivity: true });
      void restoreSnapshot();
    } else {
      listedSessionIds.value = new Set(page.sessions.map((session) => session.id));
      merge(page.sessions, { authoritativeOrder: true, authoritativeActivity: true });
    }
    if (isActive) {
      if (searchQuery.value && currentGroup.value !== undefined) void search(searchQuery.value);
    }
  }

  async function restoreSnapshot(): Promise<void> {
    const snapshot = pendingSnapshot;
    if (snapshot === undefined) return;
    const operation = ++loadMoreOperation;
    const isCurrent = () =>
      pendingSnapshot === snapshot &&
      synchronizationGenerations.get(snapshot.id) === snapshot.generation &&
      options.workspaceTarget.value === snapshot.workspace;
    const restoredIds = new Set(snapshot.page.sessions.map((session) => session.id));
    let cursor = snapshot.page.nextCursor;
    options.paging.loadingMore.value = true;
    options.paging.loadMoreErrors.value.delete(snapshot.id);
    try {
      // Rebuild only the already-loaded range, keeping the old rows until it is ready.
      while (restoredIds.size < snapshot.visibleCount && cursor !== null) {
        const beforeRead = new Map(
          projection.sessions.value.map((session) => [session.id, session])
        );
        const page = await options.request<SessionPage>(
          `/api/agent-sessions?nodeId=${encodeURIComponent(snapshot.workspace.nodeId)}&workspaceId=${encodeURIComponent(snapshot.workspace.workspaceId)}&limit=${Math.min(options.pageSize, snapshot.visibleCount - restoredIds.size)}${groupQuery()}&cursor=${encodeURIComponent(cursor)}`
        );
        if (!isCurrent()) return;
        if (page.nextCursor === cursor) throw new Error('SESSION_PAGINATION_NO_PROGRESS');
        const current = new Map(projection.sessions.value.map((session) => [session.id, session]));
        merge(
          page.sessions.filter((session) => current.get(session.id) === beforeRead.get(session.id))
        );
        for (const session of page.sessions) restoredIds.add(session.id);
        cursor = page.nextCursor;
      }
      if (!isCurrent()) return;
      const currentById = new Map(
        projection.sessions.value.map((session) => [session.id, session])
      );
      listedSessionIds.value = restoredIds;
      merge(
        [...restoredIds].flatMap((id) => {
          const session = currentById.get(id);
          return session === undefined ? [] : [session];
        }),
        { authoritativeOrder: true }
      );
      options.paging.nextCursors.value.set(snapshot.id, cursor);
      pendingSnapshot = undefined;
    } catch (error) {
      if (isCurrent()) options.paging.loadMoreErrors.value.set(snapshot.id, error);
    } finally {
      if (operation === loadMoreOperation) options.paging.loadingMore.value = false;
    }
  }

  async function loadMore(): Promise<void> {
    const workspaceSelection = options.workspaceTarget.value;
    const nodeId = workspaceSelection?.nodeId;
    const workspaceId = options.workspaceTarget.value?.workspaceId;
    if (
      nodeId === undefined ||
      workspaceId === undefined ||
      options.paging.loadingMore.value ||
      refreshing.value
    )
      return;
    const id = options.tabId(nodeId, workspaceId);
    if (pendingSnapshot?.id === id) return restoreSnapshot();
    const cursor = options.paging.nextCursors.value.get(id);
    if (typeof cursor !== 'string') return;
    const generation = synchronizationGenerations.get(id) ?? 0;
    const operation = ++loadMoreOperation;
    const isCurrent = () =>
      (synchronizationGenerations.get(id) ?? 0) === generation &&
      options.workspaceTarget.value === workspaceSelection &&
      options.workspaceTarget.value?.nodeId === nodeId &&
      options.workspaceTarget.value?.workspaceId === workspaceId;
    options.paging.loadingMore.value = true;
    options.paging.loadMoreErrors.value.delete(id);
    try {
      const result = await options.request<SessionPage>(
        `/api/agent-sessions?nodeId=${encodeURIComponent(nodeId)}&workspaceId=${encodeURIComponent(workspaceId)}&limit=${options.pageSize}${groupQuery()}&cursor=${encodeURIComponent(cursor)}`
      );
      if (!isCurrent()) return;
      if (result.nextCursor === cursor) throw new Error('SESSION_PAGINATION_NO_PROGRESS');
      merge(result.sessions);
      listedSessionIds.value = new Set([
        ...listedSessionIds.value,
        ...result.sessions.map((session) => session.id)
      ]);
      options.paging.append(id, result.sessions.length, result.nextCursor);
    } catch (error) {
      if (!isCurrent()) return;
      options.paging.loadMoreErrors.value.set(id, error);
    } finally {
      if (operation === loadMoreOperation) options.paging.loadingMore.value = false;
    }
  }

  async function search(query: string): Promise<void> {
    const workspaceSelection = options.workspaceTarget.value;
    const nodeId = workspaceSelection?.nodeId;
    const workspaceId = options.workspaceTarget.value?.workspaceId;
    const normalized = query.trim().slice(0, 160);
    const generation = ++searchGeneration;
    const sameQuery =
      normalized === searchQuery.value &&
      searchContext?.workspace === workspaceSelection &&
      searchContext?.group === currentGroup.value;
    searchContext = { workspace: workspaceSelection, group: currentGroup.value };
    searchQuery.value = normalized;
    if (!sameQuery) {
      searchResults.value = [];
      searchNextCursor.value = null;
    }
    loadingMoreSearchResults.value = false;
    loadMoreSearchResultsError.value = undefined;
    searching.value = false;
    if (nodeId === undefined || workspaceId === undefined || normalized.length === 0) return;
    searching.value = true;
    try {
      const result = await options.request<SessionPage>(
        `/api/agent-sessions?nodeId=${encodeURIComponent(nodeId)}&workspaceId=${encodeURIComponent(workspaceId)}&limit=${options.pageSize}${groupQuery()}&query=${encodeURIComponent(normalized)}`
      );
      if (
        generation !== searchGeneration ||
        options.workspaceTarget.value !== workspaceSelection ||
        options.workspaceTarget.value?.nodeId !== nodeId ||
        options.workspaceTarget.value?.workspaceId !== workspaceId
      )
        return;
      searchResults.value = result.sessions;
      searchNextCursor.value = result.nextCursor;
      if (result.runningCounts !== undefined) runningCounts.value = result.runningCounts;
    } catch (error) {
      if (generation === searchGeneration)
        options.notice(options.errorMessage(error), 'error', error);
    } finally {
      if (generation === searchGeneration) searching.value = false;
    }
  }

  function clearSearch(): void {
    searchGeneration += 1;
    searchContext = undefined;
    searchQuery.value = '';
    searchResults.value = [];
    searchNextCursor.value = null;
    searching.value = false;
    loadingMoreSearchResults.value = false;
    loadMoreSearchResultsError.value = undefined;
  }

  watch(
    options.workspaceTarget,
    () => {
      clearSearch();
      latestSnapshot = undefined;
      pendingSnapshot = undefined;
      listedSessionIds.value = new Set();
      runningCounts.value = { MAIN: 0, CHILD: 0 };
      loadMoreOperation += 1;
      options.paging.loadingMore.value = false;
    },
    { flush: 'sync' }
  );

  function snapshot(): WorkspaceSessionListSnapshot {
    return {
      listedSessionIds: [...listedSessionIds.value],
      runningCounts: runningCounts.value
    };
  }

  function restore(value: WorkspaceSessionListSnapshot | undefined): void {
    listedSessionIds.value = new Set(value?.listedSessionIds);
    runningCounts.value = value?.runningCounts ?? { MAIN: 0, CHILD: 0 };
  }

  async function loadMoreSearchResults(): Promise<void> {
    const workspaceSelection = options.workspaceTarget.value;
    const nodeId = workspaceSelection?.nodeId;
    const workspaceId = options.workspaceTarget.value?.workspaceId;
    const query = searchQuery.value;
    const cursor = searchNextCursor.value;
    if (
      nodeId === undefined ||
      workspaceId === undefined ||
      query.length === 0 ||
      cursor === null ||
      loadingMoreSearchResults.value ||
      searching.value
    )
      return;
    const generation = searchGeneration;
    const isCurrent = () =>
      generation === searchGeneration &&
      options.workspaceTarget.value === workspaceSelection &&
      options.workspaceTarget.value?.nodeId === nodeId &&
      options.workspaceTarget.value?.workspaceId === workspaceId;
    loadingMoreSearchResults.value = true;
    loadMoreSearchResultsError.value = undefined;
    try {
      const result = await options.request<SessionPage>(
        `/api/agent-sessions?nodeId=${encodeURIComponent(nodeId)}&workspaceId=${encodeURIComponent(workspaceId)}&limit=${options.pageSize}${groupQuery()}&cursor=${encodeURIComponent(cursor)}&query=${encodeURIComponent(query)}`
      );
      if (!isCurrent()) return;
      if (result.nextCursor === cursor) throw new Error('SESSION_PAGINATION_NO_PROGRESS');
      const byId = new Map(searchResults.value.map((session) => [session.id, session]));
      for (const session of result.sessions) byId.set(session.id, session);
      searchResults.value = [...byId.values()];
      searchNextCursor.value = result.nextCursor;
    } catch (error) {
      if (isCurrent()) loadMoreSearchResultsError.value = error;
    } finally {
      if (isCurrent()) loadingMoreSearchResults.value = false;
    }
  }

  async function synchronize(workspaceId: string): Promise<void>;
  async function synchronize(
    workspaceId: string,
    throwOnError: true
  ): Promise<SessionPage | undefined>;
  async function synchronize(
    workspaceId: string,
    throwOnError = false
  ): Promise<SessionPage | void> {
    const workspaceSelection = options.workspaceTarget.value;
    const nodeId = workspaceSelection?.nodeId;
    if (nodeId === undefined) return;
    const id = options.tabId(nodeId, workspaceId);
    const generation = (synchronizationGenerations.get(id) ?? 0) + 1;
    synchronizationGenerations.set(id, generation);
    if (pendingSnapshot?.id === id) pendingSnapshot = { ...pendingSnapshot, generation };
    loadMoreOperation += 1;
    options.paging.loadingMore.value = false;
    const isCurrent = () =>
      synchronizationGenerations.get(id) === generation &&
      options.workspaceTarget.value === workspaceSelection &&
      options.workspaceTarget.value?.nodeId === nodeId &&
      options.workspaceTarget.value?.workspaceId === workspaceId;
    const firstPage = await options
      .request<SessionPage>(
        `/api/agent-sessions?nodeId=${encodeURIComponent(nodeId)}&workspaceId=${encodeURIComponent(workspaceId)}&limit=${options.pageSize}${groupQuery()}`
      )
      .catch((error) => {
        if (!isCurrent()) return undefined;
        if (throwOnError) throw error;
        options.notice(
          translate('generated.workspaceSessionService.unableToSynchronizeSessions', {
            value0: options.errorMessage(error)
          }),
          'error'
        );
        return undefined;
      });
    if (!isCurrent()) {
      const snapshot = latestSnapshot?.id === id ? latestSnapshot : undefined;
      if (
        throwOnError &&
        snapshot !== undefined &&
        options.workspaceTarget.value === workspaceSelection &&
        options.workspaceTarget.value?.nodeId === nodeId &&
        options.workspaceTarget.value?.workspaceId === workspaceId &&
        snapshot?.generation === synchronizationGenerations.get(id)
      )
        return snapshot.page;
      return;
    }
    if (firstPage !== undefined) {
      pendingSnapshot = undefined;
      options.paging.reset(id);
      listedSessionIds.value = new Set(firstPage.sessions.map((session) => session.id));
      merge(firstPage.sessions, { authoritativeOrder: true });
      if (firstPage.runningCounts !== undefined) runningCounts.value = firstPage.runningCounts;
      options.paging.nextCursors.value.set(id, firstPage.nextCursor);
    }
    if (throwOnError) return firstPage;
  }

  async function refresh(): Promise<void> {
    const workspaceId = options.workspaceTarget.value?.workspaceId;
    if (workspaceId === undefined || refreshing.value) return;
    refreshing.value = true;
    try {
      if (searchQuery.value) await search(searchQuery.value);
      else await synchronize(workspaceId);
    } finally {
      refreshing.value = false;
    }
  }

  function createVisibleList(input: {
    readonly unfiltered: Readonly<Ref<readonly Session[]>>;
    readonly canLoadMore: Readonly<Ref<boolean>>;
  }) {
    const visible = computed(() =>
      (searchQuery.value.length > 0 ? searchResults.value : input.unfiltered.value).filter(
        (session) =>
          currentGroup.value === undefined ||
          ((session.sessionGroup ?? 'MAIN') === currentGroup.value &&
            (searchQuery.value.length > 0 || listedSessionIds.value.has(session.id)))
      )
    );
    const canLoadMore = computed(() =>
      searchQuery.value.length > 0 ? searchNextCursor.value !== null : input.canLoadMore.value
    );
    const loadingMore = computed(() =>
      searchQuery.value.length > 0
        ? loadingMoreSearchResults.value
        : options.paging.loadingMore.value
    );
    const loadMoreError = computed(() => {
      if (searchQuery.value.length > 0) return loadMoreSearchResultsError.value;
      const target = options.workspaceTarget.value;
      return target === undefined
        ? undefined
        : options.paging.loadMoreErrors.value.get(options.tabId(target.nodeId, target.workspaceId));
    });
    return {
      visible,
      canLoadMore,
      loadingMore,
      loadMoreError,
      loadMore: () => (searchQuery.value.length > 0 ? loadMoreSearchResults() : loadMore())
    };
  }

  return {
    projection,
    snapshot,
    restore,
    currentGroup,
    createVisibleList,
    selectGroup,
    groupSelectionRevision: () => groupSelectionRevision,
    runningCounts,
    listedSessionIds,
    refreshing,
    searchQuery,
    searchResults,
    searchNextCursor,
    searching,
    loadingMoreSearchResults,
    loadMoreSearchResultsError,
    preserveManagedActive,
    markManagedActive,
    replaceSessions,
    merge,
    applySnapshot,
    loadMore,
    search,
    clearSearch,
    loadMoreSearchResults,
    synchronize,
    refresh
  };
}

export interface WorkbenchSessionListView {
  mutationLoading: boolean;
  sessions: Session[];
  visibleWorkspaceSessions: Session[];
  canLoadMoreWorkspaceSessions: boolean;
  loadMoreWorkspaceSessionsError: unknown;
  loadMoreWorkspaceSessions: () => Promise<void>;
  loadingMoreWorkspaceSessions: boolean;
  refreshWorkspaceSessions: () => Promise<void>;
  refreshingWorkspaceSessions: boolean;
  searchingWorkspaceSessions: boolean;
  searchWorkspaceSessions: (query: string) => Promise<void>;
  workspaceSessionSearchEnabled: boolean;
  workspaceSessionSearchQuery: string;
  workspaceSessionGroup: 'MAIN' | 'CHILD' | undefined;
  selectWorkspaceSessionGroup: (group: SessionGroup, deferUntilSupported?: boolean) => void;
  deleteSession: (session: Session) => Promise<void>;
  canDeleteSession: (session: Session) => boolean;
  cleanupWorkspaceSessions: (
    nodeId: string,
    workspace: Workspace,
    inactiveDays: number
  ) => Promise<WorkspaceSessionCleanupResult | undefined>;
  cleanupSessionsEnabled: boolean;
  renameSession: (session: Session) => Promise<void>;
  movePinnedSession: (session: Session, direction: 'up' | 'down') => Promise<void>;
  movePinnedSessionTo: (
    session: Session,
    target: Session,
    position: 'before' | 'after'
  ) => Promise<void>;
  setSessionPinned: (session: Session, pinned: boolean) => Promise<void>;
  setSessionTreeAnchor: (sessionId: string | undefined) => void;
  sessionNavigationSnapshot: NavigationSnapshot | undefined;
  sessionActivity: (session: Session) => NonNullable<Session['activity']>;
  sessionActivityDateTime: (session: Session) => string | undefined;
  sessionActivityLabel: (session: Session) => string;
  sessionActivityTitle: (session: Session) => string | undefined;
  sessionRelativeActivity: (session: Session) => string;
  sessionTitle: (session: Session) => string;
  reloadSelectedSession: () => void;
}
