import { workspaceTargetRef } from './support/workspace-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createWorkbenchSessionSelectionService } from '../../src/service/WorkbenchSessionSelectionService.js';
import type { WorkbenchSessionSelectionOptions } from '../../src/service/WorkbenchSessionSelectionService.js';
import type { Session } from '../../src/model/workbench.js';
import { createWorkbenchSessionWatchController } from '../../src/service/WorkbenchSessionWatchController.js';
import { createWorkbenchNotificationService } from '../../src/service/WorkbenchNotificationService.js';
import { createWorkbenchWatchCoordinator } from '../../src/service/WorkbenchWatchCoordinator.js';
function turn(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sessionId: 'session-1',
    runId: null,
    status: 'RUNNING',
    items: [],
    ...overrides
  };
}
function tabSessionFixture() {
  const session: Session = { id: 'outside-page', workspaceId: 'workspace-1', runner: 'mar-agent' };
  const target = ref({ nodeId: 'node-1', workspaceId: 'workspace-1' });
  let revision = 0;
  const options: WorkbenchSessionSelectionOptions = {
    workspaceTarget: target,
    selectedSessionId: ref(),
    selectedRunId: ref(),
    sessions: ref([]),
    runs: ref([]),
    turns: ref([]),
    nextCursor: ref(null),
    loadingInitial: ref(false),
    initialLoadFailed: ref(false),
    contextUsage: ref(),
    queue: ref({ version: 0, paused: false, items: [] }),
    positioning: ref(false),
    draftOpen: ref(false),
    composerMode: ref('message'),
    selectedCommand: ref(),
    commandPickerOpen: ref(false),
    nextRequest: () => ++revision,
    currentRequest: () => revision,
    closeMobileSurface: vi.fn(),
    workspaceTabId: () => 'tab',
    ensureSessionVisible: vi.fn(),
    markSessionRead: vi.fn(async () => undefined),
    saveCurrent: vi.fn(),
    selectWorkspace: vi.fn(),
    applyComposerConfiguration: vi.fn(),
    restoreCachedDetail: () => undefined,
    cachedQueue: () => ({ version: 0, paused: false, items: [] }),
    restoreProjection: vi.fn(),
    resetProjection: vi.fn(),
    openRun: vi.fn(),
    scrollLatest: vi.fn(async () => undefined),
    beginInitialRender: vi.fn(async () => undefined),
    request: vi.fn(async () => ({ session })) as WorkbenchSessionSelectionOptions['request'],
    sessionPathId: (id) => id,
    replaceSession: vi.fn(),
    canWatch: () => true,
    beginWatch: vi.fn(async () => true),
    applySnapshot: vi.fn(() => false),
    mergeTurns: vi.fn(() => false),
    notice: vi.fn(),
    errorMessage: String
  };
  return { session, target, options, service: createWorkbenchSessionSelectionService(options) };
}

async function watchedTabFixture() {
  const f = tabSessionFixture();
  const connection = ref<string>();
  let read = false;
  const readPosts: string[] = [];
  const now = Date.now();
  const entry = {
    id: 'unread',
    kind: 'run',
    title: 'Completed',
    message: 'Done',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 60_000,
    target: {
      targetType: 'WORKSPACE_SESSION',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: f.session.id
    }
  };
  const notifications = createWorkbenchNotificationService(ref('test'), {
    request: (async (path: string) => {
      if (path === '/api/notifications/session/read') {
        readPosts.push(f.session.id);
        read = true;
        return {};
      }
      if (path === '/api/notifications')
        return { notifications: [{ ...entry, read }], recentRuns: [] };
      throw new Error('Unexpected notification path: ' + path);
    }) as WorkbenchSessionSelectionOptions['request']
  });
  await notifications.load();
  const snapshot = vi.fn(() => true);
  const watchRequest = vi.fn(async (_path: string, _init?: RequestInit) => ({
    nodeGeneration: 'generation'
  }));
  const controller = createWorkbenchSessionWatchController({
    workspaceTarget: f.target,
    selectedSessionId: f.options.selectedSessionId,
    sessions: f.options.sessions,
    followConversation: ref(false),
    heartbeatMs: 15_000,
    workbenchConnectionId: () => connection.value,
    requestTimeoutMs: 10_000,
    confirmationTimeoutMs: 45_000,
    request: watchRequest as WorkbenchSessionSelectionOptions['request'],
    sessionPathId: (id) => id,
    mergeSessions: vi.fn(),
    applySnapshot: snapshot,
    scrollAfterLayout: vi.fn(),
    refreshSnapshot: vi.fn(),
    openSession: vi.fn()
  });
  const coordinator = createWorkbenchWatchCoordinator({
    workspace: {
      start: vi.fn(async () => undefined),
      restart: vi.fn(async () => undefined),
      pause: vi.fn(),
      stop: vi.fn(),
      handleEvent: () => false
    },
    session: controller
  });
  Object.assign(f.options, {
    markSessionRead: notifications.markSessionRead,
    replaceSession: (_id: string, next: Session) => {
      f.options.sessions.value = [next];
    },
    canWatch: controller.canWatchSessionHistory,
    beginWatch: async (id: string) => {
      await coordinator.restartSession(id);
      return controller.hasInitialSessionSnapshot(id);
    }
  } satisfies Partial<WorkbenchSessionSelectionOptions>);
  function frame(override: Record<string, unknown> = {}) {
    const initial = watchRequest.mock.calls.filter(([, init]) => init?.method === 'POST').at(-1)!;
    const request = JSON.parse(String(initial[1]?.body)) as { watchId: string };
    return {
      type: 'watch.session.snapshot',
      workbenchConnectionId: connection.value,
      nodeGeneration: 'generation',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      watchId: request.watchId,
      sessionId: f.session.id,
      payload: { unit: 'SEGMENT', segments: [], nextCursor: null, source: 'native' },
      ...override
    };
  }
  return {
    ...f,
    controller,
    connection,
    watchRequest,
    snapshot,
    notifications,
    readPosts,
    frame,
    watchPosts: () => watchRequest.mock.calls.filter(([, init]) => init?.method === 'POST'),
    dispose: () => {
      coordinator.dispose();
      notifications.dispose();
    }
  };
}

it.each([false, true])(
  'exposes history load failures to transactional callers only when requested: %s',
  async (throwOnFailure) => {
    const f = tabSessionFixture();
    const failure = new Error('HISTORY_UNAVAILABLE');
    vi.mocked(f.options.beginWatch).mockRejectedValue(failure);
    const result = f.service.openSession(f.session.id, { throwOnFailure });
    if (throwOnFailure) await expect(result).rejects.toBe(failure);
    else await expect(result).resolves.toBeUndefined();
    expect(f.options.initialLoadFailed.value).toBe(true);
    expect(f.options.loadingInitial.value).toBe(false);
    if (throwOnFailure) expect(f.options.notice).not.toHaveBeenCalled();
    else
      expect(f.options.notice).toHaveBeenCalledWith(
        expect.stringContaining('HISTORY_UNAVAILABLE'),
        'error',
        failure
      );
  }
);

describe('Shared session selection', () => {
  it('retains unread across missing-connection and same-session retries, then reads after a real snapshot', async () => {
    const f = await watchedTabFixture();
    try {
      await f.service.openWorkspaceTabSession(f.session.id);
      await f.service.openWorkspaceTabSession(f.session.id);
      expect(f.watchPosts()).toHaveLength(0);
      expect(f.snapshot).not.toHaveBeenCalled();
      expect(f.readPosts).toEqual([]);
      expect(f.notifications.hasUnreadWorkspace('node-1', 'workspace-1')).toBe(true);
      expect(f.options.initialLoadFailed.value).toBe(true);
      f.connection.value = 'connection-1';
      const retry = f.service.openWorkspaceTabSession(f.session.id);
      await vi.waitFor(() => expect(f.watchPosts()).toHaveLength(1));
      expect(f.readPosts).toEqual([]);
      for (const mismatch of [
        { watchId: 'stale' },
        { nodeId: 'node-2' },
        { workspaceId: 'workspace-2' },
        { sessionId: 'other' },
        { workbenchConnectionId: 'stale' }
      ])
        expect(f.controller.handleEvent(f.frame(mismatch))).toBe(false);
      expect(f.controller.hasInitialSessionSnapshot(f.session.id)).toBe(false);
      expect(f.controller.handleEvent(f.frame())).toBe(true);
      await retry;
      expect(f.controller.hasInitialSessionSnapshot(f.session.id)).toBe(true);
      expect(f.readPosts).toEqual([f.session.id]);
      expect(f.notifications.hasUnreadWorkspace('node-1', 'workspace-1')).toBe(false);
      expect(f.options.initialLoadFailed.value).toBe(false);
      const scrolls = vi.mocked(f.options.scrollLatest).mock.calls.length;
      await f.service.openWorkspaceTabSession(f.session.id);
      expect(f.watchPosts()).toHaveLength(1);
      expect(f.options.scrollLatest).toHaveBeenCalledTimes(scrolls);
    } finally {
      f.dispose();
    }
  });

  it.each(['cancel', 'node', 'session', 'generation'] as const)(
    'does not read an unconfirmed snapshot after %s replacement',
    async (replacement) => {
      const f = await watchedTabFixture();
      try {
        f.connection.value = 'connection-1';
        const opening = f.service.openWorkspaceTabSession(f.session.id);
        await vi.waitFor(() => expect(f.watchPosts()).toHaveLength(1));
        const stale = f.frame();
        if (replacement === 'node')
          f.target.value = { nodeId: 'node-2', workspaceId: 'workspace-1' };
        if (replacement === 'session') f.options.selectedSessionId.value = 'another-session';
        if (replacement === 'generation') f.options.nextRequest();
        f.controller.stopSelectedSessionWatch();
        await opening;
        expect(f.controller.handleEvent(stale)).toBe(false);
        expect(f.controller.hasInitialSessionSnapshot(f.session.id)).toBe(false);
        expect(f.readPosts).toEqual([]);
        expect(f.notifications.hasUnreadWorkspace('node-1', 'workspace-1')).toBe(true);
        if (replacement === 'cancel') {
          expect(f.options.initialLoadFailed.value).toBe(true);
          const retry = f.service.openWorkspaceTabSession(f.session.id);
          await vi.waitFor(() => expect(f.watchPosts()).toHaveLength(2));
          expect(f.controller.handleEvent(stale)).toBe(false);
          f.controller.handleEvent(f.frame());
          await retry;
          expect(f.readPosts).toEqual([f.session.id]);
        }
      } finally {
        f.dispose();
      }
    }
  );

  it('waits for render completion after the initial snapshot before reading', async () => {
    const f = await watchedTabFixture();
    try {
      f.connection.value = 'connection-1';
      let render!: () => void;
      vi.mocked(f.options.beginInitialRender).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            render = resolve;
          })
      );
      const opening = f.service.openWorkspaceTabSession(f.session.id);
      await vi.waitFor(() => expect(f.watchPosts()).toHaveLength(1));
      f.controller.handleEvent(f.frame());
      expect(f.snapshot).toHaveBeenCalledOnce();
      expect(f.readPosts).toEqual([]);
      render();
      await opening;
      expect(f.readPosts).toEqual([f.session.id]);
    } finally {
      f.dispose();
    }
  });

  it('opens a pagination-external Tab target by identity and reads only after history succeeds', async () => {
    const f = tabSessionFixture();
    let finish!: () => void;
    vi.mocked(f.options.beginWatch).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = () => resolve(true);
        })
    );
    const pending = f.service.openWorkspaceTabSession(f.session.id);
    await vi.waitFor(() => expect(f.options.beginWatch).toHaveBeenCalledOnce());
    expect(f.options.markSessionRead).not.toHaveBeenCalled();
    await f.service.openWorkspaceTabSession(f.session.id);
    expect(f.options.request).toHaveBeenCalledOnce();
    finish();
    await pending;
    expect(f.options.markSessionRead).toHaveBeenCalledExactlyOnceWith(
      'node-1',
      'workspace-1',
      'outside-page'
    );
    const scrolls = vi.mocked(f.options.scrollLatest).mock.calls.length;
    await f.service.openWorkspaceTabSession(f.session.id);
    expect(f.options.request).toHaveBeenCalledOnce();
    expect(f.options.scrollLatest).toHaveBeenCalledTimes(scrolls);
  });

  it.each(['identity', 'history', 'unconfirmed', 'mismatch', 'superseded'] as const)(
    'does not read a Tab target after %s failure or replacement',
    async (failure) => {
      const f = tabSessionFixture();
      f.options.sessions.value = [f.session];
      if (failure === 'identity')
        vi.mocked(f.options.request).mockRejectedValue(new Error('FORBIDDEN'));
      if (failure === 'history')
        vi.mocked(f.options.beginWatch).mockRejectedValue(
          new Error('SESSION_HISTORY_INITIAL_FAILED')
        );
      if (failure === 'unconfirmed') vi.mocked(f.options.beginWatch).mockResolvedValue(false);
      if (failure === 'mismatch')
        vi.mocked(f.options.request).mockResolvedValue({
          session: { ...f.session, workspaceId: 'other-workspace' }
        });
      if (failure === 'superseded')
        vi.mocked(f.options.beginWatch).mockImplementation(async () => {
          f.options.nextRequest();
          return true;
        });
      await f.service.openWorkspaceTabSession(f.session.id);
      expect(f.options.markSessionRead).not.toHaveBeenCalled();
      if (failure !== 'superseded') expect(f.options.initialLoadFailed.value).toBe(true);
    }
  );

  it('keeps repeated session selection inert during and after loading while allowing explicit reload', async () => {
    const session: Session = { id: 'session-1', workspaceId: 'workspace-1', runner: 'mar-agent' };
    let finish!: (value: { session: Session }) => void;
    const request = vi.fn(() => new Promise<{ session: Session }>((resolve) => (finish = resolve)));
    const options: WorkbenchSessionSelectionOptions = {
      workspaceTarget: ref({ nodeId: 'node-1', workspaceId: 'workspace-1' }),
      selectedSessionId: ref(),
      selectedRunId: ref(),
      sessions: ref([session]),
      runs: ref([]),
      turns: ref([]),
      nextCursor: ref(null),
      loadingInitial: ref(false),
      initialLoadFailed: ref(false),
      contextUsage: ref(),
      queue: ref({ version: 0, paused: false, items: [] }),
      positioning: ref(false),
      draftOpen: ref(false),
      composerMode: ref('message'),
      selectedCommand: ref(),
      commandPickerOpen: ref(false),
      nextRequest: vi.fn(() => 1),
      currentRequest: () => 1,
      closeMobileSurface: vi.fn(),
      workspaceTabId: () => 'tab-1',
      ensureSessionVisible: vi.fn(),
      markSessionRead: vi.fn(),
      saveCurrent: vi.fn(),
      selectWorkspace: vi.fn(),
      applyComposerConfiguration: vi.fn(),
      restoreCachedDetail: () => undefined,
      cachedQueue: () => ({ version: 0, paused: false, items: [] }),
      restoreProjection: vi.fn(),
      resetProjection: vi.fn(),
      openRun: vi.fn(),
      scrollLatest: vi.fn(async () => undefined),
      beginInitialRender: vi.fn(async () => undefined),
      request: request as WorkbenchSessionSelectionOptions['request'],
      sessionPathId: (id) => id,
      replaceSession: vi.fn(),
      canWatch: () => true,
      beginWatch: vi.fn(async () => true),
      applySnapshot: vi.fn(() => false),
      mergeTurns: vi.fn(() => false),
      notice: vi.fn(),
      errorMessage: String
    };
    const service = createWorkbenchSessionSelectionService(options);
    const pending = service.selectSession(session.id);
    options.composerMode.value = 'steer';
    options.commandPickerOpen.value = true;
    await service.selectSession(session.id);
    expect(request).toHaveBeenCalledOnce();
    expect(options.nextRequest).toHaveBeenCalledOnce();
    expect(options.loadingInitial.value).toBe(true);
    finish({ session });
    await pending;
    const scrollCount = vi.mocked(options.scrollLatest).mock.calls.length;
    await service.selectSession(session.id);
    expect(request).toHaveBeenCalledOnce();
    expect(options.beginWatch).toHaveBeenCalledOnce();
    expect(options.scrollLatest).toHaveBeenCalledTimes(scrollCount);
    expect(options.composerMode.value).toBe('steer');
    expect(options.commandPickerOpen.value).toBe(true);
    expect(options.closeMobileSurface).toHaveBeenCalledTimes(3);
    expect(options.loadingInitial.value).toBe(false);

    request.mockResolvedValueOnce({ session });
    await service.openSession(session.id);
    expect(request).toHaveBeenCalledTimes(2);
    expect(options.beginWatch).toHaveBeenCalledTimes(2);
  });

  it('does not backfill older history after positioning the active Run from its cached initial view', async () => {
    const order: string[] = [];
    const runs = {
      value: [
        {
          id: 'run-stale',
          sessionId: 'session-1',
          status: 'RUNNING',
          recoveryState: 'LIVE',
          clientMessageId: 'message-stale'
        },
        {
          id: 'run-prior-session',
          sessionId: 'session-2',
          status: 'RUNNING',
          recoveryState: 'LIVE',
          clientMessageId: 'message-prior-session'
        }
      ]
    };
    const openRun = vi.fn();
    const sessions: { value: Session[] } = {
      value: [{ id: 'session-1', workspaceId: 'workspace-1', runner: 'codex' }]
    };
    const mergeTurns = vi.fn(() => {
      order.push('merge');
      return true;
    });
    const applySnapshot = vi.fn(() => {
      order.push('replace');
      return true;
    });
    const backfill = vi.fn(async () => {
      order.push('backfill');
    });
    const requests: string[] = [];
    const saveCurrent = vi.fn();
    let confirmInitialRender!: () => void;
    const failure = new Error('SESSION_HISTORY_INITIAL_FAILED');
    const service = createWorkbenchSessionSelectionService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      selectedSessionId: { value: 'session-1' },
      selectedRunId: { value: undefined },
      sessions,
      runs,
      turns: { value: [] },
      nextCursor: { value: null },
      loadingInitial: { value: false },
      initialLoadFailed: { value: false },
      contextUsage: { value: undefined },
      queue: { value: { version: 0, paused: false, items: [] } },
      positioning: { value: false },
      draftOpen: { value: false },
      composerMode: { value: 'message' },
      selectedCommand: { value: undefined },
      commandPickerOpen: { value: false },
      nextRequest: () => 1,
      currentRequest: () => 1,
      closeMobileSurface: vi.fn(),
      workspaceTabId: () => 'tab-1',
      ensureSessionVisible: vi.fn(),
      markSessionRead: vi.fn(),
      saveCurrent,
      selectWorkspace: vi.fn(),
      applyComposerConfiguration: vi.fn(),
      restoreCachedDetail: () => undefined,
      cachedQueue: () => ({ version: 0, paused: false, items: [] }),
      restoreProjection: vi.fn(),
      resetProjection: vi.fn(),
      openRun,
      scrollLatest: async () => {
        order.push('scroll');
      },
      beginInitialRender: () => {
        order.push('render');
        return new Promise<void>((resolve) => {
          confirmInitialRender = resolve;
        });
      },
      refreshContext: async () => undefined,
      request: async (path: string) => {
        requests.push(path);
        if (path.includes('/turns?'))
          return {
            unit: 'SEGMENT',
            segments: [],
            nextCursor: 'runtime-boundary',
            snapshotSequence: 1,
            source: 'runtime',
            readAt: 1,
            latestVisibleAt: 1,
            deferredOlderHistory: true
          };
        return {
          session: {
            id: 'session-1',
            workspaceId: 'workspace-1',
            runner: 'codex',
            activity: 'IDLE'
          }
        };
      },
      sessionPathId: (value: string) => value,
      replaceSession: (_previousId: string, next: Session) => {
        sessions.value = [next];
      },
      canWatch: () => false,
      beginWatch: async () => true,
      applySnapshot,
      mergeTurns,
      notice: vi.fn(),
      errorMessage: String
    } as never);

    const opening = service.openSession('session-1', { skipSaveCurrent: true });
    await vi.waitFor(() => expect(order).toEqual(['render', 'merge']));
    expect(backfill).not.toHaveBeenCalled();
    confirmInitialRender();
    await opening;
    expect(saveCurrent).toHaveBeenCalledOnce();
    await Promise.resolve();

    expect(applySnapshot).not.toHaveBeenCalled();
    expect(mergeTurns).toHaveBeenCalledWith(
      expect.objectContaining({ deferredOlderHistory: true })
    );
    expect(openRun).toHaveBeenCalledWith('run-stale');
    expect(sessions.value[0]?.activity).toBe('MANAGED_ACTIVE');
    expect(backfill).not.toHaveBeenCalled();
    expect(requests).not.toContain('/api/agent-sessions/session-1/runs?nodeId=node-1');
    expect(requests).not.toContain('/api/agent-sessions/session-1/context?nodeId=node-1');
    expect(order).toEqual(['render', 'merge', 'scroll']);
  });
  it('applies the initial Watch snapshot and marks notifications read when switching to a cached session', async () => {
    const order: string[] = [];
    const markSessionRead = vi.fn();
    const applySnapshot = vi.fn((sessionId: string, page: unknown) => {
      void sessionId;
      void page;
      return true;
    });
    const initialPage = { turns: [turn('turn-watch')], nextCursor: null };
    const sessions: { value: Session[] } = {
      value: [{ id: 'session-1', workspaceId: 'workspace-1', runner: 'codex' }]
    };
    const service = createWorkbenchSessionSelectionService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      selectedSessionId: { value: undefined },
      selectedRunId: { value: undefined },
      sessions,
      runs: { value: [] },
      turns: { value: [] },
      nextCursor: { value: null },
      loadingInitial: { value: false },
      initialLoadFailed: { value: false },
      contextUsage: { value: undefined },
      queue: { value: { version: 0, paused: false, items: [] } },
      positioning: { value: false },
      draftOpen: { value: false },
      composerMode: { value: 'message' },
      selectedCommand: { value: undefined },
      commandPickerOpen: { value: false },
      nextRequest: () => 1,
      currentRequest: () => 1,
      closeMobileSurface: vi.fn(),
      workspaceTabId: () => 'tab-1',
      ensureSessionVisible: vi.fn(),
      markSessionRead,
      saveCurrent: vi.fn(),
      selectWorkspace: vi.fn(),
      applyComposerConfiguration: vi.fn(),
      restoreCachedDetail: () => undefined,
      cachedQueue: () => ({ version: 0, paused: false, items: [] }),
      restoreProjection: vi.fn(),
      resetProjection: vi.fn(),
      openRun: vi.fn(),
      scrollLatest: async () => undefined,
      beginInitialRender: async () => {
        order.push('render');
      },
      refreshContext: async () => undefined,
      request: async (path: string) => {
        if (path.includes('/turns?')) return { turns: [], nextCursor: null };
        return {
          session: {
            id: 'session-1',
            workspaceId: 'workspace-1',
            runner: 'codex',
            activity: 'IDLE'
          }
        };
      },
      sessionPathId: (value: string) => value,
      replaceSession: vi.fn(),
      canWatch: () => true,
      beginWatch: async () => {
        order.push('snapshot');
        applySnapshot('session-1', initialPage);
        return true;
      },
      applySnapshot,
      mergeTurns: () => false,
      notice: vi.fn(),
      errorMessage: String
    } as never);

    await service.selectSession('session-1');

    expect(markSessionRead).toHaveBeenCalledWith('node-1', 'workspace-1', 'session-1');
    expect(applySnapshot).toHaveBeenCalledWith('session-1', initialPage);
    expect(order).toEqual(['render', 'snapshot']);
  });
  it('replaces provisional Composer configuration with authoritative session details', async () => {
    const provisional: Session = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'mar-agent',
      model: null
    };
    const authoritative: Session = {
      ...provisional,
      model: 'model-b',
      effort: 'high',
      access: 'full-access'
    };
    const applyComposerConfiguration = vi.fn();
    const service = createWorkbenchSessionSelectionService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      selectedSessionId: { value: undefined },
      selectedRunId: { value: undefined },
      sessions: { value: [provisional] },
      runs: { value: [] },
      turns: { value: [] },
      nextCursor: { value: null },
      loadingInitial: { value: false },
      initialLoadFailed: { value: false },
      contextUsage: { value: undefined },
      queue: { value: { version: 0, paused: false, items: [] } },
      positioning: { value: false },
      draftOpen: { value: false },
      composerMode: { value: 'message' },
      selectedCommand: { value: undefined },
      commandPickerOpen: { value: false },
      nextRequest: () => 1,
      currentRequest: () => 1,
      closeMobileSurface: vi.fn(),
      workspaceTabId: () => 'tab-1',
      ensureSessionVisible: vi.fn(),
      markSessionRead: vi.fn(),
      saveCurrent: vi.fn(),
      selectWorkspace: vi.fn(),
      applyComposerConfiguration,
      restoreCachedDetail: () => undefined,
      cachedQueue: () => ({ version: 0, paused: false, items: [] }),
      restoreProjection: vi.fn(),
      resetProjection: vi.fn(),
      openRun: vi.fn(),
      scrollLatest: async () => undefined,
      beginInitialRender: async () => undefined,
      request: async (path: string) =>
        path.includes('/turns?') ? { turns: [], nextCursor: null } : { session: authoritative },
      sessionPathId: (value: string) => value,
      replaceSession: vi.fn(),
      canWatch: () => false,
      beginWatch: async () => true,
      applySnapshot: vi.fn(),
      mergeTurns: vi.fn(() => false),
      notice: vi.fn(),
      errorMessage: String
    } as never);

    await service.openSession('session-1');

    expect(applyComposerConfiguration).toHaveBeenNthCalledWith(1, provisional, false);
    expect(applyComposerConfiguration).toHaveBeenNthCalledWith(2, authoritative, true);
  });
  it('preserves the initial-load failure state so the user can reload after Session Watch initial fails', async () => {
    const initialLoadFailed = { value: false };
    const notice = vi.fn();
    const failure = new Error('SESSION_HISTORY_INITIAL_FAILED');
    const service = createWorkbenchSessionSelectionService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      selectedSessionId: { value: undefined },
      selectedRunId: { value: undefined },
      sessions: {
        value: [{ id: 'session-1', workspaceId: 'workspace-1', runner: 'codex' }]
      },
      runs: { value: [] },
      turns: { value: [] },
      nextCursor: { value: null },
      loadingInitial: { value: false },
      initialLoadFailed,
      contextUsage: { value: undefined },
      queue: { value: { version: 0, paused: false, items: [] } },
      positioning: { value: false },
      draftOpen: { value: false },
      composerMode: { value: 'message' },
      selectedCommand: { value: undefined },
      commandPickerOpen: { value: false },
      nextRequest: () => 1,
      currentRequest: () => 1,
      closeMobileSurface: vi.fn(),
      workspaceTabId: () => 'tab-1',
      ensureSessionVisible: vi.fn(),
      markSessionRead: vi.fn(),
      saveCurrent: vi.fn(),
      selectWorkspace: vi.fn(),
      applyComposerConfiguration: vi.fn(),
      restoreCachedDetail: () => undefined,
      cachedQueue: () => ({ version: 0, paused: false, items: [] }),
      restoreProjection: vi.fn(),
      resetProjection: vi.fn(),
      openRun: vi.fn(),
      scrollLatest: vi.fn(),
      beginInitialRender: vi.fn(),
      refreshContext: vi.fn(),
      request: async () => ({
        session: {
          id: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'codex',
          activity: 'IDLE'
        }
      }),
      sessionPathId: (value: string) => value,
      replaceSession: vi.fn(),
      canWatch: () => true,
      beginWatch: async () => {
        throw failure;
      },
      applySnapshot: vi.fn(),
      mergeTurns: vi.fn(),
      notice,
      errorMessage: (error: unknown) => (error as Error).message
    } as never);

    await service.openSession('session-1');

    expect(initialLoadFailed.value).toBe(true);
    expect(notice).toHaveBeenCalledWith(
      expect.stringContaining('SESSION_HISTORY_INITIAL_FAILED'),
      'error',
      failure
    );
  });
});
