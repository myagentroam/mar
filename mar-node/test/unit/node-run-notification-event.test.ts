import { describe, expect, it, vi } from 'vitest';
import { NodeMetrics } from '../../src/operational.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { RunDomainState } from '../../src/service/run-domain-state.js';
import { RunEventService } from '../../src/service/run-event-service.js';
import { NativeSessionWatchService } from '../../src/service/native-session-watch-service.js';
import { NodeRunEventBridge } from '../../src/service/node-run-event-bridge.js';
import { conversationSegments } from '../../src/service/conversation-segment-service.js';

function fixture(keepRunActive: (sessionId: string) => boolean = () => false) {
  let now = 100;
  const runtime = new NodeRuntimeState(
    () => 'node-1',
    (id) =>
      id === 'workspace-1'
        ? { id, path: '/workspace', kind: 'DIRECTORY', gitSummary: null }
        : undefined,
    () => now++
  );
  const state = new RunDomainState();
  const events: Array<{ category: string; payload: unknown }> = [];
  const dispatchQueue = vi.fn(async () => undefined);
  const refreshWorkspaceSessions = vi.fn(async (): Promise<void> => {});
  const service = new RunEventService({
    runtime,
    state,
    metrics: new NodeMetrics(),
    isBootstrapSession: () => false,
    presentSession: (session) => session,
    rejectBootstrap: vi.fn(),
    emitWorkbench: (category, payload) => events.push({ category, payload }),
    cleanupAttachments: vi.fn(),
    expireImages: vi.fn(),
    scheduleContextRefresh: vi.fn(),
    refreshWorkspaceSessions,
    dispatchQueue,
    keepRunActive,
    releaseExecution: vi.fn()
  });
  const createRun = (
    clientMessageId: string,
    sessionId?: string,
    suppressNotifications = false
  ) => {
    const session =
      sessionId === undefined
        ? runtime.createAgentSession({
            workspaceId: 'workspace-1',
            runner: 'codex',
            cwd: '/workspace',
            title: 'notification test'
          })
        : runtime.getAgentSession(sessionId)!;
    return runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId,
      content: 'test',
      suppressNotifications,
      initiatedByUserId: 7
    }).run;
  };
  const notifications = () =>
    events
      .filter((item) => item.category === 'conversation')
      .map((item) => (item.payload as { event?: { eventType?: string; payload?: unknown } }).event)
      .filter((event) => event?.eventType === 'notification');
  const startExecution = (runId: string) => {
    const execution = runtime.createExecution(runId);
    state.active.add(execution.id);
    return execution;
  };
  return {
    runtime,
    state,
    service,
    createRun,
    startExecution,
    notifications,
    events,
    dispatchQueue,
    refreshWorkspaceSessions
  };
}

describe('Node Run notification attachment events', () => {
  it('restores terminal notifications when manual FIFO input takes over a delegated Run', async () => {
    const { runtime, service, createRun, startExecution, notifications } = fixture();
    const run = createRun('delegated', undefined, true);
    runtime.createQueueItem({
      sessionId: run.sessionId,
      clientMessageId: 'manual',
      initiatedByUserId: 7,
      content: 'Continue with my changes'
    });
    expect(runtime.claimNextQueueItem(run.sessionId)).toBeDefined();
    const execution = startExecution(run.id);
    service.emit(execution.id, 'run.completed', {}, 'SUCCEEDED');
    await vi.waitFor(() => expect(notifications()).toHaveLength(1));
    expect(notifications()[0]?.payload).toMatchObject({
      kind: 'RUN_TERMINAL',
      runId: run.id,
      outcome: 'SUCCEEDED'
    });
  });

  it.each(['SUCCEEDED', 'FAILED', 'INTERRUPTED'] as const)(
    'suppresses automatic marctl notifications without hiding interaction or %s state',
    async (status) => {
      const { runtime, service, createRun, startExecution, notifications, events } = fixture();
      const run = createRun('marctl-message', undefined, true);
      const execution = startExecution(run.id);
      service.emit(execution.id, 'approval.request', { approvalId: 'approval-1' });
      service.emit(execution.id, 'conversation.item', { itemId: 'plan-1', kind: 'plan' });
      service.emit(execution.id, 'conversation.item', {
        itemId: 'input-1',
        kind: 'user_input_request',
        payload: { questions: [{ id: 'question-1' }] }
      });
      expect(events.some((item) => item.category === 'conversation')).toBe(true);
      service.emit(execution.id, status === 'FAILED' ? 'run.failed' : 'run.completed', {}, status);
      await vi.waitFor(() => expect(runtime.getRun(run.id)).toBeUndefined());
      expect(notifications()).toEqual([]);
      expect(runtime.activeSessionRun(run.sessionId)).toBeUndefined();
    }
  );

  it('pauses queued work and settles a permission stop even while a Goal is active', async () => {
    const { runtime, service, createRun, startExecution, dispatchQueue, notifications } = fixture(
      () => true
    );
    const run = createRun('auto-stop');
    const execution = startExecution(run.id);
    const permissionStop = {
      action: 'ask',
      reason: 'Confirm the shared target.',
      source: {
        sessionId: run.sessionId,
        executionId: execution.id,
        callId: 'call',
        toolName: 'exec'
      }
    };
    service.emit(execution.id, 'run.completed', { permissionStop }, 'INTERRUPTED');
    expect(runtime.sessionQueue(run.sessionId).paused).toBe(true);
    expect(runtime.activeSessionRun(run.sessionId)).toBeUndefined();
    expect(dispatchQueue).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(notifications()).toHaveLength(1));
    expect(notifications()).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ outcome: 'INTERRUPTED' }) })
    ]);
  });
  it('never buffers performance while a Session Watch snapshot is pending', () => {
    const pending = { sessionId: 'session', ready: false, pendingEvents: [] };
    const ready = { sessionId: 'session', ready: true, pendingEvents: [] };
    const emit = vi.fn();
    const watch = Object.assign(Object.create(NativeSessionWatchService.prototype), {
      watches: new Map(),
      leases: new Map([
        ['pending', pending],
        ['ready', ready]
      ]),
      emitLeaseEvent: emit
    }) as NativeSessionWatchService;
    const event = {
      sequence: 1,
      category: 'conversation' as const,
      payload: { sessionId: 'session', performance: { runId: 'run', latencyMs: 420 } }
    };
    expect(watch.emitRealtime('session', event)).toBe(true);
    expect(pending.pendingEvents).toEqual([]);
    expect(ready.pendingEvents).toEqual([]);
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(ready, event);
  });

  it('pushes performance once without recording Run events, items, or replayable history', () => {
    const { runtime, service, createRun, startExecution, events } = fixture();
    const run = createRun('performance-message');
    const execution = startExecution(run.id);
    const append = vi.spyOn(runtime, 'appendRunEvent');
    const original = runtime.listConversationTurns({ sessionId: run.sessionId });
    service.emit(execution.id, 'run.performance', {
      latencyMs: 420,
      tokensPerSecond: 42,
      outputTokens: 84,
      itemId: 'ignored'
    });
    expect(events).toEqual([
      {
        category: 'conversation',
        payload: {
          sessionId: run.sessionId,
          performance: { runId: run.id, latencyMs: 420, tokensPerSecond: 42 }
        }
      }
    ]);
    expect(append).not.toHaveBeenCalled();
    expect(runtime.lastRunSequence(run.id)).toBe(0);
    expect(runtime.listConversationTurns({ sessionId: run.sessionId })).toEqual(original);
    expect(runtime.sessionPerformance(run.sessionId)).toEqual({
      runId: run.id,
      latencyMs: 420,
      tokensPerSecond: 42
    });
    service.clear();
  });

  it('replaces active Run metrics, isolates sessions, and clears at every terminal status', () => {
    for (const status of ['SUCCEEDED', 'FAILED', 'INTERRUPTED'] as const) {
      const { runtime, service, createRun, startExecution, events } = fixture();
      const run = createRun(`performance-${status}`);
      const other = createRun(`other-${status}`);
      const execution = startExecution(run.id);
      service.emit(execution.id, 'run.performance', { latencyMs: 420, tokensPerSecond: 42 });
      service.emit(execution.id, 'run.performance', { latencyMs: 80, tokensPerSecond: undefined });
      expect(runtime.sessionPerformance(run.sessionId)).toEqual({
        runId: run.id,
        latencyMs: 80,
        tokensPerSecond: 42
      });
      service.emit(execution.id, 'run.performance', { tokensPerSecond: 0 });
      expect(runtime.sessionPerformance(run.sessionId)).toEqual({
        runId: run.id,
        latencyMs: 80,
        tokensPerSecond: 0
      });
      expect(runtime.sessionPerformance(other.sessionId)).toBeUndefined();
      const copy = runtime.sessionPerformance(run.sessionId)!;
      copy.latencyMs = 999;
      expect(runtime.sessionPerformance(run.sessionId)?.latencyMs).toBe(80);
      runtime.finishRun(run.id, status);
      expect(runtime.sessionPerformance(run.sessionId)).toBeUndefined();
      const count = events.length;
      service.emit(execution.id, 'run.performance', { latencyMs: 999 });
      expect(events).toHaveLength(count);
      runtime.removeTerminalRun(run.id);
      service.emit(execution.id, 'run.performance', { latencyMs: 999 });
      expect(events).toHaveLength(count);
      service.clear();
    }
  });

  it('rejects a completed Execution callback while a continuous Run remains active', () => {
    const { runtime, service, createRun, startExecution, events } = fixture(() => true);
    const run = createRun('continuing-performance');
    const execution = startExecution(run.id);
    service.emit(execution.id, 'run.performance', { latencyMs: 100 });
    service.emit(execution.id, 'run.completed', {}, 'SUCCEEDED');
    expect(runtime.sessionPerformance(run.sessionId)).toEqual({ runId: run.id, latencyMs: 100 });
    const count = events.length;
    service.emit(execution.id, 'run.performance', { latencyMs: 999 });
    expect(events).toHaveLength(count);
    expect(runtime.sessionPerformance(run.sessionId)?.latencyMs).toBe(100);
    runtime.finishRun(run.id, 'SUCCEEDED');
    expect(runtime.sessionPerformance(run.sessionId)).toBeUndefined();
    service.clear();
  });

  it('flushes the latest coalesced text before its performance update', () => {
    vi.useFakeTimers();
    try {
      const { service, createRun, startExecution, events } = fixture();
      const run = createRun('live-performance-message');
      const execution = startExecution(run.id);
      service.emit(execution.id, 'text.delta', {
        itemId: 'mar-agent-message:answer',
        text: 'Latest output'
      });
      expect(events).toEqual([]);

      service.emit(execution.id, 'run.performance', {
        latencyMs: 420,
        tokensPerSecond: 42
      });

      expect(events).toEqual([
        {
          category: 'conversation',
          payload: {
            event: expect.objectContaining({
              eventType: 'text.delta',
              payload: {
                itemId: 'mar-agent-message:answer',
                text: 'Latest output'
              }
            })
          }
        },
        {
          category: 'conversation',
          payload: {
            sessionId: run.sessionId,
            performance: { runId: run.id, latencyMs: 420, tokensPerSecond: 42 }
          }
        }
      ]);
      service.clear();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops empty, malformed, or stale performance without emitting a cached fallback', () => {
    const { service, createRun, startExecution, events } = fixture();
    const execution = startExecution(createRun('invalid-performance').id);
    for (const payload of [
      null,
      {},
      { latencyMs: -1 },
      { ttftMs: 420 },
      { tokensPerSecond: Infinity }
    ])
      service.emit(execution.id, 'run.performance', payload);
    service.emit('missing-run', 'run.performance', { latencyMs: 420 });
    expect(events).toEqual([]);
    service.clear();
  });

  it('logs the stable error code for rejected Runs without logging the error payload', () => {
    const { service, createRun, startExecution } = fixture();
    const run = createRun('rejected-message');
    const execution = startExecution(run.id);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let logged: string | undefined;

    try {
      service.emit(
        execution.id,
        'run.rejected',
        { code: 'CODEX_SECRET_ENVIRONMENT_CONFLICT', details: 'private detail' },
        'FAILED'
      );
      logged = write.mock.calls
        .map(([value]) => String(value))
        .find((value) => value.includes('"event":"run.event"'));
    } finally {
      write.mockRestore();
    }

    expect(logged).toContain('"errorCode":"CODEX_SECRET_ENVIRONMENT_CONFLICT"');
    expect(logged).not.toContain('private detail');
  });

  it('does not resend an already completed Agent item as a terminal Turn', () => {
    const { runtime, service, createRun, startExecution, events } = fixture();
    const run = createRun('completed-message');
    const execution = startExecution(run.id);
    service.emit(execution.id, 'conversation.item', {
      itemId: 'mar-agent-message:reply',
      kind: 'assistant_message',
      status: 'COMPLETED',
      payload: { text: 'Final reply' }
    });
    events.length = 0;
    service.emit(execution.id, 'run.completed', {}, 'SUCCEEDED');

    expect(runtime.conversationTurnForRun(run.id)?.status).toBe('SUCCEEDED');
    expect(events.filter((event) => event.category === 'conversation')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          event: expect.objectContaining({ eventType: 'run.completed' })
        })
      })
    ]);
  });

  it('does not settle a continuous Run early while waiting for Goal continuation retry', () => {
    const { runtime, service, createRun, startExecution, dispatchQueue } = fixture(() => true);
    const run = createRun('goal-retry');
    const execution = startExecution(run.id);

    service.emit(execution.id, 'run.completed', {}, 'SUCCEEDED');

    expect(runtime.getRun(run.id)).toMatchObject({ status: 'STARTING', completedAt: null });
    expect(runtime.conversationTurnForRun(run.id)?.status).toBe('SUCCEEDED');
    expect(dispatchQueue).toHaveBeenCalledWith(run.sessionId, 0);
  });

  it('includes complete location data in terminal events without affecting the final Turn projection', async () => {
    const {
      runtime,
      service,
      createRun,
      startExecution,
      notifications,
      events,
      refreshWorkspaceSessions
    } = fixture();
    const run = createRun('message-1');
    const execution = startExecution(run.id);
    runtime.appendRunEvent({
      runId: execution.id,
      sequence: 1,
      eventType: 'text.delta',
      payload: { text: 'event before service recovery' }
    });
    service.emit(execution.id, 'run.completed', {}, 'SUCCEEDED');
    await vi.waitFor(() => expect(notifications()).toHaveLength(1));

    expect(notifications()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          notificationId: `run:workspace-1:${run.id}`,
          targetType: 'WORKSPACE_SESSION',
          userId: 7,
          kind: 'RUN_TERMINAL',
          workspaceId: 'workspace-1',
          sessionId: run.sessionId,
          sessionTitle: 'notification test',
          runId: run.id,
          outcome: 'SUCCEEDED',
          occurredAt: expect.any(Number)
        })
      })
    ]);
    expect(runtime.getRun(run.id)).toBeUndefined();
    expect(runtime.lastRunSequence(run.id)).toBe(0);
    expect(runtime.conversationTurnForRun(run.id)?.status).toBe('SUCCEEDED');
    expect(events).toContainEqual({
      category: 'conversation',
      payload: expect.objectContaining({
        turn: expect.objectContaining({ id: runtime.conversationTurnForRun(run.id)?.id })
      })
    });
    expect(refreshWorkspaceSessions).toHaveBeenCalledOnce();
    expect(refreshWorkspaceSessions).toHaveBeenCalledWith('workspace-1');
    const eventCount = events.length;
    service.emit(run.id, 'text.delta', { text: 'late' });
    expect(events).toHaveLength(eventCount);
  });

  it('publishes terminal notification only after the IDLE session snapshot refresh completes', async () => {
    const { runtime, service, createRun, startExecution, notifications, refreshWorkspaceSessions } =
      fixture();
    const run = createRun('message-1');
    const execution = startExecution(run.id);
    let releaseSnapshot!: () => void;
    const snapshot = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    refreshWorkspaceSessions.mockImplementationOnce(() => snapshot);

    service.emit(execution.id, 'run.completed', {}, 'SUCCEEDED');

    expect(runtime.activeSessionRun(run.sessionId)).toBeUndefined();
    expect(refreshWorkspaceSessions).toHaveBeenCalledWith('workspace-1');
    expect(notifications()).toEqual([]);

    releaseSnapshot();
    await snapshot;
    await Promise.resolve();

    expect(notifications()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ kind: 'RUN_TERMINAL', outcome: 'SUCCEEDED' })
      })
    ]);
  });

  it('continues the same Run after an intermediate queue success without creating a terminal notification for an intentional interruption', () => {
    const { runtime, state, service, createRun, startExecution, notifications } = fixture();
    const first = createRun('message-1');
    const firstExecution = startExecution(first.id);
    runtime.createQueueItem({
      sessionId: first.sessionId,
      clientMessageId: 'message-2',
      content: 'continue',
      initiatedByUserId: 7
    });
    service.emit(firstExecution.id, 'run.completed', {}, 'SUCCEEDED');
    expect(runtime.activeSessionRun(first.sessionId)?.id).toBe(first.id);

    const interrupted = createRun('message-3');
    const interruptedExecution = startExecution(interrupted.id);
    state.interruptRequested.add(interruptedExecution.id);
    service.emit(interruptedExecution.id, 'run.completed', {}, 'INTERRUPTED');

    expect(notifications()).toEqual([]);
  });

  it('continues after an intermediate queue failure with a 15-second backoff', () => {
    const { runtime, service, createRun, startExecution, dispatchQueue } = fixture();
    const run = createRun('message-1');
    const execution = startExecution(run.id);
    runtime.createQueueItem({
      sessionId: run.sessionId,
      clientMessageId: 'message-2',
      content: 'continue',
      initiatedByUserId: 7
    });

    service.emit(execution.id, 'run.failed', { code: 'TEST_FAILURE' }, 'FAILED');

    expect(dispatchQueue).toHaveBeenCalledWith(run.sessionId, 15_000);
  });

  it('shows a late event only in its owning Turn without contaminating the current Turn', () => {
    const { runtime, service, createRun, startExecution, events } = fixture();
    const run = createRun('message-1');
    const firstExecution = startExecution(run.id);
    const firstTurnId = runtime.conversationTurnForExecution(firstExecution.id)?.id;
    runtime.createQueueItem({
      sessionId: run.sessionId,
      clientMessageId: 'message-2',
      content: 'continue',
      initiatedByUserId: 7
    });
    service.emit(firstExecution.id, 'run.completed', {}, 'SUCCEEDED');
    runtime.claimNextQueueItem(run.sessionId);
    const currentExecution = runtime.createExecution(run.id);
    const currentTurnId = runtime.conversationTurnForExecution(currentExecution.id)?.id;
    const eventCount = events.length;

    service.emit(firstExecution.id, 'conversation.item', {
      itemId: 'late-assistant',
      kind: 'assistant_message',
      status: 'COMPLETED',
      payload: { text: 'late content' }
    });

    const emitted = events.slice(eventCount).filter((event) => event.category === 'conversation');
    expect(firstTurnId).toBeDefined();
    expect(currentTurnId).toBeDefined();
    expect(firstTurnId).not.toBe(currentTurnId);
    expect(emitted).toEqual([
      {
        category: 'conversation',
        payload: expect.objectContaining({ turn: expect.objectContaining({ id: firstTurnId }) })
      }
    ]);
    expect(emitted[0]?.payload).not.toHaveProperty('event');
    expect(runtime.conversationTurnForExecution(currentExecution.id)?.items).toHaveLength(1);
  });

  it.each(['FAILED', 'INTERRUPTED'] as const)(
    '%s Run enters Idle and settles the current Turn',
    (status) => {
      const { runtime, service, createRun, startExecution } = fixture();
      const run = createRun(`message-${status}`);
      const execution = startExecution(run.id);

      service.emit(execution.id, status === 'FAILED' ? 'run.failed' : 'run.completed', {}, status);

      const turn = runtime.conversationTurnForRun(run.id);
      if (status === 'INTERRUPTED') expect(turn?.status).toBe('INTERRUPTED');
      else expect(turn).toBeUndefined();
      expect(runtime.activeSessionRun(run.sessionId)).toBeUndefined();
    }
  );

  it('creates notification events consistently for approvals, Plan, and pending answers', () => {
    const { service, createRun, startExecution, notifications, events } = fixture();
    const run = createRun('message-1');
    const execution = startExecution(run.id);
    service.emit(execution.id, 'approval.request', { approvalId: 'approval-1' });
    service.emit(execution.id, 'conversation.item', { itemId: 'plan-1', kind: 'plan' });
    service.emit(execution.id, 'conversation.item', {
      itemId: 'input-1',
      kind: 'user_input_request',
      payload: { questions: [{ id: 'question-1' }] }
    });
    service.emit(execution.id, 'approval.decided', { approvalId: 'approval-1' });

    expect(notifications().map((event) => event?.payload)).toEqual([
      expect.objectContaining({
        kind: 'APPROVAL_REQUIRED',
        notificationId: `approval:workspace-1:${run.id}:approval-1`
      }),
      expect.objectContaining({
        kind: 'PLAN_READY',
        notificationId: `plan:workspace-1:${run.id}:plan-1`
      }),
      expect.objectContaining({
        kind: 'USER_INPUT_REQUIRED',
        notificationId: `user-input:workspace-1:${run.id}:input-1`
      })
    ]);
    expect(
      events.some(
        (item) =>
          item.category === 'conversation' &&
          (item.payload as { event?: { eventType?: string } }).event?.eventType === 'notification'
      )
    ).toBe(true);
  });
});

describe('Run callback Segment projection', () => {
  it('normalizes terminal and late Execution Turns at the same public boundary', () => {
    const h = fixture(() => true);
    const bridge = new NodeRunEventBridge({ runtime: h.runtime } as never);
    const run = h.createRun('first-message');
    const first = h.startExecution(run.id);
    h.service.emit(first.id, 'run.running', {}, 'RUNNING');
    const initial = h.runtime.conversationTurnForRun(run.id)!;
    const started = h.events.find((event) => event.category === 'conversation')!;
    expect(bridge.projectWorkbenchPayload('conversation', started.payload)).toMatchObject({
      segments: conversationSegments(initial)
    });
    h.service.emit(first.id, 'run.completed', {}, 'SUCCEEDED');
    const terminal = h.events
      .filter((event) => event.category === 'conversation' && 'turn' in (event.payload as object))
      .at(-1)!;
    const completed = h.runtime.conversationTurnForRun(run.id)!;
    expect(bridge.projectWorkbenchPayload('conversation', terminal.payload)).toMatchObject({
      segments: conversationSegments(completed)
    });
    h.runtime.createQueueItem({
      sessionId: run.sessionId,
      clientMessageId: 'second-message',
      content: 'next',
      initiatedByUserId: 7
    });
    h.runtime.claimNextQueueItem(run.sessionId);
    h.startExecution(run.id);
    h.service.emit(first.id, 'conversation.item', {
      itemId: 'late-tool',
      kind: 'tool_call',
      status: 'COMPLETED',
      payload: { name: 'late' }
    });
    const late = h.events.filter((event) => event.category === 'conversation').at(-1)!;
    const oldTurn = h.runtime.conversationTurnForExecution(first.id)!;
    expect(bridge.projectWorkbenchPayload('conversation', late.payload)).toMatchObject({
      turn: { id: initial.id },
      segments: conversationSegments(oldTurn)
    });
    expect(oldTurn.id).not.toBe(h.runtime.conversationTurnForRun(run.id)!.id);
  });

  it('derives Segments from the Turn rather than trusting caller-supplied Segments', () => {
    const h = fixture();
    const run = h.createRun('message');
    const turn = h.runtime.conversationTurnForRun(run.id)!;
    const bridge = new NodeRunEventBridge({ runtime: h.runtime } as never);
    expect(bridge.projectWorkbenchPayload('conversation', { turn, segments: [] })).toMatchObject({
      segments: conversationSegments(turn)
    });
  });
});
