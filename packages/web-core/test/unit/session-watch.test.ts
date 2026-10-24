import { workspaceTargetRef } from './support/workspace-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import { createWorkbenchSessionWatchController } from '../../src/service/WorkbenchSessionWatchController.js';
import type { Session } from '../../src/model/workbench.js';
import { ref } from 'vue';

function segment(id: string, index = 0) {
  return {
    id,
    turnId: id.split(':segment:')[0] ?? id,
    sessionId: 'session-1',
    runId: null,
    index,
    status: 'SUCCEEDED',
    items: []
  };
}

describe('Web Session Watch Lifecycle', () => {
  it('Does not create a Session initial watch when the connection is unavailable, the feature is disabled, the session is a draft, or the page is hidden', async () => {
    for (const scenario of [
      { connectionId: undefined, enabled: true, id: 'session-1', visibility: 'visible' },
      { connectionId: 'connection-1', enabled: false, id: 'session-1', visibility: 'visible' },
      { connectionId: 'connection-1', enabled: true, id: 'draft:session-1', visibility: 'visible' },
      { connectionId: 'connection-1', enabled: true, id: 'session-1', visibility: 'hidden' }
    ]) {
      vi.useFakeTimers();
      vi.stubGlobal('document', { visibilityState: scenario.visibility });
      const request = vi.fn(async () => undefined as never);
      const controller = createWorkbenchSessionWatchController({
        workspaceTarget: workspaceTargetRef(ref('node-1'), ref('workspace-1')),
        selectedSessionId: ref(scenario.id),
        sessions: ref([
          {
            id: scenario.id,
            workspaceId: 'workspace-1',
            runner: 'codex',
            activity: 'IDLE'
          }
        ]),
        followConversation: ref(false),
        heartbeatMs: 15_000,
        requestTimeoutMs: 10_000,
        confirmationTimeoutMs: 45_000,
        enabled: () => scenario.enabled,
        workbenchConnectionId: () => scenario.connectionId,
        request,
        sessionPathId: (value) => value,
        mergeSessions: vi.fn(),
        applySnapshot: vi.fn(() => true),
        scrollAfterLayout: vi.fn(async () => undefined),
        refreshSnapshot: vi.fn(),
        openSession: vi.fn(async () => undefined)
      });
      try {
        await controller.beginSelectedSessionWatch(scenario.id);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(request).not.toHaveBeenCalled();
      } finally {
        controller.stopSelectedSessionWatch();
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    }
  });

  it('Keeps the existing Watch and does not trigger an authoritative reload when renew receives a real 204 response', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('document', { visibilityState: 'visible' });
    const requests: RequestInit[] = [];
    const refreshSnapshot = vi.fn();
    const applySnapshot = vi.fn();
    const applyEvent = vi.fn();
    const applyRunsSnapshot = vi.fn();
    const controller = createWorkbenchSessionWatchController({
      workspaceTarget: workspaceTargetRef(ref('node-1'), ref('workspace-1')),
      selectedSessionId: ref('session-1'),
      sessions: ref([{ id: 'session-1', workspaceId: 'workspace-1', activity: 'IDLE' }] as never),
      followConversation: ref(false),
      heartbeatMs: 15_000,
      requestTimeoutMs: 10_000,
      confirmationTimeoutMs: 45_000,
      request: async (_path, init) => {
        requests.push(init ?? {});
        const mode = JSON.parse(String(init?.body)).mode as 'initial' | 'renew';
        return (mode === 'initial' ? { nodeGeneration: 'test-generation' } : undefined) as never;
      },
      sessionPathId: (value) => value,
      mergeSessions: vi.fn(),
      applyRunsSnapshot,
      applySnapshot,
      applyEvent,
      scrollAfterLayout: vi.fn(),
      refreshSnapshot,
      openSession: vi.fn()
    });

    controller.beginSelectedSessionWatch('session-1');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const watchId = JSON.parse(String(requests[0]?.body)).watchId as string;
    controller.handleEvent({
      type: 'watch.session.snapshot',
      workbenchConnectionId: 'local-test-connection',
      nodeGeneration: 'test-generation',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      watchId,
      sessionId: 'session-1',
      payload: {
        kind: 'session-watch-snapshot',
        sequence: 2,
        session: { id: 'session-1', workspaceId: 'workspace-1', activity: 'MANAGED_ACTIVE' },
        runs: [{ id: 'run-1', sessionId: 'session-1', status: 'RUNNING' }],
        performance: { runId: 'run-1', latencyMs: 80, tokensPerSecond: 42 },
        queue: { version: 3, paused: false, items: [] },
        context: { model: 'gpt-5', usedTokens: 120, maxTokens: 1_000, percentage: 12 },
        conversation: { unit: 'SEGMENT', segments: [], nextCursor: null, source: 'runtime' }
      }
    });
    await vi.waitFor(() => expect(applySnapshot).toHaveBeenCalledTimes(1));
    expect(applyEvent).toHaveBeenCalledWith({
      nodeId: 'node-1',
      sequence: 2,
      category: 'session',
      payload: {
        session: { id: 'session-1', workspaceId: 'workspace-1', activity: 'MANAGED_ACTIVE' }
      }
    });
    expect(applyRunsSnapshot).toHaveBeenCalledWith([
      { id: 'run-1', sessionId: 'session-1', status: 'RUNNING' }
    ]);
    expect(applyEvent).toHaveBeenCalledWith({
      nodeId: 'node-1',
      sequence: 2,
      category: 'conversation',
      payload: {
        sessionId: 'session-1',
        performance: { runId: 'run-1', latencyMs: 80, tokensPerSecond: 42 }
      }
    });
    expect(applyEvent).toHaveBeenCalledWith(
      {
        nodeId: 'node-1',
        sequence: 2,
        category: 'queue',
        payload: {
          sessionId: 'session-1',
          queue: { version: 3, paused: false, items: [] }
        }
      },
      'initial'
    );
    expect(applyEvent).toHaveBeenCalledWith({
      nodeId: 'node-1',
      sequence: 2,
      category: 'session',
      payload: {
        sessionId: 'session-1',
        context: { model: 'gpt-5', usedTokens: 120, maxTokens: 1_000, percentage: 12 }
      }
    });

    expect(
      controller.handleEvent({
        type: 'watch.session.event',
        workbenchConnectionId: 'local-test-connection',
        nodeGeneration: 'test-generation',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        watchId,
        sessionId: 'session-1',
        event: { sequence: 3, category: 'run', payload: { run: { id: 'run-1' } } }
      })
    ).toBe(true);
    expect(applyEvent).toHaveBeenCalledWith({
      nodeId: 'node-1',
      sequence: 3,
      category: 'run',
      payload: { run: { id: 'run-1' } }
    });
    expect(
      controller.handleEvent({
        type: 'watch.session.event',
        workbenchConnectionId: 'local-test-connection',
        nodeGeneration: 'test-generation',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        watchId: 'replaced-watch-id',
        sessionId: 'session-1',
        event: { sequence: 4, category: 'queue', payload: { queue: { version: 4 } } }
      })
    ).toBe(true);
    expect(applyEvent).toHaveBeenCalledWith({
      nodeId: 'node-1',
      sequence: 4,
      category: 'queue',
      payload: { queue: { version: 4 } }
    });
    expect(
      controller.handleEvent({
        type: 'watch.session.snapshot',
        workbenchConnectionId: 'local-test-connection',
        nodeGeneration: 'test-generation',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        watchId: 'replaced-watch-id',
        sessionId: 'session-1',
        payload: {
          unit: 'SEGMENT',
          segments: [],
          nextCursor: null,
          source: 'native'
        }
      })
    ).toBe(false);
    expect(
      controller.handleEvent({
        type: 'watch.session.event',
        workbenchConnectionId: 'another-connection',
        nodeGeneration: 'test-generation',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        watchId,
        sessionId: 'session-1',
        event: { sequence: 5, category: 'run', payload: {} }
      })
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(45_000);

    expect(requests).toHaveLength(4);
    expect(requests.slice(1).map((request) => JSON.parse(String(request.body)))).toEqual(
      Array.from({ length: 3 }, () => expect.objectContaining({ mode: 'renew', watchId }))
    );
    expect(refreshSnapshot).not.toHaveBeenCalled();
    controller.stopSelectedSessionWatch();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('Continues the Session initial watch after the Workspace snapshot changes the selected session from active to idle', async () => {
    vi.stubGlobal('document', { visibilityState: 'visible' });
    const sessions = ref<Session[]>([
      { id: 'session-1', workspaceId: 'workspace-1', activity: 'IDLE' } as Session
    ]);
    const requests: RequestInit[] = [];
    const controller = createWorkbenchSessionWatchController({
      workspaceTarget: workspaceTargetRef(ref('node-1'), ref('workspace-1')),
      selectedSessionId: ref('session-1'),
      sessions,
      followConversation: ref(false),
      heartbeatMs: 15_000,
      requestTimeoutMs: 10_000,
      confirmationTimeoutMs: 45_000,
      request: async (_path, init) => {
        requests.push(init ?? {});
        return { accepted: true } as never;
      },
      sessionPathId: (value) => value,
      mergeSessions: vi.fn(),
      applySnapshot: vi.fn(),
      scrollAfterLayout: vi.fn(),
      refreshSnapshot: vi.fn(),
      openSession: vi.fn()
    });

    controller.reconcileWorkspaceSnapshot(
      { id: 'session-1', workspaceId: 'workspace-1', activity: 'MANAGED_ACTIVE' } as never,
      sessions.value[0]
    );

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(JSON.parse(String(requests[0]?.body))).toMatchObject({
      mode: 'initial',
      nodeId: 'node-1',
      workspaceId: 'workspace-1'
    });
    controller.stopSelectedSessionWatch();
    vi.unstubAllGlobals();
  });

  it('Applies Node ordering through the unified authoritative snapshot entry point', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('document', { visibilityState: 'visible' });
    const applySnapshot = vi.fn(() => true);
    const scrollAfterLayout = vi.fn(async () => undefined);
    const requests: RequestInit[] = [];
    const controller = createWorkbenchSessionWatchController({
      workspaceTarget: workspaceTargetRef(ref('node-1'), ref('workspace-1')),
      selectedSessionId: ref('session-1'),
      sessions: ref([{ id: 'session-1', workspaceId: 'workspace-1', activity: 'IDLE' }] as never),
      followConversation: ref(true),
      heartbeatMs: 15_000,
      requestTimeoutMs: 10_000,
      confirmationTimeoutMs: 45_000,
      request: async (_path, init) => {
        requests.push(init ?? {});
        return { accepted: true } as never;
      },
      sessionPathId: (value) => value,
      mergeSessions: vi.fn(),
      applySnapshot,
      scrollAfterLayout,
      refreshSnapshot: vi.fn(),
      openSession: vi.fn()
    });

    controller.beginSelectedSessionWatch('session-1');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const watchId = JSON.parse(String(requests[0]?.body)).watchId as string;
    controller.handleEvent({
      type: 'watch.session.snapshot',
      workbenchConnectionId: 'local-test-connection',
      nodeGeneration: 'test-generation',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      watchId,
      sessionId: 'session-1',
      payload: {
        unit: 'SEGMENT',
        segments: [segment('turn-2:segment:0'), segment('turn-1:segment:0')],
        nextCursor: null,
        source: 'native'
      }
    });
    await vi.waitFor(() => expect(applySnapshot).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(applySnapshot).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          turns: [
            expect.objectContaining({ id: 'turn-2:segment:0' }),
            expect.objectContaining({ id: 'turn-1:segment:0' })
          ]
        })
      )
    );
    expect(scrollAfterLayout).not.toHaveBeenCalled();
    controller.handleEvent({
      type: 'watch.session.snapshot',
      workbenchConnectionId: 'local-test-connection',
      nodeGeneration: 'test-generation',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      watchId,
      sessionId: 'session-1',
      payload: {
        unit: 'SEGMENT',
        segments: [segment('turn-3:segment:0')],
        nextCursor: null,
        source: 'native'
      }
    });
    await vi.waitFor(() => expect(scrollAfterLayout).toHaveBeenCalledTimes(1));
    expect(applySnapshot).toHaveBeenLastCalledWith(
      'session-1',
      expect.objectContaining({
        turns: [expect.objectContaining({ id: 'turn-3:segment:0' })]
      }),
      'refresh'
    );
    controller.handleEvent({
      type: 'watch.failed',
      watchType: 'session',
      workbenchConnectionId: 'local-test-connection',
      nodeGeneration: 'test-generation',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      watchId,
      sessionId: 'session-1',
      code: 'NATIVE_TRANSCRIPT_UNAVAILABLE',
      message: 'Session watch snapshot failed.'
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(JSON.parse(String(requests[1]?.body))).toMatchObject({ mode: 'initial' });
    expect(JSON.parse(String(requests[1]?.body)).watchId).not.toBe(watchId);
    controller.stopSelectedSessionWatch();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('Requests the initial watch directly and maps the Segment snapshot', async () => {
    const requests: RequestInit[] = [];
    const applySnapshot = vi.fn();
    const controller = createWorkbenchSessionWatchController({
      workspaceTarget: workspaceTargetRef(ref('node-1'), ref('workspace-1')),
      selectedSessionId: ref('session-1'),
      sessions: ref([{ id: 'session-1', workspaceId: 'workspace-1', activity: 'IDLE' }] as never),
      followConversation: ref(false),
      heartbeatMs: 15_000,
      requestTimeoutMs: 10_000,
      confirmationTimeoutMs: 45_000,
      request: async (_path, init) => {
        requests.push(init ?? {});
        return { accepted: true } as never;
      },
      sessionPathId: (value) => value,
      mergeSessions: vi.fn(),
      applySnapshot,
      scrollAfterLayout: vi.fn(),
      refreshSnapshot: vi.fn(),
      openSession: vi.fn()
    });

    controller.beginSelectedSessionWatch('session-1');
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    expect(JSON.parse(String(requests[0]?.body))).toMatchObject({
      nodeId: 'node-1',
      mode: 'initial',
      unit: 'SEGMENT'
    });
    const watchId = JSON.parse(String(requests[0]?.body)).watchId as string;
    controller.handleEvent({
      type: 'watch.session.snapshot',
      workbenchConnectionId: 'local-test-connection',
      nodeGeneration: 'test-generation',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      watchId,
      sessionId: 'session-1',
      payload: {
        unit: 'SEGMENT',
        segments: [
          {
            id: 'turn-1:segment:0',
            turnId: 'turn-1',
            sessionId: 'session-1',
            runId: null,
            index: 0,
            status: 'SUCCEEDED',
            items: [],
            startedAt: 1,
            completedAt: 2
          }
        ],
        nextCursor: null,
        snapshotSequence: 1,
        source: 'native',
        readAt: 2,
        latestVisibleAt: 2
      }
    });
    await vi.waitFor(() =>
      expect(applySnapshot).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          turns: [expect.objectContaining({ id: 'turn-1:segment:0', segmentIndex: 0 })]
        })
      )
    );
    controller.stopSelectedSessionWatch();
  });

  it('Waits for the matching asynchronous snapshot after initial request confirmation before completing', async () => {
    vi.stubGlobal('document', { visibilityState: 'visible' });
    const requests: RequestInit[] = [];
    const controller = createWorkbenchSessionWatchController({
      workspaceTarget: workspaceTargetRef(ref('node-1'), ref('workspace-1')),
      selectedSessionId: ref('session-1'),
      sessions: ref([{ id: 'session-1', workspaceId: 'workspace-1', activity: 'IDLE' }] as never),
      followConversation: ref(false),
      heartbeatMs: 15_000,
      requestTimeoutMs: 10_000,
      confirmationTimeoutMs: 45_000,
      request: async (_path, init) => {
        requests.push(init ?? {});
        return { accepted: true } as never;
      },
      sessionPathId: (value) => value,
      mergeSessions: vi.fn(),
      applySnapshot: vi.fn(),
      scrollAfterLayout: vi.fn(),
      refreshSnapshot: vi.fn(),
      openSession: vi.fn()
    });

    let completed = false;
    const pending = controller.initializeSelectedSessionWatch('session-1').then(() => {
      completed = true;
    });
    let joinedCompleted = false;
    const joined = Promise.resolve(controller.beginSelectedSessionWatch('session-1')).then(() => {
      joinedCompleted = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(joinedCompleted).toBe(false);
    const watchId = JSON.parse(String(requests[0]?.body)).watchId as string;
    controller.handleEvent({
      type: 'watch.session.snapshot',
      workbenchConnectionId: 'local-test-connection',
      nodeGeneration: 'test-generation',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      watchId,
      sessionId: 'session-1',
      payload: { unit: 'SEGMENT', segments: [], nextCursor: null, source: 'native' }
    });

    await expect(pending).resolves.toBeUndefined();
    await expect(joined).resolves.toBeUndefined();
    expect(completed).toBe(true);
    expect(joinedCompleted).toBe(true);
    const reopened = controller.initializeSelectedSessionWatch('session-1');
    await Promise.resolve();
    const replacementWatchId = JSON.parse(String(requests[1]?.body)).watchId as string;
    expect(replacementWatchId).not.toBe(watchId);
    expect(
      controller.handleEvent({
        type: 'watch.session.snapshot',
        workbenchConnectionId: 'local-test-connection',
        nodeGeneration: 'test-generation',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        watchId,
        payload: { unit: 'SEGMENT', segments: [], nextCursor: null }
      })
    ).toBe(false);
    controller.handleEvent({
      type: 'watch.session.snapshot',
      workbenchConnectionId: 'local-test-connection',
      nodeGeneration: 'test-generation',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      watchId: replacementWatchId,
      payload: { unit: 'SEGMENT', segments: [], nextCursor: null }
    });
    await reopened;
    controller.stopSelectedSessionWatch();
    vi.unstubAllGlobals();
  });

  it('Replays newer live events received during initial snapshot application in sequence order', async () => {
    vi.stubGlobal('document', { visibilityState: 'visible' });
    const requests: RequestInit[] = [];
    const operations: string[] = [];
    const applySnapshot = vi.fn(() => {
      operations.push('snapshot');
      return true;
    });
    const applyEvent = vi.fn((event: { readonly sequence: number }) => {
      operations.push(`event:${event.sequence}`);
    });
    const controller = createWorkbenchSessionWatchController({
      workspaceTarget: workspaceTargetRef(ref('node-1'), ref('workspace-1')),
      selectedSessionId: ref('session-1'),
      sessions: ref([{ id: 'session-1', workspaceId: 'workspace-1', activity: 'IDLE' }] as never),
      followConversation: ref(false),
      heartbeatMs: 15_000,
      requestTimeoutMs: 10_000,
      confirmationTimeoutMs: 45_000,
      request: async (_path, init) => {
        requests.push(init ?? {});
        return { nodeGeneration: 'test-generation' } as never;
      },
      sessionPathId: (value) => value,
      mergeSessions: vi.fn(),
      applySnapshot,
      applyEvent,
      scrollAfterLayout: vi.fn(),
      refreshSnapshot: vi.fn(),
      openSession: vi.fn()
    });

    const initial = controller.initializeSelectedSessionWatch('session-1');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const watchId = JSON.parse(String(requests[0]?.body)).watchId as string;
    const realtime = (sequence: number) => ({
      type: 'watch.session.event',
      workbenchConnectionId: 'local-test-connection',
      nodeGeneration: 'test-generation',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      watchId,
      sessionId: 'session-1',
      event: { sequence, category: 'conversation', payload: { sessionId: 'session-1' } }
    });

    controller.handleEvent(realtime(1));
    controller.handleEvent(realtime(2));
    controller.handleEvent(realtime(3));
    expect(applyEvent).not.toHaveBeenCalled();

    controller.handleEvent({
      type: 'watch.session.snapshot',
      workbenchConnectionId: 'local-test-connection',
      nodeGeneration: 'test-generation',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      watchId,
      sessionId: 'session-1',
      payload: {
        unit: 'SEGMENT',
        segments: [],
        nextCursor: null,
        snapshotSequence: 1,
        source: 'runtime'
      }
    });

    await expect(initial).resolves.toBeUndefined();
    expect(operations).toEqual(['snapshot', 'event:2', 'event:3']);
    controller.stopSelectedSessionWatch();
    vi.unstubAllGlobals();
  });

  it('Replays Conversation events newer than the nested Conversation snapshot boundary', async () => {
    vi.stubGlobal('document', { visibilityState: 'visible' });
    const requests: RequestInit[] = [];
    const applyEvent = vi.fn();
    const controller = createWorkbenchSessionWatchController({
      workspaceTarget: workspaceTargetRef(ref('node-1'), ref('workspace-1')),
      selectedSessionId: ref('session-1'),
      sessions: ref([{ id: 'session-1', workspaceId: 'workspace-1', activity: 'IDLE' }] as never),
      followConversation: ref(false),
      heartbeatMs: 15_000,
      requestTimeoutMs: 10_000,
      confirmationTimeoutMs: 45_000,
      request: async (_path, init) => {
        requests.push(init ?? {});
        return { nodeGeneration: 'test-generation' } as never;
      },
      sessionPathId: (value) => value,
      mergeSessions: vi.fn(),
      applySnapshot: vi.fn(() => true),
      applyEvent,
      scrollAfterLayout: vi.fn(),
      refreshSnapshot: vi.fn(),
      openSession: vi.fn()
    });

    const initial = controller.initializeSelectedSessionWatch('session-1');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const watchId = JSON.parse(String(requests[0]?.body)).watchId as string;
    const turn = {
      id: 'turn-2',
      sessionId: 'session-1',
      runId: 'run-1',
      status: 'RUNNING',
      items: []
    };

    controller.handleEvent({
      type: 'watch.session.event',
      workbenchConnectionId: 'local-test-connection',
      nodeGeneration: 'test-generation',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      watchId,
      sessionId: 'session-1',
      event: { sequence: 2, category: 'conversation', payload: { turn } }
    });
    controller.handleEvent({
      type: 'watch.session.snapshot',
      workbenchConnectionId: 'local-test-connection',
      nodeGeneration: 'test-generation',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      watchId,
      sessionId: 'session-1',
      payload: {
        kind: 'session-watch-snapshot',
        sequence: 3,
        session: { id: 'session-1', workspaceId: 'workspace-1', activity: 'MANAGED_ACTIVE' },
        runs: [{ id: 'run-1', sessionId: 'session-1', status: 'RUNNING' }],
        queue: { version: 1, paused: false, items: [] },
        conversation: {
          unit: 'SEGMENT',
          segments: [],
          nextCursor: null,
          snapshotSequence: 1,
          source: 'runtime'
        }
      }
    });

    await expect(initial).resolves.toBeUndefined();
    expect(applyEvent).toHaveBeenCalledWith({
      nodeId: 'node-1',
      sequence: 2,
      category: 'conversation',
      payload: { turn }
    });
    controller.stopSelectedSessionWatch();
    vi.unstubAllGlobals();
  });

  it('Ignores a duplicate begin for the same session while an explicit initial watch is in flight', async () => {
    vi.stubGlobal('document', { visibilityState: 'visible' });
    const requests: RequestInit[] = [];
    const controller = createWorkbenchSessionWatchController({
      workspaceTarget: workspaceTargetRef(ref('node-1'), ref('workspace-1')),
      selectedSessionId: ref('session-1'),
      sessions: ref([{ id: 'session-1', workspaceId: 'workspace-1', activity: 'IDLE' }] as never),
      followConversation: ref(false),
      heartbeatMs: 15_000,
      requestTimeoutMs: 10_000,
      confirmationTimeoutMs: 45_000,
      request: async (_path, init) => {
        requests.push(init ?? {});
        return { accepted: true } as never;
      },
      sessionPathId: (value) => value,
      mergeSessions: vi.fn(),
      applySnapshot: vi.fn(),
      scrollAfterLayout: vi.fn(),
      refreshSnapshot: vi.fn(),
      openSession: vi.fn()
    });

    const pending = controller.initializeSelectedSessionWatch('session-1');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    controller.beginSelectedSessionWatch('session-1');
    await Promise.resolve();
    expect(requests).toHaveLength(1);

    const watchId = JSON.parse(String(requests[0]?.body)).watchId as string;
    controller.handleEvent({
      type: 'watch.session.snapshot',
      workbenchConnectionId: 'local-test-connection',
      nodeGeneration: 'test-generation',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      watchId,
      sessionId: 'session-1',
      payload: { unit: 'SEGMENT', segments: [], nextCursor: null, source: 'native' }
    });
    await expect(pending).resolves.toBeUndefined();
    controller.stopSelectedSessionWatch();
    vi.unstubAllGlobals();
  });

  it('Ignores a late initial-watch response for the same session after switching Nodes', async () => {
    const selectedNodeId = ref('node-1');
    let resolveRequest!: (value: unknown) => void;
    const mergeSessions = vi.fn();
    const controller = createWorkbenchSessionWatchController({
      workspaceTarget: workspaceTargetRef(selectedNodeId, ref('workspace-1')),
      selectedSessionId: ref('session-1'),
      sessions: ref([{ id: 'session-1', workspaceId: 'workspace-1', activity: 'IDLE' }] as never),
      followConversation: ref(false),
      heartbeatMs: 15_000,
      requestTimeoutMs: 10_000,
      confirmationTimeoutMs: 45_000,
      request: <T>() =>
        new Promise<T>((resolve) => {
          resolveRequest = (value) => resolve(value as T);
        }),
      sessionPathId: (value) => value,
      mergeSessions,
      applySnapshot: vi.fn(),
      scrollAfterLayout: vi.fn(),
      refreshSnapshot: vi.fn(),
      openSession: vi.fn()
    });

    const pending = controller.initializeSelectedSessionWatch('session-1');
    selectedNodeId.value = 'node-2';
    resolveRequest({
      session: { id: 'session-1', activity: 'EXTERNAL_IDLE' },
      watch: { expiresAt: Date.now() + 45_000 }
    });

    await expect(pending).resolves.toBeUndefined();
    expect(mergeSessions).not.toHaveBeenCalled();
    controller.stopSelectedSessionWatch();
  });

  it('Reestablishes an initial Watch for the current session after the connection ID changes', async () => {
    vi.stubGlobal('document', { visibilityState: 'visible' });
    const workbenchConnectionId = ref('connection-1');
    const requests: RequestInit[] = [];
    const controller = createWorkbenchSessionWatchController({
      workspaceTarget: workspaceTargetRef(ref('node-1'), ref('workspace-1')),
      selectedSessionId: ref('session-1'),
      sessions: ref([{ id: 'session-1', workspaceId: 'workspace-1', activity: 'IDLE' }] as never),
      followConversation: ref(false),
      workbenchConnectionId: () => workbenchConnectionId.value,
      heartbeatMs: 15_000,
      requestTimeoutMs: 10_000,
      confirmationTimeoutMs: 45_000,
      request: async (_path, init) => {
        requests.push(init ?? {});
        return { nodeGeneration: 'test-generation' } as never;
      },
      sessionPathId: (value) => value,
      mergeSessions: vi.fn(),
      applySnapshot: vi.fn(),
      scrollAfterLayout: vi.fn(),
      refreshSnapshot: vi.fn(),
      openSession: vi.fn()
    });

    const initial = controller.beginSelectedSessionWatch('session-1');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const firstWatchId = JSON.parse(String(requests[0]?.body)).watchId as string;
    controller.handleEvent({
      type: 'watch.session.snapshot',
      workbenchConnectionId: 'connection-1',
      nodeGeneration: 'test-generation',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      watchId: firstWatchId,
      sessionId: 'session-1',
      payload: { unit: 'SEGMENT', segments: [], nextCursor: null, source: 'native' }
    });
    await initial;

    workbenchConnectionId.value = 'connection-2';
    controller.beginSelectedSessionWatch('session-1');

    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(JSON.parse(String(requests[1]?.body))).toMatchObject({
      workbenchConnectionId: 'connection-2',
      mode: 'initial'
    });
    controller.stopSelectedSessionWatch();
    vi.unstubAllGlobals();
  });

  it('Cancels the in-flight initial watch and immediately creates a new Watch when the connection ID changes', async () => {
    vi.stubGlobal('document', { visibilityState: 'visible' });
    const workbenchConnectionId = ref('connection-1');
    const requests: RequestInit[] = [];
    const resolveRequests: Array<(value: unknown) => void> = [];
    const applySnapshot = vi.fn();
    const controller = createWorkbenchSessionWatchController({
      workspaceTarget: workspaceTargetRef(ref('node-1'), ref('workspace-1')),
      selectedSessionId: ref('session-1'),
      sessions: ref([{ id: 'session-1', workspaceId: 'workspace-1', activity: 'IDLE' }] as never),
      followConversation: ref(false),
      workbenchConnectionId: () => workbenchConnectionId.value,
      heartbeatMs: 15_000,
      requestTimeoutMs: 10_000,
      confirmationTimeoutMs: 45_000,
      request: <T>(_path: string, init?: RequestInit) => {
        requests.push(init ?? {});
        return new Promise<T>((resolve) => resolveRequests.push((value) => resolve(value as T)));
      },
      sessionPathId: (value) => value,
      mergeSessions: vi.fn(),
      applySnapshot,
      scrollAfterLayout: vi.fn(),
      refreshSnapshot: vi.fn(),
      openSession: vi.fn()
    });

    const firstInitial = controller.beginSelectedSessionWatch('session-1')?.catch((error) => error);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(controller.hasInitialSessionSnapshot('session-1')).toBe(false);
    const firstWatchId = JSON.parse(String(requests[0]?.body)).watchId as string;

    workbenchConnectionId.value = 'connection-2';
    const replacementInitial = controller.beginSelectedSessionWatch('session-1');
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(controller.hasInitialSessionSnapshot('session-1')).toBe(false);
    const secondWatchId = JSON.parse(String(requests[1]?.body)).watchId as string;

    expect(
      controller.handleEvent({
        type: 'watch.session.snapshot',
        workbenchConnectionId: 'connection-1',
        nodeGeneration: 'test-generation',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        watchId: firstWatchId,
        sessionId: 'session-1',
        payload: { unit: 'SEGMENT', segments: [], nextCursor: null, source: 'native' }
      })
    ).toBe(false);
    expect(controller.hasInitialSessionSnapshot('session-1')).toBe(false);
    resolveRequests[1]?.({ nodeGeneration: 'test-generation' });
    await Promise.resolve();
    expect(controller.hasInitialSessionSnapshot('session-1')).toBe(false);
    controller.handleEvent({
      type: 'watch.session.snapshot',
      workbenchConnectionId: 'connection-2',
      nodeGeneration: 'test-generation',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      watchId: secondWatchId,
      sessionId: 'session-1',
      payload: { unit: 'SEGMENT', segments: [], nextCursor: null, source: 'native' }
    });
    expect(controller.hasInitialSessionSnapshot('session-1')).toBe(true);
    resolveRequests[0]?.({ nodeGeneration: 'test-generation' });

    expect(await firstInitial).toMatchObject({ code: 'WATCH_CANCELLED' });
    await replacementInitial;
    expect(applySnapshot).toHaveBeenCalledOnce();
    expect(controller.hasInitialSessionSnapshot('session-1')).toBe(true);
    controller.stopSelectedSessionWatch();
    vi.unstubAllGlobals();
  });
});

describe('Session Watch failure phases', () => {
  it.each(['request-timeout', 'snapshot-timeout', 'cancel-request', 'cancel-snapshot'] as const)(
    'handles %s at the shared lifecycle boundary',
    async (mode) => {
      vi.useFakeTimers();
      vi.stubGlobal('document', { visibilityState: 'visible' });
      const acknowledged = mode.endsWith('snapshot') || mode === 'snapshot-timeout';
      const request = vi.fn(async (_path: string, init?: RequestInit) => {
        if (init?.method === 'DELETE' || acknowledged)
          return { nodeGeneration: 'generation' } as never;
        return await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true
          });
        });
      });
      const refreshSnapshot = vi.fn();
      const controller = createWorkbenchSessionWatchController({
        workspaceTarget: workspaceTargetRef(ref('node-1'), ref('workspace-1')),
        selectedSessionId: ref('session-1'),
        sessions: ref([{ id: 'session-1', workspaceId: 'workspace-1', activity: 'IDLE' }] as never),
        followConversation: ref(false),
        heartbeatMs: 15_000,
        requestTimeoutMs: 10_000,
        confirmationTimeoutMs: 45_000,
        request,
        sessionPathId: (value) => value,
        mergeSessions: vi.fn(),
        applySnapshot: vi.fn(),
        scrollAfterLayout: vi.fn(),
        refreshSnapshot,
        openSession: vi.fn()
      });
      try {
        const result = controller.initializeSelectedSessionWatch('session-1').then(
          () => undefined,
          (error: unknown) => error
        );
        await Promise.resolve();
        if (mode.startsWith('cancel')) controller.stopSelectedSessionWatch();
        else await vi.advanceTimersByTimeAsync(10_000);
        if (mode.startsWith('cancel'))
          expect(await result).toMatchObject({ code: 'WATCH_CANCELLED' });
        else
          expect(await result).toMatchObject({
            code: acknowledged ? 'SESSION_WATCH_SNAPSHOT_TIMEOUT' : 'WATCH_REQUEST_TIMEOUT'
          });
        const count = request.mock.calls.length;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(request).toHaveBeenCalledTimes(count);
        expect(refreshSnapshot).not.toHaveBeenCalled();
      } finally {
        controller.stopSelectedSessionWatch();
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    }
  );
});
