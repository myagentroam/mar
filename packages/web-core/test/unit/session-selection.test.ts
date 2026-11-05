import { workspaceTargetRef } from './support/workspace-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, watch } from 'vue';
import { createWorkbenchSessionSelectionService } from '../../src/service/workbench-session-selection-service.js';
import {
  createWorkspaceSessionPaneReader,
  createWorkspaceSessionPaneState
} from '../../src/service/workspace-session-pane-state.js';
import { createWorkspaceSessionPaneLoader } from '../../src/service/workspace-session-pane-loader.js';
import { createWorkbenchSubmissionOwner } from '../../src/service/workbench-submission-service.js';
import { createSessionDraftService } from '../../src/service/session-draft-service.js';
import { createComposerAttachmentService } from '../../src/service/composer-attachment-service.js';
import type { WorkbenchSessionSelectionOptions } from '../../src/service/workbench-session-selection-service.js';
import type { Session } from '../../src/model/workbench.js';
import { createWorkbenchSessionWatchController } from '../../src/service/workbench-session-watch-controller.js';
import { createWorkbenchNotificationService } from '../../src/service/workbench-notification-service.js';
import { createWorkbenchWatchCoordinator } from '../../src/service/workbench-watch-coordinator.js';
import { createRunService } from '../../src/service/run-service.js';
import { createWorkbenchAsideService } from '../../src/service/workbench-aside-service.js';
import { conversationProjectionFixture } from './support/conversation-paging-fixture.js';
const paneSubmissions = createWorkbenchSubmissionOwner();
type SelectionFixtureOptions = Omit<WorkbenchSessionSelectionOptions, 'createPaneLoader'> & {
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  sessionPathId: (sessionId: string) => string;
};
function createSelection(options: SelectionFixtureOptions) {
  const reader = createWorkspaceSessionPaneReader();
  return createWorkbenchSessionSelectionService(
    Object.assign(options, {
      createPaneLoader: (projection) =>
        createWorkspaceSessionPaneLoader({
          ...projection,
          runs: options.runs,
          readSession: (nodeId, sessionId) =>
            reader.read(nodeId, sessionId, options.request, options.sessionPathId),
          readInitialHistory: (nodeId, sessionId) =>
            reader.readInitialHistory(nodeId, sessionId, options.request, options.sessionPathId)
        })
    } satisfies Pick<WorkbenchSessionSelectionOptions, 'createPaneLoader'>)
  );
}
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
function tabSessionFixture(sessionTabLimit = 1) {
  const session: Session = { id: 'outside-page', workspaceId: 'workspace-1', runner: 'mar-agent' };
  const target = ref({ nodeId: 'node-1', workspaceId: 'workspace-1' });
  const selectedSessionId = ref<string>();
  const runOwner = createRunService(selectedSessionId);
  const runs = runOwner.runs;
  const turns = ref<import('../../src/model/workbench.js').ConversationTurn[]>([]);
  const conversationOwner = conversationProjectionFixture(turns, ref<string | null>(null));
  const aside = createWorkbenchAsideService(sessionTabLimit);
  aside.ensure(target.value, ['files', 'terminal']);
  let revision = 0;
  const options: SelectionFixtureOptions = {
    aside,
    canOpenAside: () => true,
    saveAside: vi.fn(),
    workspaceTarget: target,
    selectedSessionId,
    selectedRunId: ref(),
    sessions: ref([]),
    runs,
    turns,
    loadingInitial: ref(false),
    initialLoadFailed: ref(false),
    initialFailureCause: ref<unknown>(),
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
    installCachedDetail: (detail) => {
      runOwner.replaceRuns(detail.runs);
      conversationOwner.restoreWindow(detail.turns, detail.nextCursor);
    },
    clearActiveContent: () => {
      runOwner.replaceRuns([]);
      conversationOwner.restoreWindow([], null);
    },
    openRun: vi.fn(),
    scrollLatest: vi.fn(async () => undefined),
    beginInitialRender: vi.fn(async () => undefined),
    request: vi.fn(async () => ({ session })) as SelectionFixtureOptions['request'],
    sessionPathId: (id) => id,
    replaceSession: vi.fn(),
    canWatch: () => true,
    hasInitialSnapshot: () => true,
    beginWatch: vi.fn(async () => true),
    applySnapshot: vi.fn(() => false),
    mergeTurns: vi.fn(() => false)
  };
  return {
    session,
    target,
    aside,
    options,
    runs,
    turns,
    service: createSelection(options)
  };
}

describe('Synchronous Session handoff', () => {
  it('does not apply an old Workspace response to an equal Session id in another Workspace', async () => {
    const fixture = tabSessionFixture();
    let resolve!: (value: { session: Session }) => void;
    fixture.options.request = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    ) as SelectionFixtureOptions['request'];
    const service = createSelection(fixture.options);
    const opening = service.openSession(fixture.session.id);
    await vi.waitFor(() => expect(fixture.options.request).toHaveBeenCalledOnce());
    fixture.target.value = { nodeId: 'node-1', workspaceId: 'workspace-2' };
    resolve({ session: fixture.session });
    await opening;
    expect(fixture.options.replaceSession).not.toHaveBeenCalled();
    expect(fixture.options.applyComposerConfiguration).not.toHaveBeenCalledWith(
      fixture.session,
      true
    );
    expect(fixture.options.beginWatch).not.toHaveBeenCalled();
  });
  it('does not start a superseded read after a synchronous selection opens another session', async () => {
    const fixture = tabSessionFixture();
    const next = { ...fixture.session, id: 'session-next' };
    fixture.options.sessions.value.push(next);
    fixture.options.request = vi.fn(async () => ({
      session: next
    })) as SelectionFixtureOptions['request'];
    vi.spyOn(fixture.options, 'restoreCachedDetail').mockImplementation((id) => ({
      sessionId: id,
      contextUsage: undefined,
      lastAccessedAt: 1,
      runs: [
        {
          id: `run-${id}`,
          sessionId: id,
          status: 'RUNNING',
          recoveryState: '',
          clientMessageId: ''
        }
      ],
      turns: [],
      nextCursor: null
    }));
    vi.spyOn(fixture.options, 'openRun').mockImplementation((id) => {
      fixture.options.selectedRunId.value = id;
    });
    const service = createSelection(fixture.options);
    let second: Promise<void> | undefined;
    const stop = watch(
      fixture.options.selectedSessionId,
      (id) => {
        if (id === fixture.session.id && second === undefined)
          second = service.openSession(next.id);
      },
      { flush: 'sync' }
    );
    await service.openSession(fixture.session.id);
    await second;
    stop();
    expect(fixture.options.selectedSessionId.value).toBe(next.id);
    expect(fixture.options.openRun).toHaveBeenCalled();
    expect(
      vi.mocked(fixture.options.openRun).mock.calls.every(([id]) => id === `run-${next.id}`)
    ).toBe(true);
    expect(fixture.options.openRun).toHaveBeenCalledWith(`run-${next.id}`);
    expect(fixture.options.selectedRunId.value).toBe(`run-${next.id}`);
    expect(fixture.options.request).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fixture.options.request).mock.calls[0]![0]).toContain('/session-next?');
  });
  it('opens the same session independently in Main and Aside', async () => {
    const f = tabSessionFixture(3);
    f.options.selectedSessionId.value = 'main';
    expect(f.service.openAsideSession({ ...f.target.value, sessionId: 'main' })).toBe(true);
    expect(f.aside.current(f.target.value).sessions).toEqual(['main']);
    expect(f.service.openAsideSession({ ...f.target.value, sessionId: 'other' })).toBe(true);
    expect(f.service.openAsideSession({ ...f.target.value, sessionId: f.session.id })).toBe(true);
    expect(f.aside.current(f.target.value).sessions).toEqual(['main', 'other', f.session.id]);
    const opening = f.service.selectSession(f.session.id);
    expect(f.aside.current(f.target.value).sessions).toEqual(['main', 'other', f.session.id]);
    expect(f.aside.current(f.target.value).active).toEqual({
      kind: 'session',
      sessionId: f.session.id
    });
    await opening;
    expect(f.options.selectedSessionId.value).toBe(f.session.id);
  });
  it('saves the outgoing Aside before replacing its sole tab and leaves Main unchanged', () => {
    const f = tabSessionFixture();
    f.options.selectedSessionId.value = 'main';
    f.service.openAsideSession({ ...f.target.value, sessionId: 'a' });
    const saved: unknown[] = [];
    vi.mocked(f.options.saveAside).mockImplementation(() => {
      saved.push(f.aside.current(f.target.value).active);
    });
    f.service.openAsideSession({ ...f.target.value, sessionId: 'b' });
    expect(saved).toEqual([{ kind: 'session', sessionId: 'a' }]);
    expect(f.aside.current(f.target.value).sessions).toEqual(['b']);
    expect(f.options.selectedSessionId.value).toBe('main');
    expect(f.service.openAsideSession({ ...f.target.value, sessionId: 'main' })).toBe(true);
    expect(f.aside.current(f.target.value).sessions).toEqual(['main']);
    f.service.removeMissingAside(f.target.value, ['a']);
    expect(f.aside.current(f.target.value).sessions).toEqual(['main']);
  });
  it('does not mutate Aside when capability is absent, and does not reload the active target', () => {
    const f = tabSessionFixture();
    vi.spyOn(f.options, 'canOpenAside').mockReturnValue(false);
    expect(f.service.openAsideSession({ ...f.target.value, sessionId: 'child' })).toBe(false);
    expect(f.aside.current(f.target.value).sessions).toEqual([]);
    vi.spyOn(f.options, 'canOpenAside').mockReturnValue(true);
    expect(f.service.openAsideSession({ ...f.target.value, sessionId: 'child' })).toBe(true);
    expect(f.service.openAsideSession({ ...f.target.value, sessionId: 'child' })).toBe(true);
    expect(f.options.saveAside).toHaveBeenCalledOnce();
    expect(f.options.request).not.toHaveBeenCalled();
  });
  it('rebinds an Aside identity only in its captured Workspace, including the Main target', () => {
    const f = tabSessionFixture();
    f.options.selectedSessionId.value = 'main';
    const old = { ...f.target.value, sessionId: 'child' };
    f.service.openAsideSession(old);
    expect(f.service.replaceAsideSession(old, 'child-new')).toBe(true);
    expect(f.aside.current(f.target.value).active).toEqual({
      kind: 'session',
      sessionId: 'child-new'
    });
    expect(f.aside.current(f.target.value).sessions).toEqual(['child-new']);
    expect(f.service.replaceAsideSession(old, 'stale')).toBe(false);
    const next = { ...f.target.value, sessionId: 'child-new' };
    expect(f.service.replaceAsideSession(next, 'main')).toBe(true);
    expect(f.aside.current(f.target.value).sessions).toEqual(['main']);
  });
  it.each(['workspace', 'node'] as const)(
    'ignores stale Aside intents after switching %s even when session ids match',
    (changed) => {
      const f = tabSessionFixture();
      const old = { ...f.target.value, sessionId: 'same-id' };
      f.aside.openSession(old);
      f.target.value = {
        nodeId: changed === 'node' ? 'other-node' : old.nodeId,
        workspaceId: changed === 'workspace' ? 'other-workspace' : old.workspaceId
      };
      const current = { ...f.target.value, sessionId: 'same-id' };
      f.aside.openSession(current);
      expect(f.service.openAsideSession(old)).toBe(false);
      f.service.closeAsideSession(old);
      expect(f.aside.current(current).sessions).toEqual(['same-id']);
      expect(f.aside.current(old).sessions).toEqual(['same-id']);
    }
  );
  it('does not remove an Aside target in another Workspace when Main opens an equal session id', async () => {
    const f = tabSessionFixture();
    f.aside.openSession({ ...f.target.value, sessionId: 'same-id' });
    f.options.sessions.value = [
      { id: 'same-id', workspaceId: 'different-workspace', runner: 'mar-agent' }
    ];
    const opening = f.service.openSession('same-id');
    expect(f.aside.current(f.target.value).sessions).toEqual(['same-id']);
    await opening;
  });
  it('removes only authoritatively missing Aside targets in the snapshot workspace', () => {
    const f = tabSessionFixture(3);
    const otherWorkspace = { nodeId: 'node-1', workspaceId: 'other' };
    f.aside.openSession({ ...f.target.value, sessionId: 'keep' });
    f.aside.openSession({ ...f.target.value, sessionId: 'gone' });
    f.aside.openSession({ ...otherWorkspace, sessionId: 'gone' });
    f.service.removeMissingAside(f.target.value, ['gone', 'not-open']);
    expect(f.aside.current(f.target.value).sessions).toEqual(['keep']);
    expect(f.aside.current(otherWorkspace).sessions).toEqual(['gone']);
    expect(f.options.saveAside).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    'finishes selection without waiting for notification read acknowledgement: alreadyOpen=%s',
    async (alreadyOpen) => {
      const f = tabSessionFixture();
      if (alreadyOpen) f.options.selectedSessionId.value = f.session.id;
      let releaseRead!: () => void;
      const pendingRead = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const read = vi.spyOn(f.options, 'markSessionRead').mockImplementation(() => pendingRead);
      let opened = false;
      const opening = f.service.selectSession(f.session.id).then(() => {
        opened = true;
      });
      try {
        await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(opened).toBe(true));
        expect(f.options.loadingInitial.value).toBe(false);
        expect(f.options.initialLoadFailed.value).toBe(false);
      } finally {
        releaseRead();
        await opening;
      }
    }
  );

  it.each(['uncached', 'cached'] as const)(
    'never exposes a new Session with the previous %s window to synchronous observers',
    async (mode) => {
      const f = tabSessionFixture();
      f.options.selectedSessionId.value = 'previous';
      f.options.sessions.value = [
        { id: 'previous', workspaceId: 'workspace-1', runner: 'mar-agent' },
        f.session
      ];
      f.turns.value = [turn('old', { sessionId: 'previous' })];
      const previousWindow = f.turns.value;
      if (mode === 'cached')
        vi.spyOn(f.options, 'restoreCachedDetail').mockImplementation(() => {
          const detail = {
            sessionId: f.session.id,
            runs: [],
            turns: [turn('cached', { sessionId: f.session.id })],
            nextCursor: null,
            contextUsage: null,
            lastAccessedAt: 1
          };
          return detail;
        });
      const invalid: string[] = [];
      const stop = watch(
        [f.options.selectedSessionId, f.turns],
        ([id, turns]) => {
          if (id === f.session.id && turns.some((item) => item.sessionId === 'previous'))
            invalid.push(id);
        },
        { flush: 'sync' }
      );
      try {
        await f.service.openSession(f.session.id);
        expect(invalid).toEqual([]);
        expect(f.options.selectedSessionId.value).toBe(f.session.id);
        expect(previousWindow.map((item) => item.id)).toEqual(['old']);
      } finally {
        stop();
      }
    }
  );
});

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
    }) as SelectionFixtureOptions['request']
  });
  await notifications.load();
  const snapshot = vi.fn(() => true);
  const watchRequest = vi.fn(async (_path: string, _init?: RequestInit) => ({
    nodeGeneration: 'generation'
  }));
  const controller = createWorkbenchSessionWatchController({
    workspaceTarget: f.target,
    selectedSessionId: f.options.selectedSessionId,
    followConversation: ref(false),
    heartbeatMs: 15_000,
    workbenchConnectionId: () => connection.value,
    requestTimeoutMs: 10_000,
    confirmationTimeoutMs: 45_000,
    request: watchRequest as SelectionFixtureOptions['request'],
    sessionPathId: (id) => id,
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
    hasInitialSnapshot: controller.hasInitialSessionSnapshot,
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
    expect(f.options.initialFailureCause.value).toBe(failure);
  }
);

describe('Shared session selection', () => {
  it.each([true, false])(
    'protects cached positioning while Watch is pending: %s',
    async (watchPending) => {
      const f = tabSessionFixture();
      const cachedTurns = [
        turn('cached-turn', {
          items: [{ id: 'reply', kind: 'assistant_message', payload: { text: 'Cached reply' } }]
        })
      ];
      vi.spyOn(f.options, 'restoreCachedDetail').mockImplementation(() => {
        return {
          sessionId: f.session.id,
          runs: [],
          turns: cachedTurns,
          nextCursor: null,
          contextUsage: null,
          lastAccessedAt: 1
        };
      });
      let finishPositioning!: () => void;
      vi.mocked(f.options.scrollLatest).mockImplementation(
        () => new Promise<void>((resolve) => (finishPositioning = resolve))
      );
      let finishWatch!: (loaded: boolean) => void;
      vi.mocked(f.options.beginWatch).mockImplementation(() =>
        watchPending
          ? new Promise<boolean>((resolve) => (finishWatch = resolve))
          : Promise.resolve(true)
      );

      const opening = f.service.openSession(f.session.id);
      expect(f.options.positioning.value).toBe(true);
      expect(f.options.scrollLatest).not.toHaveBeenCalled();
      await nextTick();
      expect(f.options.scrollLatest).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(f.options.beginWatch).toHaveBeenCalledOnce());
      expect(f.service.loadingInitialContent.value).toBe(false);
      expect(f.options.positioning.value).toBe(true);
      finishPositioning();
      await nextTick();
      expect(f.options.positioning.value).toBe(false);
      if (watchPending) {
        expect(f.options.loadingInitial.value).toBe(true);
        finishWatch(true);
      }
      await opening;
      expect(f.options.scrollLatest).toHaveBeenCalledOnce();
    }
  );

  it.each([true, false])(
    'releases cached positioning only when it still owns the guard (new cache: %s)',
    async (openAnotherCache) => {
      const f = tabSessionFixture();
      vi.spyOn(f.options, 'restoreCachedDetail').mockImplementation((sessionId) => {
        const turns = [
          turn('cached-turn', {
            sessionId,
            items: [{ id: 'reply', kind: 'assistant_message', payload: { text: 'Cached reply' } }]
          })
        ];
        return {
          sessionId,
          runs: [],
          turns,
          nextCursor: null,
          contextUsage: null,
          lastAccessedAt: 1
        };
      });
      const finishPositioning: (() => void)[] = [];
      vi.mocked(f.options.scrollLatest).mockImplementation(
        () => new Promise<void>((resolve) => finishPositioning.push(resolve))
      );
      const first = f.service.openSession(f.session.id);
      await nextTick();
      let second: Promise<void> | undefined;
      if (openAnotherCache) {
        second = f.service.openSession('another-session');
        await nextTick();
      } else {
        // Opening a draft invalidates the detail request without opening another session.
        f.options.nextRequest();
        f.options.selectedSessionId.value = undefined;
        f.turns.value = [];
      }
      finishPositioning[0]!();
      await first;
      expect(f.options.positioning.value).toBe(openAnotherCache);
      if (second !== undefined) {
        finishPositioning[1]!();
        await second;
        expect(f.options.positioning.value).toBe(false);
      }
    }
  );

  it('does not start cached calibration after reading intent cancels the pre-layout guard', async () => {
    const f = tabSessionFixture();
    vi.spyOn(f.options, 'restoreCachedDetail').mockImplementation(() => {
      const turns = [
        turn('cached-turn', {
          items: [{ id: 'reply', kind: 'assistant_message', payload: { text: 'Cached reply' } }]
        })
      ];
      return {
        sessionId: f.session.id,
        runs: [],
        turns,
        nextCursor: null,
        contextUsage: null,
        lastAccessedAt: 1
      };
    });
    const opening = f.service.openSession(f.session.id);
    f.options.positioning.value = false;
    await opening;
    expect(f.options.scrollLatest).not.toHaveBeenCalled();
  });

  it('keeps restored content readable and preserves reading position across Watch synchronization', async () => {
    const f = tabSessionFixture();
    let scrollTop = 0;
    vi.mocked(f.options.scrollLatest).mockImplementation(async () => {
      scrollTop = 1_000;
    });
    const cachedTurns = [
      turn('cached-turn', {
        items: [
          {
            id: 'cached-reply',
            kind: 'assistant_message',
            status: 'COMPLETED',
            payload: { text: 'Cached reply' }
          }
        ]
      })
    ];
    vi.spyOn(f.options, 'restoreCachedDetail').mockImplementation(() => {
      return {
        sessionId: f.session.id,
        runs: [],
        turns: cachedTurns,
        nextCursor: null,
        contextUsage: undefined,
        lastAccessedAt: 1
      };
    });
    let resolveWatch!: (loaded: boolean) => void;
    vi.spyOn(f.options, 'beginWatch').mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveWatch = resolve;
        })
    );
    vi.spyOn(f.options, 'hasInitialSnapshot').mockReturnValue(false);
    const opening = f.service.openWorkspaceTabSession(f.session.id);
    await vi.waitFor(() => expect(f.options.beginWatch).toHaveBeenCalledOnce());
    expect(f.turns.value).toEqual(cachedTurns);
    expect(f.options.loadingInitial.value).toBe(true);
    expect(f.service.loadingInitialContent.value).toBe(false);
    expect(f.options.beginInitialRender).not.toHaveBeenCalled();
    expect(f.options.scrollLatest).toHaveBeenCalledOnce();
    // The user can read cached history before the authoritative snapshot arrives.
    scrollTop = 120;
    await f.service.openWorkspaceTabSession(f.session.id);
    expect(f.options.beginWatch).toHaveBeenCalledOnce();
    resolveWatch(true);
    await opening;
    expect(f.options.beginInitialRender).not.toHaveBeenCalled();
    expect(scrollTop).toBe(120);
    expect(f.options.scrollLatest).toHaveBeenCalledOnce();
  });

  it('retains readable content and exposes retry after background synchronization fails', async () => {
    const f = tabSessionFixture();
    f.options.selectedSessionId.value = f.session.id;
    const cachedTurns = [
      turn('cached-turn', {
        items: [
          {
            id: 'reply',
            kind: 'assistant_message',
            status: 'COMPLETED',
            payload: { text: 'Cached reply' }
          }
        ]
      })
    ];
    f.turns.value = cachedTurns;
    vi.mocked(f.options.beginWatch).mockRejectedValue(new Error('HISTORY_UNAVAILABLE'));
    await f.service.openSession(f.session.id);
    expect(f.turns.value).toEqual(cachedTurns);
    expect(f.options.initialLoadFailed.value).toBe(true);
    expect(f.options.loadingInitial.value).toBe(false);
    expect(f.service.loadingInitialContent.value).toBe(false);
    expect(f.options.beginInitialRender).not.toHaveBeenCalled();
    expect(f.options.initialFailureCause.value).toEqual(new Error('HISTORY_UNAVAILABLE'));
  });

  it('waits for the snapshot before requesting the first layout and keeps loading until layout completes', async () => {
    const f = tabSessionFixture();
    let resolveWatch!: (loaded: boolean) => void;
    let resolveRender!: () => void;
    vi.spyOn(f.options, 'beginWatch').mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveWatch = resolve;
        })
    );
    vi.spyOn(f.options, 'beginInitialRender').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRender = resolve;
        })
    );
    const opening = f.service.openSession(f.session.id);
    await vi.waitFor(() => expect(f.options.beginWatch).toHaveBeenCalledOnce());
    expect(f.options.beginInitialRender).not.toHaveBeenCalled();
    expect(f.options.loadingInitial.value).toBe(true);
    resolveWatch(true);
    await vi.waitFor(() => expect(f.options.beginInitialRender).toHaveBeenCalledOnce());
    expect(f.options.loadingInitial.value).toBe(true);
    resolveRender();
    await opening;
    expect(f.options.loadingInitial.value).toBe(false);
  });

  it.each([false, true])(
    'keeps Watch cancellation silent without reporting transactional success: %s',
    async (throwOnFailure) => {
      const f = tabSessionFixture();
      const cancellation = new Error('WATCH_CANCELLED');
      vi.mocked(f.options.beginWatch).mockRejectedValue(cancellation);
      const result = f.service.openSession(f.session.id, { throwOnFailure });
      if (throwOnFailure) await expect(result).rejects.toBe(cancellation);
      else await expect(result).resolves.toBeUndefined();
      expect(f.options.initialLoadFailed.value).toBe(false);
      expect(f.options.loadingInitial.value).toBe(false);
      expect(f.options.initialFailureCause.value).toBeUndefined();
    }
  );

  it('does not silently discard an unclassified AbortError', async () => {
    const f = tabSessionFixture();
    const failure = new DOMException('The operation was aborted.', 'AbortError');
    vi.mocked(f.options.beginWatch).mockRejectedValue(failure);
    await f.service.openSession(f.session.id);
    expect(f.options.initialLoadFailed.value).toBe(true);
    expect(f.options.initialFailureCause.value).toBe(failure);
  });

  it.each(['read', 'render'] as const)(
    'does not continue selection after its scope stops during initial %s',
    async (pendingStage) => {
      const f = tabSessionFixture();
      let readSignal: AbortSignal | undefined;
      if (pendingStage === 'read') {
        f.options.request = vi.fn(
          (_path: string, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              readSignal = init!.signal!;
              readSignal.addEventListener('abort', () =>
                reject(new DOMException('aborted', 'AbortError'))
              );
            })
        ) as SelectionFixtureOptions['request'];
      }
      const scope = effectScope();
      const { service, beginRender } = scope.run(() => {
        const target = ref({
          kind: 'session' as const,
          ...f.target.value,
          sessionId: f.session.id
        });
        const drafts = createSessionDraftService({
          target,
          storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
        });
        const attachments = createComposerAttachmentService({
          context: () => target.value,
          request: vi.fn() as never,
          csrfToken: ref('csrf'),
          renewCsrfToken: vi.fn(),
          onUnauthenticated: vi.fn(),
          notice: vi.fn()
        });
        const pane = createWorkspaceSessionPaneState({
          submissions: paneSubmissions,
          draftTarget: target,
          drafts,
          attachments,
          onConversationOverflow: vi.fn()
        });
        const beginRender = vi.fn(pane.conversation.beginInitialRender);
        const service = createWorkbenchSessionSelectionService({
          ...f.options,
          createPaneLoader: (projection) =>
            pane.createLoader({ ...projection, request: f.options.request, sessionPathId: String }),
          beginInitialRender: beginRender
        });
        return { service, beginRender };
      })!;
      const opening = service.openSession(f.session.id, { markReadAfterOpen: true });
      if (pendingStage === 'read') {
        expect(readSignal).toBeDefined();
      } else {
        await vi.waitFor(() => expect(beginRender).toHaveBeenCalledOnce());
      }
      scope.stop();
      if (pendingStage === 'read') expect(readSignal?.aborted).toBe(true);
      await opening;
      expect(f.options.initialLoadFailed.value).toBe(false);
      expect(f.options.initialFailureCause.value).toBeUndefined();
      expect(f.options.scrollLatest).not.toHaveBeenCalled();
      expect(f.options.markSessionRead).not.toHaveBeenCalled();
    }
  );

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

  it.each(['cancel', 'hidden', 'replacement', 'node', 'session', 'generation'] as const)(
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
        if (replacement === 'hidden') {
          vi.stubGlobal('document', { visibilityState: 'hidden' });
          f.controller.handleSessionWatchVisibility();
        } else if (replacement === 'replacement') {
          void f.controller.restartSelectedSessionWatch(f.session.id)?.catch(() => undefined);
        } else f.controller.stopSelectedSessionWatch();
        await opening;
        expect(f.options.initialFailureCause.value).toBeUndefined();
        expect(f.options.initialLoadFailed.value).toBe(false);
        expect(f.controller.handleEvent(stale)).toBe(false);
        expect(f.controller.hasInitialSessionSnapshot(f.session.id)).toBe(false);
        expect(f.readPosts).toEqual([]);
        expect(f.notifications.hasUnreadWorkspace('node-1', 'workspace-1')).toBe(true);
        if (replacement === 'cancel') {
          const retry = f.service.openWorkspaceTabSession(f.session.id);
          await vi.waitFor(() => expect(f.watchPosts()).toHaveLength(2));
          expect(f.controller.handleEvent(stale)).toBe(false);
          f.controller.handleEvent(f.frame());
          await retry;
          expect(f.readPosts).toEqual([f.session.id]);
        }
      } finally {
        f.dispose();
        vi.unstubAllGlobals();
      }
    }
  );

  it.each(['NATIVE_TRANSCRIPT_UNAVAILABLE', 'SESSION_WORKSPACE_MISMATCH'])(
    'preserves the Node initial failure %s and permits an explicit reload',
    async (code) => {
      const f = await watchedTabFixture();
      try {
        f.connection.value = 'connection-1';
        const opening = f.service.openWorkspaceTabSession(f.session.id);
        await vi.waitFor(() => expect(f.watchPosts()).toHaveLength(1));
        const message = 'Session watch snapshot failed.';
        expect(
          f.controller.handleEvent(
            f.frame({ type: 'watch.failed', watchType: 'session', code, message })
          )
        ).toBe(true);
        await opening;
        expect(f.options.initialLoadFailed.value).toBe(true);
        expect(f.options.loadingInitial.value).toBe(false);
        expect(f.options.initialFailureCause.value).toMatchObject({ code, message });
        expect(f.readPosts).toEqual([]);
        expect(f.watchPosts()).toHaveLength(1);

        const retry = f.service.openWorkspaceTabSession(f.session.id);
        await vi.waitFor(() => expect(f.watchPosts()).toHaveLength(2));
        f.controller.handleEvent(f.frame());
        await retry;
        expect(f.options.initialLoadFailed.value).toBe(false);
        expect(f.readPosts).toEqual([f.session.id]);
        expect(f.options.initialFailureCause.value).toBeUndefined();
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
      await vi.waitFor(() => expect(f.options.beginInitialRender).toHaveBeenCalledOnce());
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

  it('resolves the group for an already open Tab session without reopening its history', async () => {
    const f = tabSessionFixture();
    const child = { ...f.session, sessionGroup: 'CHILD' as const };
    f.options.selectedSessionId.value = child.id;
    f.options.sessions.value = [child];
    const resolved = vi.fn();
    await f.service.openWorkspaceTabSession(child.id, resolved);
    expect(resolved).toHaveBeenCalledExactlyOnceWith(child);
    expect(f.options.request).not.toHaveBeenCalled();
  });

  it.each(['before detail', 'during watch'] as const)(
    'reuses the in-flight session when the Tab is activated %s',
    async (stage) => {
      const f = tabSessionFixture();
      let finishDetail!: (result: { session: Session }) => void;
      let finishWatch!: (loaded: boolean) => void;
      vi.mocked(f.options.request).mockImplementation(
        () => new Promise((resolve) => (finishDetail = resolve))
      );
      vi.mocked(f.options.beginWatch).mockImplementation(
        () => new Promise((resolve) => (finishWatch = resolve))
      );
      const resolved = vi.fn();
      const pending = f.service.openSession(f.session.id);
      if (stage === 'during watch') {
        finishDetail({ session: f.session });
        await vi.waitFor(() => expect(f.options.beginWatch).toHaveBeenCalledOnce());
      }
      await f.service.openWorkspaceTabSession(f.session.id, resolved);
      expect(f.options.request).toHaveBeenCalledOnce();
      if (stage === 'before detail') {
        expect(resolved).not.toHaveBeenCalled();
        finishDetail({ session: f.session });
        await vi.waitFor(() => expect(f.options.beginWatch).toHaveBeenCalledOnce());
      }
      expect(resolved).toHaveBeenCalledExactlyOnceWith(f.session);
      expect(f.options.markSessionRead).not.toHaveBeenCalled();
      finishWatch(true);
      await pending;
      expect(f.options.beginWatch).toHaveBeenCalledOnce();
      expect(f.options.markSessionRead).toHaveBeenCalledExactlyOnceWith(
        'node-1',
        'workspace-1',
        f.session.id
      );
    }
  );

  it('does not mark a reused in-flight session read if its Watch fails', async () => {
    const f = tabSessionFixture();
    let finishWatch!: (loaded: boolean) => void;
    vi.mocked(f.options.beginWatch).mockImplementation(
      () => new Promise((resolve) => (finishWatch = resolve))
    );
    const pending = f.service.openSession(f.session.id);
    await vi.waitFor(() => expect(f.options.beginWatch).toHaveBeenCalledOnce());
    await f.service.openWorkspaceTabSession(f.session.id, vi.fn());
    finishWatch(false);
    await pending;
    expect(f.options.request).toHaveBeenCalledOnce();
    expect(f.options.markSessionRead).not.toHaveBeenCalled();
  });

  it('does not resolve a Tab session whose detail arrives after the selection changes', async () => {
    const f = tabSessionFixture();
    let complete!: (result: { session: Session }) => void;
    vi.mocked(f.options.request).mockImplementation(
      () => new Promise((resolve) => (complete = resolve))
    );
    const resolved = vi.fn();
    const pending = f.service.openWorkspaceTabSession(f.session.id, resolved);
    f.options.selectedSessionId.value = 'another-session';
    complete({ session: f.session });
    await pending;
    expect(resolved).not.toHaveBeenCalled();
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
    const options: SelectionFixtureOptions = {
      aside: createWorkbenchAsideService(),
      canOpenAside: () => true,
      saveAside: vi.fn(),
      workspaceTarget: ref({ nodeId: 'node-1', workspaceId: 'workspace-1' }),
      selectedSessionId: ref(),
      selectedRunId: ref(),
      sessions: ref([session]),
      runs: ref([]),
      turns: ref([]),
      loadingInitial: ref(false),
      initialLoadFailed: ref(false),
      initialFailureCause: ref<unknown>(),
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
      installCachedDetail: vi.fn(),
      clearActiveContent: vi.fn(),
      openRun: vi.fn(),
      scrollLatest: vi.fn(async () => undefined),
      beginInitialRender: vi.fn(async () => undefined),
      request: request as SelectionFixtureOptions['request'],
      sessionPathId: (id) => id,
      replaceSession: vi.fn(),
      canWatch: () => true,
      hasInitialSnapshot: () => true,
      beginWatch: vi.fn(async () => true),
      applySnapshot: vi.fn(() => false),
      mergeTurns: vi.fn(() => false)
    };
    const service = createSelection(options);
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
    const service = createSelection({
      aside: createWorkbenchAsideService(),
      canOpenAside: () => true,
      saveAside: vi.fn(),
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      selectedSessionId: { value: 'session-1' },
      selectedRunId: { value: undefined },
      sessions,
      runs,
      turns: { value: [] },
      loadingInitial: { value: false },
      initialLoadFailed: { value: false },
      initialFailureCause: ref<unknown>(),
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
      installCachedDetail: vi.fn(),
      clearActiveContent: vi.fn(),
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
      mergeTurns
    } as never);

    const opening = service.openSession('session-1', { skipSaveCurrent: true });
    await vi.waitFor(() => expect(order).toEqual(['merge', 'render']));
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
    expect(requests).toContain(
      '/api/agent-sessions/session-1/turns?nodeId=node-1&limit=6&unit=SEGMENT'
    );
    expect(requests).not.toContain('/api/agent-sessions/session-1/runs?nodeId=node-1');
    expect(requests).not.toContain('/api/agent-sessions/session-1/context?nodeId=node-1');
    expect(order).toEqual(['merge', 'render', 'scroll']);
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
    const service = createSelection({
      aside: createWorkbenchAsideService(),
      canOpenAside: () => true,
      saveAside: vi.fn(),
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      selectedSessionId: { value: undefined },
      selectedRunId: { value: undefined },
      sessions,
      runs: { value: [] },
      turns: { value: [] },
      loadingInitial: { value: false },
      initialLoadFailed: { value: false },
      initialFailureCause: ref<unknown>(),
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
      installCachedDetail: vi.fn(),
      clearActiveContent: vi.fn(),
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
      mergeTurns: () => false
    } as never);

    await service.selectSession('session-1');

    expect(markSessionRead).toHaveBeenCalledWith('node-1', 'workspace-1', 'session-1');
    expect(applySnapshot).toHaveBeenCalledWith('session-1', initialPage);
    expect(order).toEqual(['snapshot', 'render']);
  });
  it('replaces provisional Composer configuration with authoritative session details', async () => {
    const provisional: Session = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'mar-agent',
      modelId: null
    };
    const authoritative: Session = {
      ...provisional,
      modelId: 'model-b',
      effort: 'high',
      access: 'full-access'
    };
    const applyComposerConfiguration = vi.fn();
    const service = createSelection({
      aside: createWorkbenchAsideService(),
      canOpenAside: () => true,
      saveAside: vi.fn(),
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      selectedSessionId: { value: undefined },
      selectedRunId: { value: undefined },
      sessions: { value: [provisional] },
      runs: { value: [] },
      turns: { value: [] },
      loadingInitial: { value: false },
      initialLoadFailed: { value: false },
      initialFailureCause: ref<unknown>(),
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
      installCachedDetail: vi.fn(),
      clearActiveContent: vi.fn(),
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
      mergeTurns: vi.fn(() => false)
    } as never);

    await service.openSession('session-1');

    expect(applyComposerConfiguration).toHaveBeenNthCalledWith(1, provisional, false);
    expect(applyComposerConfiguration).toHaveBeenNthCalledWith(2, authoritative, true);
  });
  it('preserves the initial-load failure state so the user can reload after Session Watch initial fails', async () => {
    const initialLoadFailed = { value: false };
    const initialFailureCause = ref<unknown>();
    const failure = new Error('SESSION_HISTORY_INITIAL_FAILED');
    const service = createSelection({
      aside: createWorkbenchAsideService(),
      canOpenAside: () => true,
      saveAside: vi.fn(),
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      selectedSessionId: { value: undefined },
      selectedRunId: { value: undefined },
      sessions: {
        value: [{ id: 'session-1', workspaceId: 'workspace-1', runner: 'codex' }]
      },
      runs: { value: [] },
      turns: { value: [] },
      loadingInitial: { value: false },
      initialLoadFailed,
      initialFailureCause,
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
      installCachedDetail: vi.fn(),
      clearActiveContent: vi.fn(),
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
      mergeTurns: vi.fn()
    } as never);

    await service.openSession('session-1');

    expect(initialLoadFailed.value).toBe(true);
    expect(initialFailureCause.value).toBe(failure);
  });
});
