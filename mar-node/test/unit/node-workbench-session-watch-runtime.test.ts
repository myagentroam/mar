import { createTestSessionWatch } from './support/conversation-watch.js';
import { describe, expect, it, vi } from 'vitest';
import { NodeConnector } from '../../src/connector.js';
import {
  convergeConversationWatchPage,
  type ConversationHistoryService
} from '../../src/service/conversation-history-service.js';
import type { NativeSessionProjectionService } from '../../src/session/native-session-projection-service.js';
import { NodeDatabase, type NodeAgentSession } from '../../src/database.js';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import type { RunEventService } from '../../src/service/run-event-service.js';

describe('Node Workbench external session observation', () => {
  it('projects the latest active Run metrics on each initial Watch and omits terminal metrics', async () => {
    const database = new NodeDatabase(':memory:', 'node-performance-watch');
    const workspace = database.saveWorkspace({
      path: '/workspace/performance-watch',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({ reconnect: false, database });
    const internals = connector as unknown as {
      runtime: NodeRuntimeState;
      runEventService: RunEventService;
      conversationHistoryService: ConversationHistoryService;
      send(type: string, payload: unknown): void;
    };
    const emitted = vi.spyOn(internals, 'send').mockImplementation(() => undefined);
    try {
      const bootstrap = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path,
        title: 'Performance Watch'
      });
      const session = internals.runtime.promoteSessionIdentity(bootstrap.id, 'performance-session');
      const run = internals.runtime.createMessageRun({
        sessionId: session.id,
        clientMessageId: 'performance',
        content: 'Test metrics',
        initiatedByUserId: 7
      }).run;
      const execution = internals.runtime.createExecution(run.id);
      vi.spyOn(internals.conversationHistoryService, 'readHistoryPage').mockResolvedValue({
        source: 'runtime',
        turns: [],
        nextCursor: null
      } as never);
      vi.spyOn(internals.conversationHistoryService, 'read').mockResolvedValue({
        source: 'runtime',
        turns: [],
        nextCursor: null
      } as never);
      const subscribe = async (watchId: string) => {
        await operation(connector, 'session.watch', {
          sessionId: session.id,
          watchId,
          mode: 'initial',
          unit: 'SEGMENT'
        });
        await vi.waitFor(() =>
          expect(emitted).toHaveBeenCalledWith(
            'watch.event',
            expect.objectContaining({ type: 'watch.session.snapshot', watchId })
          )
        );
        return emitted.mock.calls.find(
          ([type, value]) =>
            type === 'watch.event' &&
            (value as { type?: string; watchId?: string }).type === 'watch.session.snapshot' &&
            (value as { watchId?: string }).watchId === watchId
        )?.[1] as { payload: { performance?: unknown } };
      };
      internals.runEventService.emit(execution.id, 'run.performance', { latencyMs: 420 });
      expect((await subscribe('first')).payload.performance).toEqual({
        runId: run.id,
        latencyMs: 420
      });
      internals.runEventService.emit(execution.id, 'run.performance', {
        latencyMs: 80,
        tokensPerSecond: 42
      });
      internals.runEventService.emit(execution.id, 'run.performance', { latencyMs: 70 });
      expect((await subscribe('return')).payload.performance).toEqual({
        runId: run.id,
        latencyMs: 70,
        tokensPerSecond: 42
      });
      internals.runtime.finishRun(run.id, 'SUCCEEDED');
      expect((await subscribe('terminal')).payload.performance).toBeUndefined();
    } finally {
      connector.stop();
    }
  });

  it('reads a fresh idle page for each initial subscription instead of replaying the previous Watch cache', async () => {
    const session = {
      id: 'session-reopen',
      workspaceId: 'workspace-reopen',
      externalSessionId: 'external-reopen'
    } as NodeAgentSession;
    let currentTurnId = 'first-turn';
    const readPage = vi.fn(async () => ({
      source: 'official' as const,
      turns: [{ id: currentTurnId }],
      nextCursor: null,
      snapshotSequence: 1,
      readAt: 1,
      latestVisibleAt: 1
    }));
    const emitted: Array<{
      type?: string;
      watchId?: string;
      payload?: { turns?: { id: string }[] };
    }> = [];
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => false,
      refreshActivity: async () => undefined,
      present: () => session,
      readPage: readPage as never,
      projectInitialPage: (_session, page) => page,
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => emitted.push(event as (typeof emitted)[number])
    });
    try {
      const subscribe = async (watchId: string) => {
        await service.operations()['session.watch']!({
          sessionId: session.id,
          workbenchConnectionId: `browser-${watchId}`,
          watchId,
          mode: 'initial',
          unit: 'SEGMENT'
        });
        await vi.waitFor(() =>
          expect(emitted).toContainEqual(
            expect.objectContaining({ type: 'watch.session.snapshot', watchId })
          )
        );
      };
      await subscribe('watch-first');
      currentTurnId = 'second-turn';
      await subscribe('watch-second');
      expect(readPage).toHaveBeenCalledTimes(2);
      expect(
        emitted
          .find((event) => event.watchId === 'watch-second')
          ?.payload?.turns?.map((turn) => turn.id)
      ).toEqual(['second-turn']);
      expect(
        emitted.filter(
          (event) =>
            event.watchId === 'watch-first' &&
            event.payload?.turns?.some((turn) => turn.id === 'second-turn')
        )
      ).toHaveLength(1);
    } finally {
      service.clear();
    }
  });

  it('uses the converged full window for a renewed initial while official history trails the Runtime', async () => {
    const session = {
      id: 'session-lagging-initial',
      workspaceId: 'workspace-lagging-initial',
      externalSessionId: 'external-lagging-initial'
    } as NodeAgentSession;
    const old = {
      id: 'old',
      sessionId: session.id,
      runId: null,
      items: [{ id: 'old-user', kind: 'user_message', payload: { clientMessageId: 'old' } }]
    };
    const live = {
      id: 'live',
      sessionId: session.id,
      runId: 'run-live',
      items: [{ id: 'live-user', kind: 'user_message', payload: { clientMessageId: 'live' } }]
    };
    let reads = 0;
    const emitted: Array<{
      type?: string;
      watchId?: string;
      payload?: { turns?: Array<{ id: string }>; snapshotSequence?: number };
    }> = [];
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => false,
      refreshActivity: async () => undefined,
      present: () => session,
      readPage: async () =>
        ({
          source: ++reads === 1 ? 'runtime' : 'official',
          turns: reads === 1 ? [old, live] : [old],
          snapshotSequence: reads === 1 ? 10 : 11,
          readAt: reads,
          nextCursor: null
        }) as never,
      projectInitialPage: (_session, page) => page,
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => emitted.push(event as (typeof emitted)[number])
    });
    try {
      for (const watchId of ['first', 'second']) {
        await service.operations()['session.watch']!({
          sessionId: session.id,
          workbenchConnectionId: `browser-${watchId}`,
          watchId,
          mode: 'initial',
          unit: 'SEGMENT'
        });
        await vi.waitFor(() =>
          expect(
            emitted.some(
              (event) => event.type === 'watch.session.snapshot' && event.watchId === watchId
            )
          ).toBe(true)
        );
      }
      const snapshot = emitted.find(
        (event) => event.type === 'watch.session.snapshot' && event.watchId === 'second'
      )?.payload;
      expect(snapshot?.turns?.map((turn) => turn.id)).toEqual(['old', 'live']);
      expect(snapshot?.snapshotSequence).toBe(10);
    } finally {
      service.clear();
    }
  });

  it('does not rebroadcast an initial read invalidated by a live event to existing leases', async () => {
    const session = {
      id: 'session-inflight-initial',
      workspaceId: 'workspace-inflight-initial',
      externalSessionId: 'external-inflight-initial'
    } as NodeAgentSession;
    let reads = 0;
    let releaseRead!: () => void;
    let readStarted!: () => void;
    const readPending = new Promise<void>((resolve) => (releaseRead = resolve));
    const started = new Promise<void>((resolve) => (readStarted = resolve));
    const emitted: Array<{
      type?: string;
      watchId?: string;
      event?: { sequence?: number };
      payload?: { turns?: Array<{ id: string }> };
    }> = [];
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => false,
      refreshActivity: async () => undefined,
      present: () => session,
      readPage: async () => {
        if (++reads === 2) {
          readStarted();
          await readPending;
        }
        return {
          source: 'official',
          turns: [{ id: reads === 1 ? 'first-turn' : 'lagging-turn' }],
          snapshotSequence: 1,
          nextCursor: null
        };
      },
      projectInitialPage: (_session, page) => page,
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => emitted.push(event as (typeof emitted)[number])
    });
    try {
      await service.operations()['session.watch']!({
        sessionId: session.id,
        workbenchConnectionId: 'browser-existing',
        watchId: 'existing-watch',
        mode: 'initial',
        unit: 'SEGMENT'
      });
      await vi.waitFor(() =>
        expect(emitted.some((event) => event.type === 'watch.session.snapshot')).toBe(true)
      );
      emitted.length = 0;
      await service.operations()['session.watch']!({
        sessionId: session.id,
        workbenchConnectionId: 'browser-new',
        watchId: 'new-watch',
        mode: 'initial',
        unit: 'SEGMENT'
      });
      await started;
      service.emitRealtime(session.id, {
        sequence: 2,
        category: 'conversation',
        payload: { turn: { id: 'live-turn' } }
      });
      releaseRead();
      await vi.waitFor(() =>
        expect(emitted.some((event) => event.watchId === 'new-watch')).toBe(true)
      );
      expect(
        emitted.filter((event) => event.watchId === 'existing-watch').map((event) => event.type)
      ).toEqual(['watch.session.event']);
      expect(
        emitted.filter((event) => event.watchId === 'new-watch').map((event) => event.type)
      ).toEqual(['watch.session.snapshot', 'watch.session.event']);
    } finally {
      releaseRead();
      service.clear();
    }
  });

  it('reads a fresh bounded Segment page after an in-flight periodic refresh', async () => {
    const session = {
      id: 'session-periodic-reopen',
      workspaceId: 'workspace-periodic-reopen',
      externalSessionId: 'external-periodic-reopen'
    } as NodeAgentSession;
    const turns = Array.from({ length: 30 }, (_, index) => ({ id: `turn-${index}` }));
    let releasePeriodic!: () => void;
    let periodicStarted!: () => void;
    const periodicPending = new Promise<void>((resolve) => {
      releasePeriodic = resolve;
    });
    const periodicStartedPromise = new Promise<void>((resolve) => {
      periodicStarted = resolve;
    });
    const readPage = vi.fn(async (_session: NodeAgentSession, limit: number) => {
      const snapshot = turns.slice(-limit);
      if (readPage.mock.calls.length === 2) {
        periodicStarted();
        await periodicPending;
      }
      return { source: 'official' as const, turns: snapshot };
    });
    const emitted: Array<{ watchId?: string; payload?: { turns?: { id: string }[] } }> = [];
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => false,
      refreshActivity: async () => undefined,
      present: () => session,
      readPage: readPage as never,
      projectInitialPage: (_session, page) => page,
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => emitted.push(event as (typeof emitted)[number])
    });
    try {
      await service.operations()['session.watch']!({
        sessionId: session.id,
        workbenchConnectionId: 'browser-one',
        watchId: 'watch-one',
        mode: 'initial',
        unit: 'SEGMENT'
      });
      await vi.waitFor(() =>
        expect(emitted.some((event) => event.watchId === 'watch-one')).toBe(true)
      );
      const periodic = service.refresh(session.id);
      await periodicStartedPromise;
      turns.push({ id: 'new-turn' });
      await service.operations()['session.watch']!({
        sessionId: session.id,
        workbenchConnectionId: 'browser-two',
        watchId: 'watch-two',
        mode: 'initial',
        unit: 'SEGMENT'
      });
      releasePeriodic();
      await periodic;
      await vi.waitFor(() =>
        expect(emitted.some((event) => event.watchId === 'watch-two')).toBe(true)
      );
      expect(readPage.mock.calls.map((call) => call[1])).toEqual([6, 10, 10]);
      expect(
        emitted
          .find((event) => event.watchId === 'watch-two')
          ?.payload?.turns?.map((turn) => turn.id)
      ).toEqual(turns.slice(-10).map((turn) => turn.id));
    } finally {
      releasePeriodic();
      service.clear();
    }
  });

  it('does not join a background refresh before the first initial page exists', async () => {
    const session = {
      id: 'session-first-refresh',
      workspaceId: 'workspace-first-refresh',
      externalSessionId: 'external-first-refresh'
    } as NodeAgentSession;
    let releaseRead!: () => void;
    const pendingRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let currentTurn = 'previous-turn';
    const readPage = vi.fn(async () => {
      const turn = { id: currentTurn };
      if (readPage.mock.calls.length === 1) await pendingRead;
      return { source: 'official' as const, turns: [turn] };
    });
    const emitted: Array<{ type?: string; payload?: { turns?: { id: string }[] } }> = [];
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => false,
      refreshActivity: async () => undefined,
      present: () => session,
      readPage: readPage as never,
      projectInitialPage: (_session, page) => page,
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => emitted.push(event as (typeof emitted)[number])
    });
    try {
      service.watch(session);
      const background = service.refresh(session.id);
      await vi.waitFor(() => expect(readPage).toHaveBeenCalledOnce());
      currentTurn = 'latest-turn';
      await service.operations()['session.watch']!({
        sessionId: session.id,
        workbenchConnectionId: 'browser-first',
        watchId: 'watch-first',
        mode: 'initial',
        unit: 'SEGMENT'
      });
      releaseRead();
      await background;
      await vi.waitFor(() =>
        expect(emitted.some((event) => event.type === 'watch.session.snapshot')).toBe(true)
      );
      expect(readPage).toHaveBeenCalledTimes(2);
      expect(emitted.at(-1)?.payload?.turns?.map((turn) => turn.id)).toEqual(['latest-turn']);
    } finally {
      releaseRead();
      service.clear();
    }
  });

  it('when the Runtime first snapshot has not completed, a send failure still releases events from the final history snapshot and returns to Idle', async () => {
    const session = {
      id: 'session-short-failed-run',
      workspaceId: 'workspace-short-failed-run',
      externalSessionId: 'external-short-failed-run'
    } as NodeAgentSession;
    let managedActive = false;
    let historyReads = 0;
    let runtimeReads = 0;
    let releaseRuntime!: () => void;
    const runtimePending = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const emitted: Array<{
      type?: string;
      payload?: { turns?: Array<{ id: string }> };
    }> = [];
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => managedActive,
      refreshActivity: async () => undefined,
      present: () => ({ activity: managedActive ? 'MANAGED_ACTIVE' : 'IDLE' }),
      readPage: async () => {
        if (managedActive) {
          runtimeReads += 1;
          await runtimePending;
          return { turns: [{ id: 'visible-send-error' }], source: 'runtime' };
        }
        historyReads += 1;
        return {
          turns:
            historyReads === 1
              ? [{ id: 'history-turn' }]
              : [{ id: 'history-turn' }, { id: 'visible-send-error' }],
          source: 'official'
        };
      },
      projectInitialPage: (_session, page) => page,
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => emitted.push(event as (typeof emitted)[number]),
      nodeGeneration: () => 'test-generation'
    });
    const initial = service.operations()['session.watch']!({
      sessionId: session.id,
      workspaceId: session.workspaceId,
      workbenchConnectionId: 'connection-short-run',
      watchId: 'watch-short-run',
      mode: 'initial',
      unit: 'SEGMENT'
    });
    await initial;
    await vi.waitFor(() => expect(historyReads).toBe(1));
    emitted.length = 0;

    managedActive = true;
    service.emitRealtime(session.id, {
      sequence: 1,
      category: 'run',
      payload: { run: { status: 'STARTING' } }
    });
    await vi.waitFor(() => expect(runtimeReads).toBe(1));
    managedActive = false;
    service.emitRealtime(session.id, {
      sequence: 2,
      category: 'session',
      payload: { session: { activity: 'IDLE' } }
    });
    releaseRuntime();

    await vi.waitFor(() => expect(historyReads).toBe(2));
    await vi.waitFor(() =>
      expect(emitted.map((event) => event.type)).toEqual([
        'watch.session.snapshot',
        'watch.session.event',
        'watch.session.event'
      ])
    );
    expect(emitted[0]?.payload?.turns?.map((turn) => turn.id)).toEqual([
      'history-turn',
      'visible-send-error'
    ]);
    service.emitRealtime(session.id, { sequence: 3, category: 'conversation', payload: {} });
    expect(emitted.map((event) => event.type)).toEqual([
      'watch.session.snapshot',
      'watch.session.event',
      'watch.session.event',
      'watch.session.event'
    ]);
    service.clear();
  });

  it.each(['success', 'failure'] as const)(
    'discards obsolete history hydration %s while the next Run snapshot is pending',
    async (outcome) => {
      const session = {
        id: 'session-hydration-generation',
        workspaceId: 'workspace-hydration-generation',
        externalSessionId: 'external-hydration-generation'
      } as NodeAgentSession;
      let active = true;
      let runtimeTurn = 'first-live';
      let runtimeReads = 0;
      let releaseRuntime!: () => void;
      const runtimePending = new Promise<void>((resolve) => {
        releaseRuntime = resolve;
      });
      let releaseHistory!: () => void;
      const historyPending = new Promise<void>((resolve) => {
        releaseHistory = resolve;
      });
      const snapshots: Array<{ payload?: { turns?: Array<{ id: string }> } }> = [];
      const events: Array<{ event?: { sequence?: number } }> = [];
      const log = vi.fn();
      const service = createTestSessionWatch({
        resolve: async () => session,
        managedActive: () => active,
        refreshActivity: async () => undefined,
        present: () => session,
        readPage: async () => {
          if (++runtimeReads > 1) await runtimePending;
          return {
            turns: [{ id: active ? runtimeTurn : 'first-live' }],
            source: active ? 'runtime' : 'official'
          };
        },
        readHistoryPage: async () => {
          await historyPending;
          if (outcome === 'failure') throw new Error('OBSOLETE_HISTORY_FAILED');
          return { turns: [{ id: 'stale-history' }], source: 'official' };
        },
        projectInitialPage: (_session, page) => page,
        emitSession: vi.fn(),
        emitPage: vi.fn(),
        log,
        emitWatchEvent: (event) => {
          if ((event as { type?: string }).type === 'watch.session.snapshot')
            snapshots.push(event as (typeof snapshots)[number]);
          else if ((event as { type?: string }).type === 'watch.session.event')
            events.push(event as (typeof events)[number]);
        }
      });
      try {
        await service.operations()['session.watch']!({
          sessionId: session.id,
          workspaceId: session.workspaceId,
          workbenchConnectionId: 'connection-hydration-generation',
          watchId: 'watch-hydration-generation',
          mode: 'initial',
          unit: 'SEGMENT'
        });
        await vi.waitFor(() => expect(snapshots).toHaveLength(1));
        active = false;
        service.emitRealtime(session.id, {
          sequence: 1,
          category: 'session',
          payload: { session: { ...session, activity: 'IDLE' } }
        });
        active = true;
        runtimeTurn = 'next-live';
        service.emitRealtime(session.id, {
          sequence: 2,
          category: 'session',
          payload: { session: { ...session, activity: 'MANAGED_ACTIVE' } }
        });
        await vi.waitFor(() => expect(runtimeReads).toBe(2));
        service.emitRealtime(session.id, { sequence: 3, category: 'conversation', payload: {} });
        releaseHistory();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(snapshots).toHaveLength(1);
        expect(events).toHaveLength(0);
        expect(log).not.toHaveBeenCalled();
        releaseRuntime();
        await vi.waitFor(() => expect(snapshots).toHaveLength(2));
        expect(snapshots).toHaveLength(2);
        expect(snapshots.at(-1)?.payload?.turns?.map((turn) => turn.id)).toEqual(['next-live']);
        expect(events.map((event) => event.event?.sequence)).toEqual([1, 2, 3]);
      } finally {
        releaseHistory();
        releaseRuntime();
        service.clear();
      }
    }
  );

  it.each(['success', 'failure'] as const)(
    'does not reuse an earlier Run Runtime read %s for the next Run snapshot',
    async (outcome) => {
      const session = {
        id: 'session-runtime-read-generation',
        workspaceId: 'workspace-runtime-read-generation',
        externalSessionId: 'external-runtime-read-generation'
      } as NodeAgentSession;
      let activeRun: string | undefined;
      let releaseOldRead!: () => void;
      const oldReadPending = new Promise<void>((resolve) => {
        releaseOldRead = resolve;
      });
      const readPage = vi.fn(async () => {
        const run = activeRun;
        if (run === undefined) return { turns: [{ id: 'history' }], source: 'official' };
        if (run === 'old-live') {
          await oldReadPending;
          if (outcome === 'failure') throw new Error('OBSOLETE_RUNTIME_FAILED');
        }
        return { turns: [{ id: run }], source: 'runtime' };
      });
      const snapshots: Array<{ payload?: { turns?: Array<{ id: string }> } }> = [];
      const events: Array<{ event?: { sequence?: number } }> = [];
      const log = vi.fn();
      const service = createTestSessionWatch({
        resolve: async () => session,
        managedActive: () => activeRun !== undefined,
        refreshActivity: async () => undefined,
        present: () => ({ activity: activeRun === undefined ? 'IDLE' : 'MANAGED_ACTIVE' }),
        readPage,
        projectInitialPage: (_session, page) => page,
        emitSession: vi.fn(),
        emitPage: vi.fn(),
        log,
        emitWatchEvent: (event) => {
          if ((event as { type?: string }).type === 'watch.session.snapshot')
            snapshots.push(event as (typeof snapshots)[number]);
          else if ((event as { type?: string }).type === 'watch.session.event')
            events.push(event as (typeof events)[number]);
        }
      });
      try {
        await service.operations()['session.watch']!({
          sessionId: session.id,
          workspaceId: session.workspaceId,
          workbenchConnectionId: 'connection-runtime-read-generation',
          watchId: 'watch-runtime-read-generation',
          mode: 'initial',
          unit: 'SEGMENT'
        });
        await vi.waitFor(() => expect(snapshots).toHaveLength(1));
        activeRun = 'old-live';
        service.emitRealtime(session.id, {
          sequence: 1,
          category: 'run',
          payload: { run: { status: 'STARTING' } }
        });
        expect(readPage).toHaveBeenCalledTimes(2);
        activeRun = undefined;
        service.emitRealtime(session.id, {
          sequence: 2,
          category: 'session',
          payload: { session: { activity: 'IDLE' } }
        });
        activeRun = 'next-live';
        service.emitRealtime(session.id, {
          sequence: 3,
          category: 'run',
          payload: { run: { status: 'STARTING' } }
        });
        service.emitRealtime(session.id, { sequence: 4, category: 'conversation', payload: {} });
        releaseOldRead();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(snapshots.at(-1)?.payload?.turns?.map((turn) => turn.id)).toEqual([
          'history',
          'next-live'
        ]);
        expect(snapshots).toHaveLength(2);
        expect(events.map((event) => event.event?.sequence)).toEqual([1, 2, 3, 4]);
        expect(readPage).toHaveBeenCalledTimes(3);
        expect(log).not.toHaveBeenCalled();
      } finally {
        releaseOldRead();
        service.clear();
      }
    }
  );

  it('releases buffered events when the Runtime refresh after history hydration fails', async () => {
    const session = {
      id: 'session-hydration-runtime-failure',
      workspaceId: 'workspace-hydration-runtime-failure',
      externalSessionId: 'external-hydration-runtime-failure'
    } as NodeAgentSession;
    let runtimeReads = 0;
    let releaseRuntime!: () => void;
    let releaseHistory!: () => void;
    const runtimePending = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const historyPending = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    const emitted: Array<{ type?: string; event?: { sequence?: number } }> = [];
    const log = vi.fn();
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => true,
      refreshActivity: async () => undefined,
      present: () => ({ activity: 'MANAGED_ACTIVE' }),
      readPage: async () => {
        if (++runtimeReads === 1) return { turns: [{ id: 'live' }], source: 'runtime' };
        await runtimePending;
        throw new Error('RUNTIME_SNAPSHOT_UNAVAILABLE');
      },
      readHistoryPage: async () => {
        await historyPending;
        return { turns: [{ id: 'history' }], source: 'official' };
      },
      projectInitialPage: (_session, page) => page,
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => emitted.push(event as (typeof emitted)[number]),
      log
    });
    try {
      await service.operations()['session.watch']!({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        workbenchConnectionId: 'connection-hydration-runtime-failure',
        watchId: 'watch-hydration-runtime-failure',
        mode: 'initial',
        unit: 'SEGMENT'
      });
      await vi.waitFor(() => expect(emitted).toHaveLength(1));
      service.emitRealtime(session.id, { sequence: 1, category: 'conversation', payload: {} });
      releaseHistory();
      await vi.waitFor(() => expect(runtimeReads).toBe(2));
      emitted.length = 0;
      service.emitRealtime(session.id, { sequence: 2, category: 'conversation', payload: {} });
      expect(emitted).toHaveLength(0);
      releaseRuntime();
      await vi.waitFor(() =>
        expect(log).toHaveBeenCalledWith(
          'session.watch.running-history.failed',
          expect.objectContaining({ errorCode: 'RUNTIME_SNAPSHOT_UNAVAILABLE' })
        )
      );
      expect(emitted.map((event) => event.event?.sequence)).toEqual([2]);
      service.emitRealtime(session.id, { sequence: 3, category: 'conversation', payload: {} });
      expect(emitted.map((event) => event.event?.sequence)).toEqual([2, 3]);
    } finally {
      releaseHistory();
      releaseRuntime();
      service.clear();
    }
  });

  it('releases live events and keeps the subscription usable when the Runtime first snapshot read fails', async () => {
    const session = {
      id: 'session-runtime-snapshot-failure',
      workspaceId: 'workspace-runtime-snapshot-failure',
      externalSessionId: 'external-runtime-snapshot-failure'
    } as NodeAgentSession;
    let managedActive = false;
    const emitted: Array<{ type?: string; event?: { sequence?: number } }> = [];
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => managedActive,
      refreshActivity: async () => undefined,
      present: () => ({ activity: managedActive ? 'MANAGED_ACTIVE' : 'IDLE' }),
      readPage: async () => {
        if (managedActive) throw new Error('RUNTIME_SNAPSHOT_UNAVAILABLE');
        return { turns: [{ id: 'history-turn' }], source: 'official' };
      },
      projectInitialPage: (_session, page) => page,
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => emitted.push(event as (typeof emitted)[number]),
      nodeGeneration: () => 'test-generation'
    });
    await service.operations()['session.watch']!({
      sessionId: session.id,
      workspaceId: session.workspaceId,
      workbenchConnectionId: 'connection-runtime-failure',
      watchId: 'watch-runtime-failure',
      mode: 'initial',
      unit: 'SEGMENT'
    });
    await vi.waitFor(() =>
      expect(emitted.filter((event) => event.type === 'watch.session.snapshot')).toHaveLength(1)
    );
    emitted.length = 0;

    managedActive = true;
    service.emitRealtime(session.id, {
      sequence: 1,
      category: 'run',
      payload: { run: { status: 'STARTING' } }
    });
    await vi.waitFor(() =>
      expect(emitted.map((event) => [event.type, event.event?.sequence])).toEqual([
        ['watch.session.event', 1]
      ])
    );
    service.emitRealtime(session.id, {
      sequence: 2,
      category: 'conversation',
      payload: { turn: { id: 'turn-after-runtime-failure' } }
    });
    expect(emitted.map((event) => [event.type, event.event?.sequence])).toEqual([
      ['watch.session.event', 1],
      ['watch.session.event', 2]
    ]);
    service.clear();
  });

  it('does not replay the completed Runtime Turn in a terminal Watch snapshot', async () => {
    const session = {
      id: 'session-sdk-stream',
      workspaceId: 'workspace-sdk-stream',
      externalSessionId: 'external-sdk-stream'
    } as NodeAgentSession;
    let managedActive = false;
    let reads = 0;
    const emitted: Array<{ type?: string; event?: { sequence?: number } }> = [];
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => managedActive,
      refreshActivity: async () => undefined,
      present: () => ({ activity: managedActive ? 'MANAGED_ACTIVE' : 'IDLE' }),
      readPage: async () => {
        reads += 1;
        return {
          turns: [{ id: 'streamed-turn' }],
          source: managedActive || reads > 1 ? 'runtime' : 'official'
        };
      },
      readHistoryPage: async () => ({
        turns: [{ id: 'streamed-turn' }],
        source: 'runtime'
      }),
      projectInitialPage: (_session, page) => page,
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => emitted.push(event as (typeof emitted)[number]),
      nodeGeneration: () => 'test-generation'
    });
    try {
      await service.operations()['session.watch']!({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        workbenchConnectionId: 'connection-sdk-stream',
        watchId: 'watch-sdk-stream',
        mode: 'initial',
        unit: 'SEGMENT'
      });
      await vi.waitFor(() =>
        expect(emitted.filter((event) => event.type === 'watch.session.snapshot')).toHaveLength(1)
      );
      managedActive = true;
      service.emitRealtime(session.id, {
        sequence: 1,
        category: 'run',
        payload: { run: { status: 'STARTING' } }
      });
      await vi.waitFor(() =>
        expect(emitted.filter((event) => event.type === 'watch.session.snapshot')).toHaveLength(2)
      );
      const snapshotsBeforeCompletion = emitted.filter(
        (event) => event.type === 'watch.session.snapshot'
      ).length;
      managedActive = false;
      service.emitRealtime(session.id, {
        sequence: 2,
        category: 'session',
        payload: { session: { activity: 'IDLE' } }
      });
      await vi.waitFor(() =>
        expect(emitted.some((event) => event.event?.sequence === 2)).toBe(true)
      );
      expect(emitted.filter((event) => event.type === 'watch.session.snapshot')).toHaveLength(
        snapshotsBeforeCompletion
      );
    } finally {
      service.clear();
    }
  });

  it('retains the authoritative prefix and appends only new Turns from the fallback source when the official window falls back', () => {
    const value = (id: string, clientMessageId: string) => ({
      id,
      sessionId: 'session-1',
      runId: null,
      userItemId: `${id}:user`,
      status: 'SUCCEEDED' as const,
      model: null,
      effort: null,
      access: null,
      items: [
        {
          id: `${id}:user`,
          sessionId: 'session-1',
          turnId: id,
          runId: null,
          parentItemId: null,
          sourceSequence: null,
          revision: 1,
          kind: 'user_message',
          status: 'COMPLETED',
          payload: { text: id, clientMessageId },
          startedAt: null,
          completedAt: null
        }
      ],
      startedAt: null,
      completedAt: null
    });
    const official = {
      source: 'official' as const,
      snapshotSequence: 4,
      readAt: 4,
      latestVisibleAt: 0,
      nextCursor: null,
      turns: [value('official-a', 'a'), value('official-b', 'b')]
    };
    const fallback = {
      source: 'native' as const,
      snapshotSequence: 5,
      readAt: 5,
      latestVisibleAt: 0,
      nextCursor: null,
      turns: [value('native-a', 'a'), value('native-b', 'b'), value('native-c', 'c')]
    };

    const converged = convergeConversationWatchPage(official, undefined, fallback, 'official');

    expect(converged.page.source).toBe('native');
    expect(converged.authority).toBe('official');
    expect(converged.page.snapshotSequence).toBe(5);
    expect(converged.page.turns.map((turn) => turn.id)).toEqual([
      'official-a',
      'official-b',
      'native-c'
    ]);
    const continued = convergeConversationWatchPage(
      converged.page,
      fallback,
      {
        ...fallback,
        snapshotSequence: 6,
        turns: [...fallback.turns, value('native-d', 'd')]
      },
      converged.authority
    );
    expect(continued.page.turns.map((turn) => turn.id)).toEqual([
      'official-a',
      'official-b',
      'native-c',
      'native-d'
    ]);
    expect(continued.authority).toBe('official');
    expect(
      convergeConversationWatchPage(
        official,
        undefined,
        { ...fallback, turns: [value('unrelated', 'other')] },
        'official'
      ).page
    ).toBe(official);
    expect(
      convergeConversationWatchPage(
        official,
        { ...fallback, turns: [value('unrelated', 'other')] },
        {
          ...fallback,
          turns: [value('unrelated', 'other'), value('confirmed-new', 'confirmed-new')]
        },
        'official'
      ).page.turns.map((turn) => turn.id)
    ).toEqual(['official-a', 'official-b', 'confirmed-new']);
  });

  it('replaces an incomplete historical Turn with the same managed Runtime Turn by submission ID', () => {
    const user = (id: string, turnId: string) => ({
      id,
      kind: 'user_message',
      turnId,
      payload: { clientMessageId: 'first-idle-submission', text: 'Request' }
    });
    const officialTurn = {
      id: 'historical-turn',
      sessionId: 'session-1',
      runId: null,
      startedAt: 1,
      items: [user('historical-user', 'historical-turn')]
    };
    const runtimeTurn = {
      id: 'runtime-turn',
      sessionId: 'session-1',
      runId: 'run-1',
      startedAt: 1,
      items: [
        user('runtime-user', 'runtime-turn'),
        {
          id: 'run-1:mar-agent-message:reply',
          kind: 'assistant_message',
          payload: { text: 'Final reply' }
        }
      ]
    };
    const page = (source: 'runtime' | 'official', turns: unknown[], deferred = false) =>
      ({
        source,
        turns,
        deferredOlderHistory: deferred,
        snapshotSequence: 1,
        readAt: 1,
        nextCursor: null
      }) as never;
    const converged = convergeConversationWatchPage(
      page('official', [officialTurn]),
      undefined,
      page('runtime', [runtimeTurn], true),
      'official'
    );
    expect(converged.page.turns).toHaveLength(1);
    expect(converged.page.turns[0]?.id).toBe('runtime-turn');
    expect(converged.page.turns[0]?.items.map((item) => item.kind)).toEqual([
      'user_message',
      'assistant_message'
    ]);
  });

  it('accepts a shorter official reply once the same Agent item is completed', () => {
    const runtime = {
      id: 'runtime-turn',
      sessionId: 'session-1',
      runId: 'run-1',
      status: 'SUCCEEDED',
      completedAt: 20,
      items: [
        {
          id: 'runtime-user',
          kind: 'user_message',
          payload: { clientMessageId: 'idle-submission', text: 'Request' }
        },
        {
          id: 'run-1:mar-agent-message:reply',
          kind: 'assistant_message',
          payload: { text: 'Longer streamed response' }
        }
      ]
    };
    const official = {
      ...runtime,
      id: 'official-turn',
      runId: null,
      completedAt: 21,
      items: [
        { ...runtime.items[0]!, id: 'official-user' },
        { ...runtime.items[1]!, id: 'mar-agent-message:reply', payload: { text: 'Final' } }
      ]
    };
    const page = (source: 'runtime' | 'official', turns: unknown[], snapshotSequence: number) =>
      ({ source, turns, snapshotSequence, readAt: snapshotSequence, nextCursor: null }) as never;

    const converged = convergeConversationWatchPage(
      page('runtime', [runtime], 1),
      undefined,
      page('official', [official], 2),
      'runtime'
    );
    expect(converged.page.turns[0]?.id).toBe('official-turn');
    expect(converged.page.turns[0]?.items[1]?.payload).toMatchObject({ text: 'Final' });
  });

  it('retains a live Turn absent from lagging official history until the history catches up', () => {
    const old = {
      id: 'old',
      sessionId: 'session-1',
      runId: null,
      items: [{ id: 'old-user', kind: 'user_message', payload: { clientMessageId: 'old' } }]
    };
    const live = {
      id: 'new',
      sessionId: 'session-1',
      runId: 'run-new',
      items: [{ id: 'new-user', kind: 'user_message', payload: { clientMessageId: 'new' } }]
    };
    const page = (source: 'runtime' | 'official', turns: unknown[], sequence: number) =>
      ({ source, turns, snapshotSequence: sequence, readAt: sequence, nextCursor: null }) as never;

    expect(
      convergeConversationWatchPage(
        page('runtime', [], 9),
        undefined,
        page('official', [old], 10),
        'runtime'
      ).page.turns.map((turn) => turn.id)
    ).toEqual(['old']);
    const lagging = convergeConversationWatchPage(
      page('runtime', [old, live], 10),
      undefined,
      page('official', [old], 11),
      'runtime'
    );
    expect(lagging.page.turns.map((turn) => turn.id)).toEqual(['old', 'new']);
    expect(lagging.page.snapshotSequence).toBe(10);

    const caughtUp = convergeConversationWatchPage(
      lagging.page,
      page('official', [old], 11),
      page('official', [old, { ...live, id: 'official-new', runId: null }], 12),
      lagging.authority
    );
    expect(caughtUp.page.turns.map((turn) => turn.id)).toEqual(['old', 'official-new']);
  });

  it('bounds initial Segment reads without rebroadcasting an unchanged tail when observation expands', async () => {
    const session = {
      id: 'session-segment-signature',
      externalSessionId: 'external-segment-signature'
    } as unknown as NodeAgentSession;
    const turns = Array.from({ length: 30 }, (_, index) => ({ id: `turn-${index + 1}` }));
    const emitPage = vi.fn();
    const emitWatchEvent = vi.fn();
    const readPage = vi.fn(
      async (
        _session: unknown,
        limit: number
      ): Promise<{
        turns: { id: string }[];
        source?: 'official' | 'native' | 'runtime';
      }> => ({ turns: turns.slice(-limit), source: 'official' })
    );
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => false,
      refreshActivity: async () => undefined,
      present: () => session,
      readPage,
      projectInitialPage: (_session, page) => ({ unit: 'SEGMENT', segments: page.turns }),
      emitSession: vi.fn(),
      emitPage,
      emitWatchEvent
    });

    try {
      await service.operations()['session.watch']!({
        sessionId: session.id,
        workbenchConnectionId: 'test-workbench-connection',
        watchId: 'test-session-watch',
        mode: 'initial',
        unit: 'SEGMENT'
      });
      await vi.waitFor(() => expect(emitWatchEvent).toHaveBeenCalled());
      expect(emitPage).not.toHaveBeenCalled();
      emitPage.mockClear();
      emitWatchEvent.mockClear();
      await service.refresh(session.id);
      expect(emitWatchEvent).not.toHaveBeenCalled();

      readPage.mockResolvedValueOnce({
        turns: [{ id: 'turn-30' }, { id: 'native-new' }],
        source: 'native'
      });
      await service.refresh(session.id);

      expect(readPage.mock.calls.map((call) => call[1])).toEqual([6, 10, 10]);
      expect(emitWatchEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: 'watch.session.snapshot',
          payload: expect.objectContaining({
            segments: expect.arrayContaining([
              expect.objectContaining({ id: 'turn-30' }),
              expect.objectContaining({ id: 'native-new' })
            ])
          })
        })
      );
      emitWatchEvent.mockClear();

      readPage.mockResolvedValueOnce({ turns: [{ id: 'official-new' }], source: 'official' });
      await service.refresh(session.id);
      expect(emitWatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'watch.session.snapshot',
          payload: expect.objectContaining({
            segments: [expect.objectContaining({ id: 'official-new' })]
          })
        })
      );
    } finally {
      service.clear();
    }
  });

  it('renews external-session observation with one in-process lease and returns the confirmed expiry time', async () => {
    const database = new NodeDatabase(':memory:', 'node-session-watch');
    let connector: NodeConnector | undefined;
    try {
      const workspace = database.saveWorkspace({
        path: '/workspace/session-watch',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      connector = new NodeConnector({
        reconnect: false,
        database,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: false },
          claudeCode: { available: false }
        }
      });
      const internals = connector as unknown as {
        nativeSessionProjectionService: NativeSessionProjectionService;
        conversationHistoryService: ConversationHistoryService;
        directNativeSession(input: unknown): { readonly id: string };
        rememberDirectNativeSessions(sessions: readonly { readonly id: string }[]): void;
        readDirectNativeHistory(): Promise<{
          runner: 'codex';
          externalSessionId: string;
          cwd: string;
          digest: string;
          items: readonly never[];
          lastActivityAt: number;
        }>;
        emitWorkbenchEvent(type: string, payload: unknown): void;
        send(type: string, payload: unknown): void;
        sessionContextService: {
          read(session: NodeAgentSession): Promise<{
            context: {
              model: string;
              usedTokens: number;
              maxTokens: number;
              percentage: number;
            } | null;
            pending: boolean;
          }>;
        };
        nativeSessionWatchService: {
          entry(sessionId: string): { readonly expiresAt: number } | undefined;
          readonly size: number;
        };
      };
      const session = internals.nativeSessionProjectionService.project({
        workspace,
        runner: 'codex',
        externalSessionId: 'watch-thread',
        cwd: workspace.path
      });
      internals.nativeSessionProjectionService.remember([session]);
      internals.conversationHistoryService.readOfficial = async () => ({
        turns: [],
        nextCursor: null
      });
      const readContext = vi.spyOn(internals.sessionContextService, 'read').mockResolvedValue({
        context: { model: 'gpt-5.6-sol', usedTokens: 42_000, maxTokens: 200_000, percentage: 21 },
        pending: false
      });
      internals.emitWorkbenchEvent = vi.fn();
      const send = vi.spyOn(internals, 'send');

      const first = (await operation(connector, 'session.watch', {
        sessionId: session.id,
        workspaceId: workspace.id,
        mode: 'initial',
        unit: 'SEGMENT'
      })) as { readonly accepted: boolean; readonly expiresAt: number };
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          'watch.event',
          expect.objectContaining({
            type: 'watch.session.snapshot',
            payload: expect.objectContaining({
              kind: 'session-watch-snapshot',
              session: expect.objectContaining({ id: session.id }),
              runs: [],
              queue: { version: 0, paused: false, items: [] },
              context: null,
              conversation: expect.objectContaining({ unit: 'SEGMENT' })
            })
          })
        )
      );
      await vi.waitFor(() => expect(readContext).toHaveBeenCalledWith(session));
      expect(internals.emitWorkbenchEvent).toHaveBeenCalledWith('session', {
        sessionId: session.id,
        workspaceId: workspace.id,
        context: {
          model: 'gpt-5.6-sol',
          usedTokens: 42_000,
          maxTokens: 200_000,
          percentage: 21
        },
        pending: false
      });
      const firstWatch = internals.nativeSessionWatchService.entry(session.id);
      const second = (await operation(connector, 'session.watch', {
        sessionId: session.id,
        workspaceId: workspace.id,
        mode: 'renew'
      })) as { readonly accepted: boolean };

      await expect(
        operation(connector, 'session.watch', {
          sessionId: session.id,
          workspaceId: 'different-workspace',
          mode: 'renew'
        })
      ).rejects.toThrow('SESSION_WATCH_NOT_FOUND');

      expect(first).toMatchObject({ accepted: true, expiresAt: expect.any(Number) });
      expect(second).toMatchObject({ accepted: true });
      expect(internals.nativeSessionWatchService.size).toBe(1);
      expect(internals.nativeSessionWatchService.entry(session.id)).toBe(firstWatch);
    } finally {
      if (connector === undefined) database.close();
      else connector.stop();
    }
  });

  it('confirms external-session initial quickly, reads history asynchronously, and does not reread on renew', async () => {
    const database = new NodeDatabase(':memory:', 'node-session-watch-immediate');
    let connector: NodeConnector | undefined;
    try {
      const workspace = database.saveWorkspace({
        path: '/workspace/session-watch-immediate',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      connector = new NodeConnector({
        reconnect: false,
        database,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: false },
          claudeCode: { available: false }
        }
      });
      const readHistory = vi.fn(async () => ({ turns: [], nextCursor: null }));
      const internals = connector as unknown as {
        nativeSessionProjectionService: NativeSessionProjectionService;
        conversationHistoryService: ConversationHistoryService;
        directNativeSession(input: unknown): { readonly id: string };
        rememberDirectNativeSessions(sessions: readonly { readonly id: string }[]): void;
        readDirectNativeHistory: () => Promise<
          | {
              runner: 'codex';
              externalSessionId: string;
              cwd: string;
              digest: string;
              items: readonly never[];
              lastActivityAt: number;
            }
          | undefined
        >;
        emitWorkbenchEvent(type: string, payload: unknown): void;
        nativeSessionWatchService: { readonly size: number };
      };
      const session = internals.nativeSessionProjectionService.project({
        workspace,
        runner: 'codex',
        externalSessionId: 'watch-immediate',
        cwd: workspace.path
      });
      internals.nativeSessionProjectionService.remember([session]);
      internals.conversationHistoryService.readOfficial = readHistory;
      internals.emitWorkbenchEvent = vi.fn();

      const first = (await operation(connector, 'session.watch', {
        sessionId: session.id,
        mode: 'initial'
      })) as { readonly accepted: boolean };
      expect(first).toMatchObject({ accepted: true });
      await vi.waitFor(() => expect(readHistory).toHaveBeenCalledTimes(1));
      await operation(connector, 'session.watch', { sessionId: session.id, mode: 'renew' });
      expect(readHistory).toHaveBeenCalledTimes(1);
      internals.conversationHistoryService.readOfficial = async () => undefined;
      await expect(
        operation(connector, 'session.watch', {
          sessionId: session.id,
          mode: 'initial',
          watchId: 'replacement-session-watch'
        })
      ).resolves.toMatchObject({ accepted: true });
      await vi.waitFor(() => expect(internals.nativeSessionWatchService.size).toBe(0));
    } finally {
      if (connector === undefined) database.close();
      else connector.stop();
    }
  });

  it('renew does not implicitly create an observation for an ended session', async () => {
    const database = new NodeDatabase(':memory:', 'node-session-watch-renew-only');
    let connector: NodeConnector | undefined;
    try {
      const workspace = database.saveWorkspace({
        path: '/workspace/session-watch-renew-only',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      connector = new NodeConnector({ reconnect: false, database });
      const internals = connector as unknown as {
        nativeSessionProjectionService: NativeSessionProjectionService;
        conversationHistoryService: ConversationHistoryService;
        directNativeSession(input: unknown): { readonly id: string };
        rememberDirectNativeSessions(sessions: readonly { readonly id: string }[]): void;
        nativeSessionWatchService: { readonly size: number };
      };
      const session = internals.nativeSessionProjectionService.project({
        workspace,
        runner: 'codex',
        externalSessionId: 'watch-renew-only',
        cwd: workspace.path
      });
      internals.nativeSessionProjectionService.remember([session]);

      await expect(
        operation(connector, 'session.watch', { sessionId: session.id, mode: 'renew' })
      ).rejects.toThrow('SESSION_WATCH_NOT_FOUND');
      expect(internals.nativeSessionWatchService.size).toBe(0);
    } finally {
      if (connector === undefined) database.close();
      else connector.stop();
    }
  });

  it('releases the observation lease after three consecutive external-session history read failures', async () => {
    const database = new NodeDatabase(':memory:', 'node-session-watch-failure');
    let connector: NodeConnector | undefined;
    try {
      const workspace = database.saveWorkspace({
        path: '/workspace/session-watch-failure',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      connector = new NodeConnector({
        reconnect: false,
        database,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: false },
          claudeCode: { available: false }
        }
      });
      const internals = connector as unknown as {
        nativeSessionProjectionService: NativeSessionProjectionService;
        conversationHistoryService: ConversationHistoryService;
        directNativeSession(input: unknown): { readonly id: string };
        rememberDirectNativeSessions(sessions: readonly { readonly id: string }[]): void;
        readDirectNativeHistory(): Promise<undefined>;
        nativeSessionWatchService: {
          watch(session: { readonly id: string }): void;
          refresh(sessionId: string): Promise<void>;
          has(sessionId: string): boolean;
        };
      };
      const session = internals.nativeSessionProjectionService.project({
        workspace,
        runner: 'codex',
        externalSessionId: 'watch-missing-history',
        cwd: workspace.path
      });
      internals.nativeSessionProjectionService.remember([session]);
      internals.conversationHistoryService.readNative = async () => undefined;
      internals.nativeSessionWatchService.watch(session);
      await internals.nativeSessionWatchService.refresh(session.id);
      await internals.nativeSessionWatchService.refresh(session.id);
      await internals.nativeSessionWatchService.refresh(session.id);

      expect(internals.nativeSessionWatchService.has(session.id)).toBe(false);
    } finally {
      if (connector === undefined) database.close();
      else connector.stop();
    }
  });

  it('external session observation emits session frames only when the snapshot changes', async () => {
    const database = new NodeDatabase(':memory:', 'node-session-watch-dedupe');
    let connector: NodeConnector | undefined;
    try {
      const workspace = database.saveWorkspace({
        path: '/workspace/session-watch-dedupe',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      connector = new NodeConnector({
        reconnect: false,
        database,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: false },
          claudeCode: { available: false }
        }
      });
      const emitted = vi.fn();
      const internals = connector as unknown as {
        nativeSessionProjectionService: NativeSessionProjectionService;
        conversationHistoryService: ConversationHistoryService;
        directNativeSession(input: unknown): { readonly id: string };
        rememberDirectNativeSessions(sessions: readonly { readonly id: string }[]): void;
        nativeSessionWatchService: {
          watch(session: { readonly id: string }): void;
          refresh(sessionId: string): Promise<void>;
        };
        readDirectNativeHistory(): Promise<{
          readonly runner: 'codex';
          readonly externalSessionId: string;
          readonly cwd: string;
          readonly digest: string;
          readonly items: readonly never[];
          readonly lastActivityAt: number;
        }>;
        emitWorkbenchEvent(type: string, payload: unknown): void;
      };
      const session = internals.nativeSessionProjectionService.project({
        workspace,
        runner: 'codex',
        externalSessionId: 'watch-dedupe',
        cwd: workspace.path
      });
      internals.nativeSessionProjectionService.remember([session]);
      internals.conversationHistoryService.readOfficial = async () => ({
        turns: [],
        nextCursor: null
      });
      internals.emitWorkbenchEvent = emitted;
      internals.nativeSessionWatchService.watch(session);
      await internals.nativeSessionWatchService.refresh(session.id);
      emitted.mockClear();

      await internals.nativeSessionWatchService.refresh(session.id);

      expect(emitted).not.toHaveBeenCalledWith('session', expect.anything());
    } finally {
      if (connector === undefined) database.close();
      else connector.stop();
    }
  });

  it('Codex external session observation emits the complete authoritative Segment window from oldest to newest', async () => {
    const database = new NodeDatabase(':memory:', 'node-session-watch-conversation-order');
    let connector: NodeConnector | undefined;
    try {
      const workspace = database.saveWorkspace({
        path: '/workspace/session-watch-conversation-order',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      connector = new NodeConnector({
        reconnect: false,
        database,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: false },
          claudeCode: { available: false }
        }
      });
      const emitted = vi.fn();
      const internals = connector as unknown as {
        nativeSessionProjectionService: NativeSessionProjectionService;
        conversationHistoryService: ConversationHistoryService;
        directNativeSession(input: unknown): { readonly id: string };
        rememberDirectNativeSessions(sessions: readonly { readonly id: string }[]): void;
        nativeSessionWatchService: {
          watch(session: { readonly id: string }): void;
          refresh(sessionId: string): Promise<void>;
        };
        readDirectNativeHistory(): Promise<unknown>;
        emitWorkbenchEvent(type: string, payload: unknown): void;
      };
      const session = internals.nativeSessionProjectionService.project({
        workspace,
        runner: 'codex',
        externalSessionId: 'watch-conversation-order',
        cwd: workspace.path
      });
      internals.nativeSessionProjectionService.remember([session]);
      internals.conversationHistoryService.readOfficial = async () => ({
        nextCursor: null,
        turns: [
          {
            id: 'official-turn',
            sessionId: session.id,
            runId: null,
            userItemId: 'user',
            status: 'SUCCEEDED',
            model: null,
            effort: null,
            access: null,
            startedAt: 1,
            completedAt: 2,
            items: [
              { kind: 'user_message', text: 'Ask first' },
              { kind: 'assistant_message', text: 'Answer later' }
            ].map((item, index) => ({
              id: index === 0 ? 'user' : 'assistant',
              sessionId: session.id,
              turnId: 'official-turn',
              runId: null,
              parentItemId: null,
              sourceSequence: index,
              revision: 1,
              kind: item.kind,
              status: 'COMPLETED',
              startedAt: index + 1,
              completedAt: index + 1,
              payload: { text: item.text }
            }))
          }
        ]
      });
      internals.emitWorkbenchEvent = emitted;
      internals.nativeSessionWatchService.watch(session);

      await internals.nativeSessionWatchService.refresh(session.id);

      expect(
        emitted.mock.calls
          .filter(([type]) => type === 'conversation')
          .flatMap(([, payload]) =>
            (
              payload as {
                snapshot: { segments: { items: { kind: string }[] }[] };
              }
            ).snapshot.segments.flatMap((segment) => segment.items.map((item) => item.kind))
          )
      ).toEqual(['user_message', 'assistant_message']);
    } finally {
      if (connector === undefined) database.close();
      else connector.stop();
    }
  });
});

function operation(connector: NodeConnector, operation: string, data: unknown): Promise<unknown> {
  const input = data as Record<string, unknown>;
  const requestData =
    operation.startsWith('session.') && operation.includes('watch')
      ? {
          workbenchConnectionId: 'test-workbench-connection',
          watchId: 'test-session-watch',
          ...input
        }
      : data;
  return (
    connector as unknown as {
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    }
  ).executeNodeOperation(operation, requestData);
}
