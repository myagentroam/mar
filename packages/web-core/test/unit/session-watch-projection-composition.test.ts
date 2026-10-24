import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { AgentRun, Session, WorkspaceTarget } from '../../src/model/workbench.js';
import {
  createWorkbenchLiveService,
  type WorkbenchLiveEvent
} from '../../src/service/workbench-live-service.js';
import { createWorkbenchEventProjectionService } from '../../src/service/workbench-event-projection-service.js';
import { createWorkbenchSessionWatchController } from '../../src/service/workbench-session-watch-controller.js';

// Real transport routing, Watch admission, and domain projection; only the wire and I/O are faked.
describe('Session Watch projection composition', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('isolates broadcasts, replaced targets and connections while retaining in-flight same-resource Watch events', async () => {
    class Socket extends EventTarget {
      static readonly OPEN = 1;
      static current: Socket;
      readyState = Socket.OPEN;
      constructor() {
        super();
        Socket.current = this;
      }
      send() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', Socket);
    vi.stubGlobal('window', { location: { origin: 'https://console.example' } });
    const workspaceTarget = ref<WorkspaceTarget>({ nodeId: 'node-1', workspaceId: 'workspace-1' });
    const selectedSessionId = ref<string | undefined>('session-1');
    const session: Session = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex',
      externalSessionId: 'native-1',
      activity: 'IDLE'
    };
    const sessions = ref<Session[]>([session]);
    const runs = ref<AgentRun[]>([]);
    const effects = {
      mergeQueue: vi.fn(),
      mergeSessions: vi.fn(),
      settleSessionRuns: vi.fn(() => false),
      observeManagedSessionActive: vi.fn(),
      updateContext: vi.fn(),
      syncTurnStatus: vi.fn(),
      cacheRun: vi.fn(),
      openRun: vi.fn(),
      markLiveTurn: vi.fn(),
      cacheTurn: vi.fn(),
      mergeTurns: vi.fn(() => false),
      applyConversationSnapshot: vi.fn(() => false),
      mergeItem: vi.fn(() => false),
      mergeTextDelta: vi.fn(),
      receivePerformance: vi.fn()
    };
    const onNodeConnected = vi.fn();
    const invalidateWorkspace = vi.fn();
    const projection = createWorkbenchEventProjectionService({
      ...effects,
      nodes: ref([
        {
          id: 'node-1',
          displayName: null,
          registeredAddress: '',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.10.1',
          nodeVersion: 'v24',
          connected: false,
          disabled: false,
          capabilities: {}
        }
      ]),
      sessions,
      runs,
      workspaceTarget,
      selectedSessionId,
      conversationNextCursor: ref(null),
      workspaceCache: () => undefined,
      newestRun: (_current, next) => next,
      onNodeConnected,
      invalidateWorkspace
    });
    let connectionId = 'connection-1';
    let requested: Record<string, unknown> = {};
    const watch = createWorkbenchSessionWatchController({
      workspaceTarget,
      selectedSessionId,
      sessions,
      followConversation: ref(false),
      heartbeatMs: 60_000,
      requestTimeoutMs: 10_000,
      confirmationTimeoutMs: 10_000,
      workbenchConnectionId: () => connectionId,
      request: async <T>(_path: string, init?: RequestInit) => {
        if (init?.method === 'POST')
          requested = {
            ...(JSON.parse(String(init.body)) as Record<string, unknown>),
            sessionId: _path.split('/').at(-2)
          };
        return { nodeGeneration: 'generation-1' } as T;
      },
      sessionPathId: (id) => id,
      mergeSessions: effects.mergeSessions,
      applyEvent: projection.apply,
      applySnapshot: effects.applyConversationSnapshot,
      scrollAfterLayout: async () => undefined,
      refreshSnapshot: vi.fn(),
      openSession: async () => undefined
    });
    const observeFrame = vi.fn();
    const onNotificationMessage = vi.fn(
      (message: unknown) => (message as { type?: string }).type === 'notification.created'
    );
    const live = createWorkbenchLiveService({
      canConnect: () => true,
      onEvent: projection.applyBroadcast,
      onWatchEvent: watch.handleEvent,
      onNotificationMessage,
      onReady: (id) => {
        connectionId = id;
      },
      onResyncRequired: vi.fn(),
      onNodeConnection: projection.updateNodeConnection,
      onNodeReplaced: vi.fn(),
      onReconnect: vi.fn(),
      onUnauthenticated: vi.fn(),
      onInvalidMessage: vi.fn(),
      diagnostics: { observeFrame, setConnectionState: vi.fn(), resetActiveRuns: vi.fn() }
    });
    const emit = (message: unknown) =>
      Socket.current.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
    let sequence = 0;
    const broadcast = (category: WorkbenchLiveEvent['category'], payload: unknown) =>
      emit({ type: 'event', event: { nodeId: 'node-1', sequence: ++sequence, category, payload } });
    const initial = (identity = requested, title = 'Watch initial') =>
      emit({
        type: 'watch.event',
        event: {
          ...identity,
          type: 'watch.session.snapshot',
          nodeGeneration: 'generation-1',
          payload: {
            kind: 'session-watch-snapshot',
            sequence: 10,
            session: { ...session, id: selectedSessionId.value, runnerTitle: title },
            runs: [],
            queue: { version: 0, items: [], paused: false },
            context: null,
            conversation: { unit: 'SEGMENT', segments: [], nextCursor: null, snapshotSequence: 10 }
          }
        }
      });
    const directed = (identity: Record<string, unknown>, title: string, overrides = {}) =>
      emit({
        type: 'watch.event',
        event: {
          ...identity,
          type: 'watch.session.event',
          nodeGeneration: 'generation-1',
          ...overrides,
          event: {
            category: 'session',
            sequence: 11,
            payload: { session: { ...session, id: selectedSessionId.value, runnerTitle: title } }
          }
        }
      });
    const assertNoSessionEffects = () => {
      expect(runs.value).toEqual([]);
      for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
    };
    live.connect();
    Socket.current.dispatchEvent(new Event('open'));
    emit({
      type: 'workbench.ready',
      workbenchConnectionId: connectionId,
      workbenchResumeToken: 'test-token'
    });
    try {
      const begun = watch.beginSelectedSessionWatch('session-1');
      await vi.waitFor(() => expect(requested.sessionId).toBe('session-1'));
      const first = { ...requested };
      broadcast('session', { session: { ...session, activity: 'MANAGED_ACTIVE' } });
      broadcast('session', { sessionId: session.id, context: { used: 999 } });
      broadcast('run', { run: { id: 'run-1', sessionId: session.id, status: 'RUNNING' } });
      broadcast('queue', { sessionId: session.id, queue: { version: 9, items: [], paused: true } });
      broadcast('conversation', {
        sessionId: session.id,
        snapshot: { unit: 'SEGMENT', segments: [], nextCursor: null }
      });
      broadcast('conversation', { sessionId: session.id, runId: 'run-1', item: { id: 'item-1' } });
      broadcast('conversation', {
        sessionId: session.id,
        delta: { runId: 'run-1', itemId: 'item-1', text: 'broadcast' }
      });
      broadcast('conversation', { sessionId: session.id, performance: { latencyMs: 99 } });
      assertNoSessionEffects();
      broadcast('node', { connected: true });
      broadcast('workspace', { workspaceId: 'workspace-1', topic: 'files' });
      emit({ type: 'notification.created' });
      expect(onNodeConnected).toHaveBeenCalledWith('node-1');
      expect(invalidateWorkspace).toHaveBeenCalledWith('node-1', 'workspace-1', 'files');
      expect(onNotificationMessage).toHaveBeenCalledWith({ type: 'notification.created' });
      expect(observeFrame).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.objectContaining({ type: 'event' }) })
      );

      directed(first, 'Buffered event');
      assertNoSessionEffects();
      initial(first);
      await begun;
      expect(effects.applyConversationSnapshot).toHaveBeenCalledOnce();
      expect(effects.mergeQueue).toHaveBeenCalledWith(
        { version: 0, items: [], paused: false },
        'initial'
      );
      expect(effects.mergeSessions.mock.calls.at(-1)?.[0][0]).toMatchObject({
        runnerTitle: 'Buffered event'
      });
      emit({
        type: 'watch.event',
        event: {
          ...first,
          type: 'watch.session.event',
          nodeGeneration: 'generation-1',
          event: {
            category: 'conversation',
            sequence: 12,
            payload: {
              sessionId: session.id,
              delta: { runId: 'run-1', itemId: 'item-1', text: 'Watch delta' }
            }
          }
        }
      });
      expect(effects.mergeTextDelta).toHaveBeenCalledWith(
        'run-1',
        { runId: 'run-1', itemId: 'item-1', text: 'Watch delta' },
        12,
        undefined
      );

      const restarted = watch.restartSelectedSessionWatch('session-1');
      await vi.waitFor(() => expect(requested.watchId).not.toBe(first.watchId));
      const second = { ...requested };
      expect(second.watchId).not.toBe(first.watchId);
      effects.mergeSessions.mockClear();
      directed(first, 'Legal in-flight event');
      initial(first, 'Stale initial');
      expect(effects.mergeSessions).not.toHaveBeenCalled();
      initial(second, 'Replacement initial');
      await restarted;
      expect(effects.mergeSessions.mock.calls.at(-1)?.[0][0]).toMatchObject({
        runnerTitle: 'Legal in-flight event'
      });
      directed(first, 'Legal after replacement');
      expect(effects.mergeSessions.mock.calls.at(-1)?.[0][0]).toMatchObject({
        runnerTitle: 'Legal after replacement'
      });

      sessions.value.push({ ...session, id: 'session-2' });
      selectedSessionId.value = 'session-2';
      const switched = watch.beginSelectedSessionWatch('session-2');
      await vi.waitFor(() => expect(requested.sessionId).toBe('session-2'));
      const third = { ...requested };
      effects.mergeSessions.mockClear();
      directed(first, 'Wrong target');
      initial(second);
      directed(third, 'Wrong generation', { nodeGeneration: 'old-generation' });
      expect(effects.mergeSessions).not.toHaveBeenCalled();
      initial(third, 'New target');
      await switched;
      expect(effects.mergeSessions.mock.calls.at(-1)?.[0][0]).toMatchObject({
        id: 'session-2',
        runnerTitle: 'New target'
      });

      connectionId = 'connection-2';
      const reconnected = watch.beginSelectedSessionWatch('session-2');
      await vi.waitFor(() => expect(requested.workbenchConnectionId).toBe('connection-2'));
      const fourth = { ...requested };
      effects.mergeSessions.mockClear();
      directed(third, 'Old connection');
      initial(third);
      broadcast('session', {
        session: { ...session, id: 'session-2', runnerTitle: 'Reconnect broadcast' }
      });
      expect(effects.mergeSessions).not.toHaveBeenCalled();
      initial(fourth, 'Reconnected initial');
      await reconnected;
      directed(fourth, 'Reconnected event');
      expect(effects.mergeSessions.mock.calls.at(-1)?.[0][0]).toMatchObject({
        runnerTitle: 'Reconnected event'
      });
    } finally {
      watch.stopSelectedSessionWatch();
      live.close();
    }
  });
});
