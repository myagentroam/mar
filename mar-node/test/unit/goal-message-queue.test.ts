import { describe, expect, it, vi } from 'vitest';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { WorkspaceQueueWorkbenchService } from '../../src/workspace/workspace-queue-workbench-service.js';
import {
  ContinuousRunCoordinator,
  type PreparedExecutionInput
} from '../../src/service/continuous-run-coordinator.js';

function fixture() {
  const runtime = new NodeRuntimeState(
    () => 'node-goal-queue',
    () => ({
      id: 'workspace-goal-queue',
      path: '/workspace',
      kind: 'DIRECTORY',
      gitSummary: null,
      createdAt: 1,
      updatedAt: 1
    })
  );
  const session = runtime.createAgentSession({
    workspaceId: 'workspace-goal-queue',
    runner: 'mar-agent',
    cwd: '/workspace'
  });
  let active = true;
  const control = vi.fn();
  const emitQueue = vi.fn();
  const coordinator = new ContinuousRunCoordinator({
    executionTerminating: () => undefined,
    keepRunActive: () => false,
    runtime,
    emitQueue,
    emitConversation: vi.fn(),
    clearImages: vi.fn(),
    cleanupAttachments: vi.fn(),
    migrateAssets: vi.fn(),
    emitRun: vi.fn(),
    control,
    stopped: () => false,
    markInterrupted: vi.fn(),
    mcps: () => [],
    goalActive: () => active
  });
  const initial = coordinator.accept({
    runId: 'initial-goal',
    sessionId: session.id,
    clientMessageId: 'initial-goal',
    content: 'Goal Start'
  }).run;
  const enqueue = (id: string, goal = false) => {
    const queueBefore = runtime.sessionQueue(session.id);
    const accepted = coordinator.accept({
      runId: id,
      sessionId: session.id,
      clientMessageId: id,
      content: id,
      ...(goal ? { goalInput: true as const } : {})
    });
    const input: PreparedExecutionInput = {
      runId: id,
      sessionId: session.id,
      workspaceId: session.workspaceId,
      executionContext: { runner: 'mar-agent' },
      input: id,
      attachments: [],
      attachmentPaths: [],
      cwd: '/workspace',
      externalSessionId: null,
      modelId: null,
      effort: null,
      access: null,
      collaborationMode: 'default',
      secretEnvironment: {},
      ...(goal ? { goal: { id: 'goal-1', revision: 1, epoch: 0 } } : {})
    };
    coordinator.prepare(accepted.queueItem!.id, input);
    return coordinator.settle({ submissionId: id, intent: 'SEND', queueBefore });
  };
  let sequence = 0;
  const finish = () => {
    const run = runtime.activeSessionRun(session.id)!;
    const executionId = runtime.currentExecutionId(run.id)!;
    runtime.appendRunEvent({
      runId: executionId,
      sequence: ++sequence,
      eventType: 'run.completed',
      payload: {},
      status: 'SUCCEEDED'
    });
    coordinator.remove(executionId);
  };
  return {
    runtime,
    session,
    initial,
    coordinator,
    control,
    emitQueue,
    enqueue,
    finish,
    exit: () => {
      active = false;
    }
  };
}

describe('Goal message queue scheduling', () => {
  it('preserves Goal priority and drains ordinary messages in their public reorder after Goal exit', async () => {
    const f = fixture();
    try {
      f.enqueue('ordinary-first');
      f.enqueue('goal:continuation', true);
      f.enqueue('ordinary-second');
      const service = new WorkspaceQueueWorkbenchService({
        runtime: f.runtime,
        resolve: async (id) => f.runtime.getAgentSession(id),
        coordinator: f.coordinator,
        emit: f.emitQueue,
        prepareInput: (_runner, input) => input
      });
      const snapshot = service.snapshot(f.session.id) as {
        version: number;
        items: { queueItemId: string }[];
      };
      expect(snapshot.items.map((item) => item.queueItemId)).toEqual([
        'ordinary-first',
        'ordinary-second'
      ]);
      service.operations()['workspace.queue.reorder']!({
        workspaceId: f.session.workspaceId,
        sessionId: f.session.id,
        expectedVersion: snapshot.version,
        queueItemIds: snapshot.items.map((item) => item.queueItemId).reverse()
      });
      await f.coordinator.dispatch(f.session.id);
      expect(f.control).toHaveBeenLastCalledWith(
        'run.start',
        expect.objectContaining({ input: 'goal:continuation' })
      );
      expect(f.runtime.sessionQueue(f.session.id).itemIds).toEqual([
        'ordinary-second',
        'ordinary-first'
      ]);
      f.finish();
      f.exit();
      await f.coordinator.dispatch(f.session.id);
      expect(f.control).toHaveBeenLastCalledWith(
        'run.start',
        expect.objectContaining({ input: 'ordinary-second' })
      );
      expect(f.runtime.sessionQueue(f.session.id).itemIds).toEqual(['ordinary-first']);
    } finally {
      f.coordinator.clear();
    }
  });

  it('does not let an ordinary send at Goal exit overtake existing FIFO messages', async () => {
    const f = fixture();
    try {
      f.enqueue('goal-continuation', true);
      await f.coordinator.dispatch(f.session.id);
      f.enqueue('ordinary-first');
      f.finish();
      f.exit();
      expect(f.enqueue('ordinary-after-exit')).toBe('QUEUED');
      await f.coordinator.dispatch(f.session.id);
      expect(f.control).toHaveBeenLastCalledWith(
        'run.start',
        expect.objectContaining({ input: 'ordinary-first' })
      );
      expect(f.runtime.sessionQueue(f.session.id).itemIds).toEqual(['ordinary-after-exit']);
    } finally {
      f.coordinator.clear();
    }
  });

  it.each(['execute', 'replace'] as const)(
    'publishes explicit handoff priority and bypasses a pending failed-turn retry delay (%s)',
    async (intent) => {
      vi.useFakeTimers();
      const f = fixture();
      try {
        f.enqueue('ordinary-first');
        f.enqueue('ordinary-immediate');
        f.enqueue('goal-continuation', true);
        await f.coordinator.dispatch(f.session.id);
        f.coordinator.executionStarted(f.runtime.currentExecutionId(f.initial.id)!);
        f.enqueue('goal-next', true);
        f.finish();
        f.coordinator.schedule(f.session.id, 15_000);
        f.emitQueue.mockClear();

        if (intent === 'execute') f.coordinator.executeQueueItem('ordinary-immediate');
        else
          f.coordinator.settle({
            submissionId: 'ordinary-immediate',
            intent: 'REPLACE_CURRENT',
            activeRunId: f.initial.id,
            queueBefore: f.runtime.sessionQueue(f.session.id)
          });

        expect(f.emitQueue).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.control).toHaveBeenLastCalledWith(
          'run.start',
          expect.objectContaining({ input: 'ordinary-immediate' })
        );
        expect(f.runtime.sessionQueue(f.session.id).itemIds).toEqual([
          'ordinary-first',
          'goal-next'
        ]);
      } finally {
        f.coordinator.clear();
        vi.useRealTimers();
      }
    }
  );

  it.each(['active', 'idle'] as const)(
    'holds ordinary messages during continuation preparation and retry gaps (%s Run)',
    async (mode) => {
      const f = fixture();
      try {
        expect(f.enqueue('ordinary-first')).toBe('QUEUED');
        expect(f.enqueue('ordinary-second')).toBe('QUEUED');
        if (mode === 'idle') f.runtime.finishRun(f.initial.id, 'SUCCEEDED');
        f.coordinator.resume(f.session.id);
        await f.coordinator.dispatch(f.session.id);
        expect(f.control).not.toHaveBeenCalled();
        expect(f.runtime.sessionQueue(f.session.id).itemIds).toEqual([
          'ordinary-first',
          'ordinary-second'
        ]);

        f.exit();
        f.coordinator.resume(f.session.id);
        await f.coordinator.dispatch(f.session.id);
        expect(f.control).toHaveBeenCalledWith(
          'run.start',
          expect.objectContaining({
            input: 'ordinary-first'
          })
        );
        expect(f.runtime.sessionQueue(f.session.id).itemIds).toEqual(['ordinary-second']);
      } finally {
        f.coordinator.clear();
      }
    }
  );

  it.each(['execution', 'handoff'] as const)(
    'executes an explicitly selected message before Goal continuation without releasing the rest (%s)',
    async (boundary) => {
      const f = fixture();
      try {
        f.enqueue('ordinary-first');
        f.enqueue('ordinary-immediate');
        f.enqueue('goal-continuation', true);
        await f.coordinator.dispatch(f.session.id);
        expect(f.control).toHaveBeenLastCalledWith(
          'run.start',
          expect.objectContaining({
            input: 'goal-continuation'
          })
        );
        f.coordinator.executionStarted(f.runtime.currentExecutionId(f.initial.id)!);
        f.enqueue('goal-next', true);
        if (boundary === 'handoff') f.finish();
        expect((await f.coordinator.executeQueueItem('ordinary-immediate')).delivery).toBe(
          'ACCEPTED'
        );
        if (boundary === 'execution') {
          expect(f.control).toHaveBeenLastCalledWith('run.interrupt', expect.any(Object));
          f.finish();
        }
        await f.coordinator.dispatch(f.session.id);
        expect(f.control).toHaveBeenLastCalledWith(
          'run.start',
          expect.objectContaining({
            input: 'ordinary-immediate'
          })
        );
        f.finish();
        await f.coordinator.dispatch(f.session.id);
        expect(f.control).toHaveBeenLastCalledWith(
          'run.start',
          expect.objectContaining({
            input: 'goal-next'
          })
        );
        expect(f.runtime.sessionQueue(f.session.id).itemIds).toEqual(['ordinary-first']);
      } finally {
        f.coordinator.clear();
      }
    }
  );
});
