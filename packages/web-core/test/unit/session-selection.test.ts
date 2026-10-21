import { workspaceTargetRef } from './support/workspace-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createWorkbenchSessionSelectionService } from '../../src/service/WorkbenchSessionSelectionService.js';
import type { WorkbenchSessionSelectionOptions } from '../../src/service/WorkbenchSessionSelectionService.js';
import type { Session } from '../../src/model/workbench.js';
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
  let revision = 0;
  const options: WorkbenchSessionSelectionOptions = {
    workspaceTarget: ref({ nodeId: 'node-1', workspaceId: 'workspace-1' }),
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
    beginWatch: vi.fn(async () => undefined),
    applySnapshot: vi.fn(() => false),
    mergeTurns: vi.fn(() => false),
    notice: vi.fn(),
    errorMessage: String
  };
  return { session, options, service: createWorkbenchSessionSelectionService(options) };
}

describe('Shared session selection', () => {
  it('opens a pagination-external Tab target by identity and reads only after history succeeds', async () => {
    const f = tabSessionFixture();
    let finish!: () => void;
    vi.mocked(f.options.beginWatch).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
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

  it.each(['identity', 'history', 'mismatch', 'superseded'] as const)(
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
      if (failure === 'mismatch')
        vi.mocked(f.options.request).mockResolvedValue({
          session: { ...f.session, workspaceId: 'other-workspace' }
        });
      if (failure === 'superseded')
        vi.mocked(f.options.beginWatch).mockImplementation(async () => {
          f.options.nextRequest();
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
      beginWatch: vi.fn(async () => undefined),
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
      beginWatch: async () => undefined,
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
      beginWatch: async () => undefined,
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
        throw new Error('SESSION_HISTORY_INITIAL_FAILED');
      },
      applySnapshot: vi.fn(),
      mergeTurns: vi.fn(),
      notice,
      errorMessage: (error: unknown) => (error as Error).message
    } as never);

    await service.openSession('session-1');

    expect(initialLoadFailed.value).toBe(true);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('SESSION_HISTORY_INITIAL_FAILED'));
  });
});
