import { createTestSessionWatch } from './support/conversation-watch.js';
import { describe, expect, it, vi } from 'vitest';
import { NodeConnector } from '../../src/connector.js';
import { composeConversationRuntimePage } from '../../src/service/conversation-history-service.js';
import { NativeSessionWatchService } from '../../src/service/native-session-watch-service.js';
import { NodeDatabase, type NodeAgentSession } from '../../src/database.js';

describe('Node Workbench external session observation', () => {
  it('publishes the complete authoritative next queued Turn before execution and emits Agent text only as deltas', () => {
    const database = new NodeDatabase(':memory:', 'node-queued-turn-first-text');
    const workspace = database.saveWorkspace({
      path: '/workspace/queued-turn-first-text',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({ reconnect: false, database });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: unknown): NodeAgentSession;
        createMessageRun(input: unknown): { run: { id: string } };
        createQueueItem(input: unknown): unknown;
        claimNextQueueItem(sessionId: string): { turn: { id: string } } | undefined;
        appendRunEvent(input: unknown): unknown;
      };
      nativeSessionWatchService: {
        emitRealtime(sessionId: string, event: unknown): boolean;
      };
      workbenchEventService: { publish(event: unknown): void };
      emitWorkbenchEvent(category: string, payload: unknown): void;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path
    });
    const { run } = internals.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'message-first',
      content: 'First-turn question'
    });
    internals.runtime.createQueueItem({
      sessionId: session.id,
      clientMessageId: 'message-second',
      content: 'Second-turn question'
    });
    const claimed = internals.runtime.claimNextQueueItem(session.id);
    const emitted: Array<{ payload?: Record<string, unknown> }> = [];
    const publish = vi.spyOn(internals.workbenchEventService, 'publish');
    vi.spyOn(internals.nativeSessionWatchService, 'emitRealtime').mockImplementation(
      (_sessionId, event) => {
        emitted.push(event as (typeof emitted)[number]);
        return true;
      }
    );

    try {
      internals.emitWorkbenchEvent('conversation', { turn: claimed?.turn });
      const first = internals.runtime.appendRunEvent({
        runId: run.id,
        sequence: 1,
        eventType: 'text.delta',
        payload: { text: 'Second turn' }
      });
      internals.emitWorkbenchEvent('conversation', { event: first });
      const second = internals.runtime.appendRunEvent({
        runId: run.id,
        sequence: 2,
        eventType: 'text.delta',
        payload: { text: 'Answer' }
      });
      internals.emitWorkbenchEvent('conversation', { event: second });

      expect(claimed).toBeDefined();
      expect(emitted).toHaveLength(3);
      expect(emitted[0]?.payload).toMatchObject({
        turn: {
          id: claimed?.turn.id,
          items: [
            expect.objectContaining({
              kind: 'user_message',
              payload: expect.objectContaining({ text: 'Second-turn question' })
            })
          ]
        }
      });
      expect(emitted[1]?.payload).toMatchObject({
        sessionId: session.id,
        delta: expect.objectContaining({ runId: run.id, text: 'Second turn' })
      });
      expect(emitted[2]?.payload).toMatchObject({
        sessionId: session.id,
        delta: expect.objectContaining({ runId: run.id, text: 'Answer' })
      });
      expect(publish).not.toHaveBeenCalled();
    } finally {
      connector.stop();
    }
  });

  it('falls back to the page event stream when no Session Watch lease receives a Session event', () => {
    const database = new NodeDatabase(':memory:', 'node-session-watch-event-fallback');
    const workspace = database.saveWorkspace({
      path: '/workspace/session-watch-event-fallback',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({ reconnect: false, database });
    const internals = connector as unknown as {
      runtime: { createAgentSession(input: unknown): NodeAgentSession };
      nativeSessionWatchService: { emitRealtime(sessionId: string, event: unknown): boolean };
      workbenchEventService: { publish(event: unknown): void };
      emitWorkbenchEvent(category: string, payload: unknown): void;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path
    });
    const publish = vi.spyOn(internals.workbenchEventService, 'publish');
    vi.spyOn(internals.nativeSessionWatchService, 'emitRealtime').mockReturnValue(false);

    try {
      internals.emitWorkbenchEvent('session', { session });

      expect(internals.nativeSessionWatchService.emitRealtime).toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({ category: 'session', payload: { session } })
      );
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'session', payload: { session } })
      );
    } finally {
      connector.stop();
    }
  });

  it('refills the initial history snapshot asynchronously when resubscribing during an active Run', async () => {
    const session = {
      id: 'session-running-history-reload',
      externalSessionId: 'native-running-history-reload',
      workspaceId: 'workspace-running-history-reload',
      runner: 'codex'
    } as NodeAgentSession;
    const runtime = {
      source: 'runtime',
      turns: [{ id: 'turn-current-user' }],
      nextCursor: 'runtime-older'
    } as const;
    const history = {
      source: 'official',
      turns: [{ id: 'turn-history-1' }, { id: 'turn-history-2' }],
      nextCursor: null
    } as const;
    let releaseHistory!: () => void;
    const historyReady = new Promise<void>((resolve) => (releaseHistory = resolve));
    let historyReads = 0;
    const emitted: unknown[] = [];
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => true,
      refreshActivity: async () => undefined,
      present: () => session,
      readPage: async () => runtime,
      readHistoryPage: async () => {
        historyReads += 1;
        await historyReady;
        return history;
      },
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => emitted.push(event)
    });

    try {
      await service.operations()['session.watch']!({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        workbenchConnectionId: 'connection-running-history-reload',
        watchId: 'watch-running-history-reload',
        mode: 'initial'
      });
      await vi.waitFor(() => expect(emitted).toHaveLength(1));
      expect(
        service.observes(
          'local-test',
          'connection-running-history-reload',
          session.workspaceId,
          session.id
        )
      ).toBe(true);
      expect(
        service.observes(
          'other-owner',
          'connection-running-history-reload',
          session.workspaceId,
          session.id
        )
      ).toBe(false);
      expect(emitted[0]).toMatchObject({
        type: 'watch.session.snapshot',
        payload: { turns: [{ id: 'turn-current-user' }], nextCursor: 'runtime-older' }
      });
      await service.operations()['session.watch']!({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        workbenchConnectionId: 'connection-running-history-reload-2',
        watchId: 'watch-running-history-reload-2',
        mode: 'initial'
      });
      await vi.waitFor(() => expect(emitted).toHaveLength(2));
      expect(historyReads).toBe(1);

      releaseHistory();
      await vi.waitFor(() => expect(emitted).toHaveLength(4));
      expect(emitted[2]).toMatchObject({
        type: 'watch.session.snapshot',
        payload: {
          turns: [{ id: 'turn-history-1' }, { id: 'turn-history-2' }, { id: 'turn-current-user' }],
          nextCursor: null
        }
      });
    } finally {
      service.clear();
    }
  });

  it('starting a Run during initial history read still combines history and the current Turn into one initial snapshot', async () => {
    const session = {
      id: 'session-initial-history-run-race',
      externalSessionId: 'native-initial-history-run-race',
      workspaceId: 'workspace-initial-history-run-race',
      runner: 'codex'
    } as NodeAgentSession;
    const runtime = {
      source: 'runtime',
      turns: [{ id: 'turn-current-user' }],
      nextCursor: 'runtime-older'
    } as const;
    const history = {
      source: 'official',
      turns: [{ id: 'turn-history-1' }, { id: 'turn-history-2' }],
      nextCursor: null
    } as const;
    let active = false;
    let releaseActivity!: () => void;
    const activityReady = new Promise<void>((resolve) => (releaseActivity = resolve));
    const readPage = vi.fn(async () => runtime);
    const readHistoryPage = vi.fn(async () => history);
    const emitted: Array<{ type?: string; payload?: { turns?: Array<{ id: string }> } }> = [];
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => active,
      refreshActivity: async () => activityReady,
      present: () => session,
      readPage,
      readHistoryPage,
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => emitted.push(event as (typeof emitted)[number])
    });

    try {
      await service.operations()['session.watch']!({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        workbenchConnectionId: 'connection-initial-history-run-race',
        watchId: 'watch-initial-history-run-race',
        mode: 'initial'
      });
      active = true;
      service.emitRealtime(session.id, {
        sequence: 1,
        category: 'run',
        payload: { run: { status: 'STARTING' } }
      });
      await vi.waitFor(() => expect(readPage).toHaveBeenCalledOnce());
      expect(emitted).toHaveLength(0);

      releaseActivity();
      await vi.waitFor(() =>
        expect(emitted.some((event) => event.type === 'watch.session.snapshot')).toBe(true)
      );

      const snapshot = emitted.find((event) => event.type === 'watch.session.snapshot');
      expect(readHistoryPage).toHaveBeenCalledOnce();
      expect(snapshot?.payload?.turns?.map((turn) => turn.id)).toEqual([
        'turn-history-1',
        'turn-history-2',
        'turn-current-user'
      ]);
    } finally {
      service.clear();
    }
  });

  it('does not release live events before the initial history when Runtime snapshot conversion first fails', async () => {
    const session = {
      id: 'session-initial-runtime-failure-race',
      externalSessionId: 'native-initial-runtime-failure-race',
      workspaceId: 'workspace-initial-runtime-failure-race',
      runner: 'codex'
    } as NodeAgentSession;
    const history = {
      source: 'official',
      turns: [{ id: 'turn-history' }],
      nextCursor: null
    } as const;
    const runtime = {
      source: 'runtime',
      turns: [{ id: 'turn-current-user' }],
      nextCursor: 'runtime-older'
    } as const;
    let active = false;
    let releaseActivity!: () => void;
    const activityReady = new Promise<void>((resolve) => (releaseActivity = resolve));
    let runtimeReads = 0;
    const readPage = vi.fn(async () => {
      runtimeReads += 1;
      if (runtimeReads === 1) throw new Error('RUNTIME_SNAPSHOT_UNAVAILABLE');
      return runtime;
    });
    const emitted: Array<{
      type?: string;
      event?: { sequence?: number };
      payload?: { turns?: Array<{ id: string }> };
    }> = [];
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => active,
      refreshActivity: async () => activityReady,
      present: () => session,
      readPage,
      readHistoryPage: async () => history,
      projectInitialPage: (_session, page) => page,
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => emitted.push(event as (typeof emitted)[number])
    });

    try {
      await service.operations()['session.watch']!({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        workbenchConnectionId: 'connection-initial-runtime-failure-race',
        watchId: 'watch-initial-runtime-failure-race',
        mode: 'initial',
        unit: 'SEGMENT'
      });
      active = true;
      service.emitRealtime(session.id, {
        sequence: 1,
        category: 'run',
        payload: { run: { status: 'STARTING' } }
      });
      await vi.waitFor(() => expect(readPage).toHaveBeenCalledOnce());
      expect(emitted).toHaveLength(0);

      releaseActivity();
      await vi.waitFor(() =>
        expect(emitted.map((event) => event.type)).toEqual([
          'watch.session.snapshot',
          'watch.session.event'
        ])
      );
      expect(emitted[0]?.payload?.turns?.map((turn) => turn.id)).toEqual([
        'turn-history',
        'turn-current-user'
      ]);
      expect(emitted[1]?.event?.sequence).toBe(1);
    } finally {
      service.clear();
    }
  });

  it('Runtime snapshot replays only buffered events not covered by snapshotSequence', async () => {
    const session = {
      id: 'session-runtime-snapshot-sequence',
      externalSessionId: 'native-runtime-snapshot-sequence',
      workspaceId: 'workspace-runtime-snapshot-sequence',
      runner: 'codex'
    } as NodeAgentSession;
    let active = false;
    let runtimeReads = 0;
    let releaseRuntime!: () => void;
    const runtimeReady = new Promise<void>((resolve) => (releaseRuntime = resolve));
    const emitted: Array<{
      type?: string;
      event?: { sequence?: number };
      payload?: { snapshotSequence?: number };
    }> = [];
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => active,
      refreshActivity: async () => undefined,
      present: () => session,
      readPage: async () => {
        runtimeReads += 1;
        if (active) await runtimeReady;
        return {
          turns: active ? [{ id: 'turn-with-agent-output' }] : [{ id: 'turn-history' }],
          source: active ? ('runtime' as const) : ('official' as const),
          snapshotSequence: active ? 2 : 0
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
        workspaceId: session.workspaceId,
        workbenchConnectionId: 'connection-runtime-snapshot-sequence',
        watchId: 'watch-runtime-snapshot-sequence',
        mode: 'initial',
        unit: 'SEGMENT'
      });
      await vi.waitFor(() =>
        expect(emitted.filter((event) => event.type === 'watch.session.snapshot')).toHaveLength(1)
      );
      emitted.length = 0;

      active = true;
      service.emitRealtime(session.id, {
        sequence: 1,
        category: 'run',
        payload: { run: { status: 'STARTING' } }
      });
      await vi.waitFor(() => expect(runtimeReads).toBe(2));
      service.emitRealtime(session.id, {
        sequence: 2,
        category: 'conversation',
        payload: {
          sessionId: session.id,
          delta: { runId: 'run-1', itemId: 'agent-1', text: 'Already in snapshot' }
        }
      });
      releaseRuntime();
      service.emitRealtime(session.id, {
        sequence: 3,
        category: 'conversation',
        payload: {
          sessionId: session.id,
          delta: { runId: 'run-1', itemId: 'agent-1', text: 'Delta after snapshot' }
        }
      });

      await vi.waitFor(() =>
        expect(emitted.map((event) => event.type)).toEqual([
          'watch.session.snapshot',
          'watch.session.event'
        ])
      );
      expect(emitted).toEqual([
        expect.objectContaining({
          type: 'watch.session.snapshot',
          payload: expect.objectContaining({ snapshotSequence: 2 })
        }),
        expect.objectContaining({
          type: 'watch.session.event',
          event: expect.objectContaining({ sequence: 3 })
        })
      ]);
    } finally {
      service.clear();
    }
  });

  it('running history refill establishes a sequence boundary before releasing new Turn events read during the refill', async () => {
    const session = {
      id: 'session-running-history-sequence',
      externalSessionId: 'native-running-history-sequence',
      workspaceId: 'workspace-running-history-sequence',
      runner: 'codex'
    } as NodeAgentSession;
    const history = {
      source: 'official' as const,
      snapshotSequence: 0,
      turns: [{ id: 'turn-history' }],
      nextCursor: null
    };
    let releaseHistory!: () => void;
    const historyReady = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    const initialRuntime = {
      source: 'runtime' as const,
      snapshotSequence: 0,
      turns: [{ id: 'turn-1' }],
      nextCursor: 'runtime-older'
    };
    const staleRuntime = {
      source: 'runtime' as const,
      snapshotSequence: 1,
      turns: [{ id: 'turn-1' }],
      nextCursor: 'runtime-older'
    };
    let runtimeReads = 0;
    let releaseRuntime!: () => void;
    const runtimeReady = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const emitted: Array<{
      type?: string;
      event?: { sequence?: number };
      payload?: { turns?: Array<{ id: string }> };
    }> = [];
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => true,
      refreshActivity: async () => undefined,
      present: () => ({ activity: 'MANAGED_ACTIVE' }),
      readPage: async () => {
        runtimeReads += 1;
        if (runtimeReads === 1) return initialRuntime;
        await runtimeReady;
        return staleRuntime;
      },
      readHistoryPage: async () => {
        await historyReady;
        return history;
      },
      projectInitialPage: (_session, current) => current,
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => emitted.push(event as (typeof emitted)[number])
    });

    try {
      await service.operations()['session.watch']!({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        workbenchConnectionId: 'connection-running-history-sequence',
        watchId: 'watch-running-history-sequence',
        mode: 'initial',
        unit: 'SEGMENT'
      });
      await vi.waitFor(() =>
        expect(emitted.filter((event) => event.type === 'watch.session.snapshot')).toHaveLength(1)
      );
      service.emitRealtime(session.id, {
        sequence: 1,
        category: 'queue',
        payload: { sessionId: session.id, queue: { version: 1, paused: false, items: [] } }
      });
      releaseHistory();
      await vi.waitFor(() => expect(runtimeReads).toBe(2));
      emitted.length = 0;

      service.emitRealtime(session.id, {
        sequence: 2,
        category: 'conversation',
        payload: {
          turn: {
            id: 'turn-2',
            sessionId: session.id,
            runId: 'run-1',
            status: 'PREPARING',
            items: []
          }
        }
      });
      releaseRuntime();

      await vi.waitFor(() =>
        expect(emitted.map((event) => event.type)).toEqual([
          'watch.session.snapshot',
          'watch.session.event'
        ])
      );
      expect(emitted[0]?.payload?.turns?.map((turn) => turn.id)).toEqual([
        'turn-history',
        'turn-1'
      ]);
      expect(emitted[1]?.event?.sequence).toBe(2);
    } finally {
      service.clear();
    }
  });

  it('when an interruption marker enters history first, orders the earlier Runtime Turn first by time', () => {
    const turn = (id: string, startedAt: number) => ({
      id,
      sessionId: 'session-interrupted',
      runId: null,
      userItemId: null,
      status: 'SUCCEEDED',
      model: null,
      effort: null,
      access: null,
      items: [],
      startedAt,
      completedAt: startedAt
    });
    const history = {
      turns: [turn('turn-aborted', 42)],
      nextCursor: null,
      snapshotSequence: 2,
      source: 'native',
      readAt: 42,
      latestVisibleAt: 42
    } as const;
    const runtime = {
      turns: [turn('turn-original', 29)],
      nextCursor: null,
      snapshotSequence: 1,
      source: 'runtime',
      readAt: 29,
      latestVisibleAt: 29
    } as const;

    expect(
      composeConversationRuntimePage(history as never, runtime as never).turns.map(({ id }) => id)
    ).toEqual(['turn-original', 'turn-aborted']);
  });

  it('records the safe phase, error code, and cumulative count when external-session background refresh fails', async () => {
    const session = {
      id: 'session-refresh-diagnostic',
      externalSessionId: 'external-refresh-diagnostic',
      runner: 'codex'
    } as NodeAgentSession;
    const log = vi.fn();
    const error = new Error('permission denied') as NodeJS.ErrnoException;
    error.code = 'EACCES';
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => false,
      refreshActivity: async () => {
        throw error;
      },
      present: () => session,
      readPage: async () => ({ turns: [] }),
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      nodeId: () => 'node-refresh-diagnostic',
      log
    });
    service.watch(session);

    await service.refresh(session.id);
    await service.refresh(session.id);
    await service.refresh(session.id);

    expect(log.mock.calls).toEqual([
      [
        'session.watch.refresh.failed',
        {
          nodeId: 'node-refresh-diagnostic',
          sessionId: session.id,
          runner: 'codex',
          stage: 'refresh_activity',
          errorCode: 'EACCES',
          failureCount: 1,
          terminal: false
        }
      ],
      [
        'session.watch.refresh.failed',
        expect.objectContaining({ failureCount: 2, terminal: false })
      ],
      ['session.watch.refresh.failed', expect.objectContaining({ failureCount: 3, terminal: true })]
    ]);
    expect(service.has(session.id)).toBe(false);
  });

  it('does not publish snapshots while native-session activation is suspended', async () => {
    const session = {
      id: 'session-transitioning',
      externalSessionId: 'session-transitioning'
    } as NodeAgentSession;
    let suspended = false;
    let releaseActivity!: () => void;
    const activity = new Promise<void>((resolve) => {
      releaseActivity = resolve;
    });
    const emitSession = vi.fn();
    const readPage = vi.fn(async () => ({ turns: [] }));
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => false,
      suspended: () => suspended,
      refreshActivity: async () => activity,
      present: () => ({ activity: 'IDLE' }),
      readPage,
      emitSession,
      emitPage: vi.fn()
    });
    service.watch(session);

    const refresh = service.refresh(session.id);
    suspended = true;
    releaseActivity();
    await refresh;

    expect(emitSession).not.toHaveBeenCalled();
    expect(readPage).not.toHaveBeenCalled();
    expect(service.has(session.id)).toBe(true);
    service.clear();
  });

  it('returns the current runtime snapshot when a managed Run starts during external activity refresh', async () => {
    const session = {
      id: 'session-managed-during-refresh',
      externalSessionId: 'session-managed-during-refresh'
    } as NodeAgentSession;
    let managedActive = false;
    let activityStarted = false;
    let releaseActivity!: () => void;
    const activity = new Promise<void>((resolve) => {
      releaseActivity = resolve;
    });
    const emitSession = vi.fn();
    const emitPage = vi.fn();
    const readPage = vi.fn(async () => ({ turns: [] }));
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => managedActive,
      refreshActivity: async () => {
        activityStarted = true;
        return activity;
      },
      present: () => ({ activity: managedActive ? 'MANAGED_ACTIVE' : 'IDLE' }),
      readPage,
      emitSession,
      emitPage
    });
    service.watch(session);

    const refresh = service.refresh(session.id);
    await vi.waitFor(() => expect(activityStarted).toBe(true));
    managedActive = true;
    releaseActivity();
    await refresh;

    expect(readPage).toHaveBeenCalledTimes(1);
    expect(emitSession).toHaveBeenCalledWith({ activity: 'MANAGED_ACTIVE' });
    expect(emitPage).toHaveBeenCalledWith(session, expect.objectContaining({ turns: [] }));
    expect(service.has(session.id)).toBe(true);
    service.clear();
  });

  it('does not publish the old Session and Turn when a managed Run starts while native history is being read', async () => {
    const session = {
      id: 'session-managed-during-read',
      externalSessionId: 'session-managed-during-read'
    } as NodeAgentSession;
    let managedActive = false;
    let readStarted = false;
    let releaseRead!: () => void;
    const page = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const emitSession = vi.fn();
    const emitPage = vi.fn();
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => managedActive,
      refreshActivity: async () => undefined,
      present: () => ({ activity: managedActive ? 'MANAGED_ACTIVE' : 'IDLE' }),
      readPage: async () => {
        readStarted = true;
        const activeAtStart = managedActive;
        await page;
        return { turns: [{ id: activeAtStart ? 'managed-turn' : 'stale-turn' }] };
      },
      emitSession,
      emitPage
    });
    service.watch(session);

    const refresh = service.refresh(session.id);
    await vi.waitFor(() => expect(readStarted).toBe(true));
    managedActive = true;
    service.emitRealtime(session.id, { sequence: 1, category: 'run', payload: {} });
    releaseRead();
    await refresh;

    expect(emitSession).not.toHaveBeenCalled();
    expect(emitPage).not.toHaveBeenCalled();
    expect(service.has(session.id)).toBe(true);
    service.clear();
  });

  it('discards a stale page and converges on the next read when the session-event revision changes during background history read', async () => {
    const session = {
      id: 'session-revision-during-read',
      externalSessionId: 'session-revision-during-read'
    } as NodeAgentSession;
    let revision = 0;
    let reads = 0;
    let releaseRead!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const emitPage = vi.fn();
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => false,
      refreshActivity: async () => undefined,
      present: () => ({ activity: 'IDLE' }),
      readPage: async () => {
        reads += 1;
        if (reads === 1) await firstRead;
        return { turns: [{ id: reads === 1 ? 'stale-turn' : 'current-turn' }] };
      },
      emitSession: vi.fn(),
      emitPage
    });
    service.watch(session);

    const refresh = service.refresh(session.id);
    await vi.waitFor(() => expect(reads).toBe(1));
    revision = 2;
    service.emitRealtime(session.id, { sequence: revision, category: 'run', payload: {} });
    releaseRead();
    await refresh;

    expect(reads).toBe(1);
    expect(emitPage).not.toHaveBeenCalled();
    await service.refresh(session.id);
    expect(reads).toBe(2);
    expect(emitPage).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ turns: [expect.objectContaining({ id: 'current-turn' })] })
    );
    service.clear();
  });

  it('shares concurrent first reads and refreshes history for a later initial subscription', async () => {
    const session = {
      id: 'session-multiple-pages',
      workspaceId: 'workspace-multiple-pages',
      externalSessionId: 'external-multiple-pages'
    } as NodeAgentSession;
    let reads = 0;
    let releaseRead!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const emitted: unknown[] = [];
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => false,
      refreshActivity: async () => undefined,
      present: () => ({ activity: 'IDLE' }),
      readPage: async () => {
        reads += 1;
        if (reads === 1) await firstRead;
        return { turns: [{ id: 'shared-turn' }] };
      },
      projectInitialPage: (_session, page) => page,
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => emitted.push(event),
      nodeGeneration: () => 'test-generation'
    });
    const watch = service.operations()['session.watch']!;
    const initial = (connection: string, watchId: string) =>
      watch({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        workbenchConnectionId: connection,
        watchId,
        mode: 'initial',
        unit: 'SEGMENT'
      });

    await Promise.all([
      initial('connection-page-one', 'watch-page-one'),
      initial('connection-page-two', 'watch-page-two')
    ]);
    await vi.waitFor(() => expect(reads).toBe(1));
    service.emitRealtime(session.id, {
      sequence: 1,
      category: 'conversation',
      payload: { event: { eventType: 'text.delta' } }
    });
    releaseRead();
    await vi.waitFor(() =>
      expect(
        emitted.filter((event) => (event as { type?: string }).type === 'watch.session.snapshot')
      ).toHaveLength(2)
    );
    for (const connection of ['connection-page-one', 'connection-page-two']) {
      const pageEvents = emitted.filter(
        (event) =>
          (event as { workbenchConnectionId?: string }).workbenchConnectionId === connection
      ) as Array<{ type?: string }>;
      expect(pageEvents.map((event) => event.type)).toEqual([
        'watch.session.snapshot',
        'watch.session.event'
      ]);
    }
    await initial('connection-page-three', 'watch-page-three');
    await vi.waitFor(() =>
      expect(
        emitted.filter((event) => (event as { type?: string }).type === 'watch.session.snapshot')
      ).toHaveLength(3)
    );
    expect(reads).toBe(2);
    emitted.length = 0;
    expect(
      service.emitRealtime(session.id, {
        sequence: 4,
        category: 'run',
        payload: { run: { id: 'run-1' } }
      })
    ).toBe(true);
    expect(
      emitted.map((event) => (event as { workbenchConnectionId?: string }).workbenchConnectionId)
    ).toEqual(['connection-page-one', 'connection-page-two', 'connection-page-three']);
    service.clear();
  });

  it('keeps the shared observation until the last page unsubscribes while rereading each new initial', async () => {
    const session = {
      id: 'session-cache-lease-lifecycle',
      workspaceId: 'workspace-cache-lease-lifecycle',
      externalSessionId: 'external-cache-lease-lifecycle'
    } as NodeAgentSession;
    let reads = 0;
    const emitted: Array<{ type?: string; workbenchConnectionId?: string }> = [];
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => false,
      refreshActivity: async () => undefined,
      present: () => ({ activity: 'IDLE' }),
      readPage: async () => ({ turns: [{ id: `turn-${++reads}` }] }),
      projectInitialPage: (_session, page) => page,
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => emitted.push(event as (typeof emitted)[number]),
      nodeGeneration: () => 'test-generation'
    });
    const watch = service.operations()['session.watch']!;
    const unwatch = service.operations()['session.unwatch']!;
    const initial = (connection: string, watchId: string) =>
      watch({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        workbenchConnectionId: connection,
        watchId,
        mode: 'initial',
        unit: 'SEGMENT'
      });
    const stop = (connection: string, watchId: string) =>
      unwatch({
        sessionId: session.id,
        workbenchConnectionId: connection,
        watchId
      });

    await initial('connection-one', 'watch-one');
    await initial('connection-two', 'watch-two');
    await vi.waitFor(() =>
      expect(emitted.filter((event) => event.type === 'watch.session.snapshot')).toHaveLength(2)
    );
    expect(reads).toBe(1);
    stop('connection-one', 'watch-one');
    await initial('connection-three', 'watch-three');
    await vi.waitFor(() =>
      expect(
        emitted.filter(
          (event) =>
            event.type === 'watch.session.snapshot' &&
            event.workbenchConnectionId === 'connection-three'
        )
      ).toHaveLength(1)
    );
    expect(reads).toBe(2);

    stop('connection-two', 'watch-two');
    stop('connection-three', 'watch-three');
    expect(service.has(session.id)).toBe(false);
    await initial('connection-four', 'watch-four');
    await vi.waitFor(() =>
      expect(
        emitted.filter(
          (event) =>
            event.type === 'watch.session.snapshot' &&
            event.workbenchConnectionId === 'connection-four'
        )
      ).toHaveLength(1)
    );
    expect(reads).toBe(3);
    service.clear();
  });

  it("shared periodic refresh does not overtake a new page's own initial snapshot", async () => {
    const session = {
      id: 'session-initial-refresh-order',
      workspaceId: 'workspace-initial-refresh-order',
      externalSessionId: 'external-initial-refresh-order'
    } as NodeAgentSession;
    let reads = 0;
    let releaseSecondRead!: () => void;
    const secondRead = new Promise<void>((resolve) => {
      releaseSecondRead = resolve;
    });
    const emitted: Array<{ type?: string; workbenchConnectionId?: string }> = [];
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => false,
      refreshActivity: async () => undefined,
      present: () => ({ activity: 'IDLE' }),
      readPage: async () => {
        reads += 1;
        if (reads === 2) await secondRead;
        return { turns: [{ id: `turn-${reads}` }] };
      },
      projectInitialPage: (_session, page) => page,
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => emitted.push(event as (typeof emitted)[number]),
      nodeGeneration: () => 'test-generation'
    });
    const watch = service.operations()['session.watch']!;
    const initial = (connection: string, watchId: string) =>
      watch({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        workbenchConnectionId: connection,
        watchId,
        mode: 'initial',
        unit: 'SEGMENT'
      });

    await initial('connection-ready', 'watch-ready');
    await vi.waitFor(() => expect(reads).toBe(1));
    service.emitRealtime(session.id, { sequence: 1, category: 'run', payload: {} });
    const refresh = service.refresh(session.id);
    await vi.waitFor(() => expect(reads).toBe(2));
    await initial('connection-initializing', 'watch-initializing');
    expect(
      emitted.filter(
        (event) =>
          event.type === 'watch.session.snapshot' &&
          event.workbenchConnectionId === 'connection-initializing'
      )
    ).toHaveLength(0);
    releaseSecondRead();
    await refresh;
    await vi.waitFor(() =>
      expect(
        emitted.filter(
          (event) =>
            event.type === 'watch.session.snapshot' &&
            event.workbenchConnectionId === 'connection-initializing'
        )
      ).toHaveLength(1)
    );

    const initializingEvents = emitted.filter(
      (event) => event.workbenchConnectionId === 'connection-initializing'
    );
    expect(initializingEvents.map((event) => event.type)).toEqual(['watch.session.snapshot']);
    expect(reads).toBe(3);
    await initial('connection-cached', 'watch-cached');
    await vi.waitFor(() =>
      expect(
        emitted.filter(
          (event) =>
            event.type === 'watch.session.snapshot' &&
            event.workbenchConnectionId === 'connection-cached'
        )
      ).toHaveLength(1)
    );
    expect(reads).toBe(4);
    service.clear();
  });

  it('multiple pages share the initial history snapshot and each switch once between a Run and an Idle history containing an error', async () => {
    const session = {
      id: 'session-shared-history-runtime',
      workspaceId: 'workspace-shared-history-runtime',
      externalSessionId: 'external-shared-history-runtime'
    } as NodeAgentSession;
    let managedActive = false;
    let historyReads = 0;
    let runtimeReads = 0;
    let historyTurns = [{ id: 'history-turn' }];
    const emitted: Array<{
      type?: string;
      workbenchConnectionId?: string;
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
          return { turns: [{ id: 'runtime-error-turn' }], source: 'runtime' };
        }
        historyReads += 1;
        return { turns: historyTurns, source: 'official' };
      },
      projectInitialPage: (_session, page) => page,
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => emitted.push(event as (typeof emitted)[number]),
      nodeGeneration: () => 'test-generation'
    });
    const initial = (connection: string, watchId: string) =>
      service.operations()['session.watch']!({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        workbenchConnectionId: connection,
        watchId,
        mode: 'initial',
        unit: 'SEGMENT'
      });

    await initial('connection-one', 'watch-one');
    await vi.waitFor(() => expect(historyReads).toBe(1));
    await initial('connection-two', 'watch-two');
    await vi.waitFor(() =>
      expect(emitted.filter((event) => event.type === 'watch.session.snapshot')).toHaveLength(2)
    );
    expect(historyReads).toBe(2);
    emitted.length = 0;

    managedActive = true;
    service.emitRealtime(session.id, {
      sequence: 1,
      category: 'run',
      payload: { run: { status: 'STARTING' } }
    });
    await Promise.all([
      initial('connection-three', 'watch-three'),
      initial('connection-four', 'watch-four')
    ]);
    await vi.waitFor(() =>
      expect(emitted.filter((event) => event.type === 'watch.session.snapshot')).toHaveLength(4)
    );
    expect(runtimeReads).toBe(1);
    for (const connection of ['connection-one', 'connection-two']) {
      const events = emitted.filter((event) => event.workbenchConnectionId === connection);
      expect(events.map((event) => event.type)).toEqual([
        'watch.session.snapshot',
        'watch.session.event'
      ]);
      expect(events[0]?.payload?.turns?.map((turn) => turn.id)).toEqual([
        'history-turn',
        'runtime-error-turn'
      ]);
    }
    for (const connection of ['connection-three', 'connection-four']) {
      const events = emitted.filter((event) => event.workbenchConnectionId === connection);
      expect(events.map((event) => event.type)).toEqual(['watch.session.snapshot']);
      expect(events[0]?.payload?.turns?.map((turn) => turn.id)).toEqual([
        'history-turn',
        'runtime-error-turn'
      ]);
    }

    emitted.length = 0;
    managedActive = false;
    historyTurns = [{ id: 'history-turn' }, { id: 'runtime-error-turn' }];
    service.emitRealtime(session.id, {
      sequence: 2,
      category: 'session',
      payload: { session: { activity: 'IDLE' } }
    });
    service.emitRealtime(session.id, {
      sequence: 3,
      category: 'conversation',
      payload: { turn: { id: 'runtime-error-turn' } }
    });
    await vi.waitFor(() => expect(historyReads).toBe(3));
    await vi.waitFor(() =>
      expect(emitted.filter((event) => event.type === 'watch.session.snapshot')).toHaveLength(4)
    );
    for (const connection of [
      'connection-one',
      'connection-two',
      'connection-three',
      'connection-four'
    ]) {
      const snapshots = emitted.filter(
        (event) =>
          event.type === 'watch.session.snapshot' && event.workbenchConnectionId === connection
      );
      expect(snapshots[0]?.payload?.turns?.map((turn) => turn.id)).toEqual([
        'history-turn',
        'runtime-error-turn'
      ]);
      expect(
        emitted
          .filter((event) => event.workbenchConnectionId === connection)
          .map((event) => event.type)
      ).toEqual(['watch.session.snapshot', 'watch.session.event', 'watch.session.event']);
    }
    await initial('connection-five', 'watch-five');
    await vi.waitFor(() =>
      expect(
        emitted.filter(
          (event) =>
            event.type === 'watch.session.snapshot' &&
            event.workbenchConnectionId === 'connection-five'
        )
      ).toHaveLength(1)
    );
    expect(historyReads).toBe(4);
    service.clear();
  });

  it('publishes a changed Runtime page when terminal convergence adds a Rewind boundary', async () => {
    const session = {
      id: 'session-runtime-rewind-convergence',
      workspaceId: 'workspace-runtime-rewind-convergence',
      externalSessionId: 'external-runtime-rewind-convergence'
    } as NodeAgentSession;
    let managedActive = true;
    const runtimeTurn = {
      id: 'runtime-turn',
      status: 'RUNNING',
      items: [{ id: 'user', kind: 'user_message' }]
    };
    const emitted: Array<{
      type?: string;
      payload?: { turns?: Array<{ id: string; rewind?: { before: string; after: string } }> };
    }> = [];
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => managedActive,
      refreshActivity: async () => undefined,
      present: () => ({ activity: managedActive ? 'MANAGED_ACTIVE' : 'IDLE' }),
      readPage: async () => ({
        source: 'runtime' as const,
        turns: managedActive
          ? [runtimeTurn]
          : [
              {
                ...runtimeTurn,
                status: 'CANCELLED',
                rewind: { before: 'native-previous', after: 'native-current' }
              }
            ]
      }),
      projectInitialPage: (_session, page) => page,
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => emitted.push(event as (typeof emitted)[number])
    });

    try {
      await service.operations()['session.watch']!({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        workbenchConnectionId: 'connection-runtime-rewind-convergence',
        watchId: 'watch-runtime-rewind-convergence',
        mode: 'initial',
        unit: 'SEGMENT'
      });
      await vi.waitFor(() => expect(emitted).toHaveLength(1));

      managedActive = false;
      service.emitRealtime(session.id, {
        sequence: 1,
        category: 'session',
        payload: { session: { activity: 'IDLE' } }
      });

      await vi.waitFor(() =>
        expect(emitted.filter((event) => event.type === 'watch.session.snapshot')).toHaveLength(2)
      );
      expect(emitted[1]).toMatchObject({
        type: 'watch.session.snapshot',
        payload: {
          turns: [
            {
              id: 'runtime-turn',
              status: 'CANCELLED',
              rewind: { before: 'native-previous', after: 'native-current' }
            }
          ]
        }
      });
    } finally {
      service.clear();
    }
  });

  it('sends one handoff snapshot per lease when periodic refresh joins the IDLE transition read', async () => {
    const session = {
      id: 'session-idle-shared-refresh',
      workspaceId: 'workspace-idle-shared-refresh',
      externalSessionId: 'external-idle-shared-refresh'
    } as NodeAgentSession;
    let managedActive = true;
    let runtimeReads = 0;
    let historyReads = 0;
    let idleReads = 0;
    let releaseIdleRead!: () => void;
    const idleRead = new Promise<void>((resolve) => (releaseIdleRead = resolve));
    const emitted: Array<{ type?: string; workbenchConnectionId?: string }> = [];
    const service = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => managedActive,
      refreshActivity: async () => undefined,
      present: () => ({ activity: managedActive ? 'MANAGED_ACTIVE' : 'IDLE' }),
      readPage: async () => {
        if (managedActive) {
          runtimeReads += 1;
          return { source: 'runtime' as const, turns: [{ id: 'runtime-turn' }] };
        }
        idleReads += 1;
        await idleRead;
        return { source: 'official' as const, turns: [{ id: 'handoff-turn' }] };
      },
      readHistoryPage: async () => {
        historyReads += 1;
        return { source: 'official' as const, turns: [{ id: 'history-turn' }] };
      },
      projectInitialPage: (_session, page) => page,
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => emitted.push(event as (typeof emitted)[number])
    });
    const watch = service.operations()['session.watch']!;
    const initial = (connection: string) =>
      watch({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        workbenchConnectionId: connection,
        watchId: `watch-${connection}`,
        mode: 'initial',
        unit: 'SEGMENT'
      });

    try {
      await Promise.all([initial('connection-idle-one'), initial('connection-idle-two')]);
      await vi.waitFor(() => {
        expect(
          emitted.some(
            (event) =>
              event.type === 'watch.session.snapshot' &&
              event.workbenchConnectionId === 'connection-idle-one'
          )
        ).toBe(true);
        expect(
          emitted.some(
            (event) =>
              event.type === 'watch.session.snapshot' &&
              event.workbenchConnectionId === 'connection-idle-two'
          )
        ).toBe(true);
        expect(historyReads).toBe(1);
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      emitted.length = 0;

      managedActive = false;
      service.emitRealtime(session.id, {
        sequence: 1,
        category: 'session',
        payload: { session: { activity: 'IDLE' } }
      });
      await vi.waitFor(() => expect(idleReads).toBe(1));
      const refresh = service.refresh(session.id);
      await Promise.resolve();
      releaseIdleRead();
      await refresh;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(runtimeReads).toBe(1);
      expect(idleReads).toBe(1);
      for (const connection of ['connection-idle-one', 'connection-idle-two'])
        expect(
          emitted.filter(
            (event) =>
              event.type === 'watch.session.snapshot' && event.workbenchConnectionId === connection
          )
        ).toHaveLength(1);
    } finally {
      releaseIdleRead();
      service.clear();
    }
  });

  it.each(['success', 'failure'])(
    'routes an IDLE %s handoff through one Watch completion',
    async (outcome) => {
      const session = {
        id: `session-idle-completion-${outcome}`,
        workspaceId: `workspace-idle-completion-${outcome}`,
        externalSessionId: `external-idle-completion-${outcome}`
      } as NodeAgentSession;
      let managedActive = false;
      let projectionRevision = 0;
      let runtimeReads = 0;
      let idleReads = 0;
      let resolveIdleRead:
        ((page: { source: 'official'; turns: { id: string }[] }) => void) | undefined;
      let rejectIdleRead: ((error: Error) => void) | undefined;
      const emitted: Array<{ type?: string; workbenchConnectionId?: string }> = [];
      const emitSession = vi.fn();
      const log = vi.fn();
      const service = createTestSessionWatch({
        resolve: async () => session,
        managedActive: () => managedActive,
        refreshActivity: async () => undefined,
        present: () => ({
          activity: managedActive ? 'MANAGED_ACTIVE' : 'IDLE',
          revision: projectionRevision
        }),
        readPage: async () => {
          if (managedActive) {
            runtimeReads += 1;
            return { source: 'runtime' as const, turns: [{ id: `runtime-${runtimeReads}` }] };
          }
          idleReads += 1;
          return new Promise<{ source: 'official'; turns: { id: string }[] }>((resolve, reject) => {
            resolveIdleRead = resolve;
            rejectIdleRead = reject;
          });
        },
        readHistoryPage: async () => ({
          source: 'official' as const,
          turns: [{ id: 'history-turn' }]
        }),
        projectInitialPage: (_session, page) => page,
        emitSession,
        emitPage: vi.fn(),
        emitWatchEvent: (event) => emitted.push(event as (typeof emitted)[number]),
        log
      });
      const watch = service.operations()['session.watch']!;
      const refreshFailures = () =>
        log.mock.calls
          .filter(([event]) => event === 'session.watch.refresh.failed')
          .map(([, fields]) => fields);

      try {
        await watch({
          sessionId: session.id,
          workspaceId: session.workspaceId,
          workbenchConnectionId: `connection-${outcome}`,
          watchId: `watch-${outcome}`,
          mode: 'initial',
          unit: 'SEGMENT'
        });
        await vi.waitFor(() =>
          expect(emitted.filter((event) => event.type === 'watch.session.snapshot')).toHaveLength(1)
        );
        await service.refresh(session.id);
        emitSession.mockClear();

        managedActive = true;
        service.emitRealtime(session.id, {
          sequence: 1,
          category: 'run',
          payload: { run: { status: 'RUNNING' } }
        });
        await vi.waitFor(() => expect(runtimeReads).toBe(1));
        await new Promise<void>((resolve) => setImmediate(resolve));
        emitSession.mockClear();

        projectionRevision = 1;
        managedActive = false;
        service.emitRealtime(session.id, {
          sequence: 2,
          category: 'session',
          payload: { session: { activity: 'IDLE' } }
        });
        await vi.waitFor(() => expect(idleReads).toBe(1));

        if (outcome === 'success') {
          resolveIdleRead!({ source: 'official', turns: [{ id: 'handoff-turn' }] });
          await vi.waitFor(() =>
            expect(emitSession).toHaveBeenCalledWith({ activity: 'IDLE', revision: 1 })
          );
          expect(service.has(session.id)).toBe(true);
        } else {
          const sharedRefresh = service.refresh(session.id);
          rejectIdleRead!(new Error('idle history read failed'));
          await sharedRefresh;
          await vi.waitFor(() => expect(refreshFailures()).toHaveLength(1));
          expect(refreshFailures().map((record) => record.failureCount)).toEqual([1]);
          await new Promise<void>((resolve) => setImmediate(resolve));

          const secondRefresh = service.refresh(session.id);
          await vi.waitFor(() => expect(idleReads).toBe(2));
          rejectIdleRead!(new Error('idle history read failed'));
          await secondRefresh;
          await vi.waitFor(() => expect(refreshFailures()).toHaveLength(2));
          expect(refreshFailures().map((record) => record.failureCount)).toEqual([1, 2]);
          await new Promise<void>((resolve) => setImmediate(resolve));

          const thirdRefresh = service.refresh(session.id);
          await vi.waitFor(() => expect(idleReads).toBe(3));
          rejectIdleRead!(new Error('idle history read failed'));
          await thirdRefresh;
          await vi.waitFor(() => expect(refreshFailures()).toHaveLength(3));
          expect(refreshFailures().map((record) => record.failureCount)).toEqual([1, 2, 3]);
          expect(refreshFailures()[2]).toMatchObject({ terminal: true });
          expect(service.has(session.id)).toBe(false);
        }
      } finally {
        resolveIdleRead?.({ source: 'official', turns: [] });
        service.clear();
      }
    }
  );
});
