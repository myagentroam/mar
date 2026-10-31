import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { RunnerName } from '@myagentroam/protocol';
import { NodeMetrics } from '../../src/operational.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { ContinuousRunCoordinator } from '../../src/service/continuous-run-coordinator.js';
import { RunEventService } from '../../src/service/run-event-service.js';
import { RunWorkbenchService } from '../../src/service/run-workbench-service.js';
import { WorkspaceQueueWorkbenchService } from '../../src/workspace/workspace-queue-workbench-service.js';

function fixture(runner: RunnerName = 'mar-agent') {
  const runtime = new NodeRuntimeState(
    () => 'node-1',
    (id) => ({
      id,
      path: '/workspace',
      kind: 'DIRECTORY',
      gitSummary: null,
      createdAt: 1,
      updatedAt: 1
    })
  );
  const session = runtime.createAgentSession({
    workspaceId: 'workspace-1',
    runner,
    cwd: '/workspace'
  });
  const control = vi.fn((operation: string, payload: Record<string, unknown>) => {
    if (operation !== 'run.start') return;
    const executionId = payload.runId as string;
    runtime.executionAccepted(executionId);
    events.emit(executionId, 'run.started', {}, 'STARTING');
    events.emit(executionId, 'run.running', {}, 'RUNNING');
  });
  const coordinator = new ContinuousRunCoordinator({
    runtime,
    executionTerminating: () => undefined,
    keepRunActive: () => false,
    emitQueue: vi.fn(),
    emitConversation: vi.fn(),
    clearImages: vi.fn(),
    cleanupAttachments: vi.fn(),
    migrateAssets: vi.fn(),
    emitRun: (...args) => events.emit(...args),
    control,
    stopped: () => false,
    markInterrupted: (id) => runtime.requestExecutionInterrupt(id),
    mcps: () => []
  });
  const events = new RunEventService({
    runtime,
    metrics: new NodeMetrics(),
    isBootstrapSession: () => false,
    presentSession: (value) => value,
    rejectBootstrap: vi.fn(),
    emitWorkbench: vi.fn(),
    cleanupAttachments: vi.fn(),
    expireImages: vi.fn(),
    scheduleContextRefresh: vi.fn(),
    refreshWorkspaceSessions: async () => undefined,
    dispatchQueue: async (id, delay) => coordinator.schedule(id, delay),
    executionStarted: (id) => coordinator.executionStarted(id),
    acceptExecutionTerminal: (input) => coordinator.acceptExecutionTerminal(input),
    publishGoalUpdate: vi.fn(),
    publishQueueChange: (id) => coordinator.publish(id),
    releaseExecution: (id) => coordinator.remove(id)
  });
  const queues = new WorkspaceQueueWorkbenchService({
    runtime,
    coordinator,
    resolve: async (id) => runtime.getAgentSession(id),
    emit: vi.fn(),
    prepareInput: (_runner, input) => input
  });
  const workbench = new RunWorkbenchService({
    runtime,
    readImage: async () => undefined,
    respondUserInput: vi.fn(),
    pauseQueue: (id) => queues.pauseSessionQueue(id),
    runInterrupted: () => undefined,
    emitRun: (...args) => events.emit(...args),
    control,
    markInterrupted: (id) => runtime.requestExecutionInterrupt(id)
  });
  onTestFinished(() => {
    coordinator.clear();
    events.clear();
  });

  function accept(id: string) {
    const accepted = coordinator.accept({
      runId: id,
      sessionId: session.id,
      clientMessageId: id,
      content: id
    });
    coordinator.prepare(accepted.queueItem?.id ?? accepted.run.id, {
      runId: id,
      sessionId: session.id,
      workspaceId: session.workspaceId,
      executionContext: { runner },
      input: id,
      attachments: [],
      attachmentPaths: [],
      cwd: session.cwd,
      externalSessionId: 'native-session',
      modelId: null,
      effort: null,
      access: null,
      collaborationMode: 'default',
      secretEnvironment: {}
    });
    return accepted;
  }

  function startCommand(visible: boolean) {
    // Immediate commands own the root Runner handle, not a normal message Execution.
    runtime.executionAccepted('compact-command');
    const command = runtime.adoptRun({
      runId: 'compact-command',
      sessionId: session.id,
      runner,
      cwd: session.cwd,
      externalSessionId: 'native-session'
    });
    events.emit(command.id, 'run.started', {}, 'STARTING');
    if (visible) {
      events.emit(command.id, 'run.running', {}, 'RUNNING');
      events.emit(command.id, 'conversation.item', {
        itemId: 'compact-progress',
        kind: 'context_compaction',
        status: 'IN_PROGRESS',
        payload: { phase: 'STARTED', summary: null }
      });
    }
    return command;
  }

  async function stopWithQueue() {
    const original = accept('original').run;
    await coordinator.dispatch(session.id);
    const executionId = runtime.currentExecutionId(original.id)!;
    const first = accept('first').queueItem!;
    const second = accept('second').queueItem!;
    workbench.operations()['run.interrupt']!({ runId: original.id });
    expect(runtime.sessionQueue(session.id).paused).toBe(true);
    events.emit(executionId, 'run.cancelled', {}, 'CANCELLED');
    await vi.runOnlyPendingTimersAsync();
    expect(runtime.activeSessionRun(session.id)).toBeUndefined();
    control.mockClear();
    return [first.id, second.id];
  }

  return {
    runtime,
    session,
    control,
    coordinator,
    events,
    queues,
    workbench,
    accept,
    startCommand,
    stopWithQueue
  };
}

describe('immediate command Queue dispatch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([
    { runner: 'mar-agent', visible: false },
    { runner: 'mar-agent', visible: true },
    { runner: 'codex', visible: true },
    { runner: 'claude-code', visible: true },
    { runner: 'opencode', visible: true }
  ] as const)(
    'waits for $runner command completion after stop and automatic Queue resume (visible=$visible)',
    async ({ runner, visible }) => {
      const f = fixture(runner);
      const queuedIds = await f.stopWithQueue();
      const command = f.startCommand(visible);

      f.queues.resumeAfterCommandRun(f.session.id);
      await vi.runOnlyPendingTimersAsync();

      expect(f.runtime.sessionQueue(f.session.id)).toMatchObject({
        paused: false,
        itemIds: queuedIds
      });
      expect(f.runtime.currentExecutionId(command.id)).toBeUndefined();
      expect(f.runtime.isExecutionActive(command.id)).toBe(true);
      expect(f.control).not.toHaveBeenCalled();

      f.events.emit(command.id, 'run.completed', {}, 'SUCCEEDED');
      await vi.runOnlyPendingTimersAsync();

      expect(f.control).toHaveBeenCalledExactlyOnceWith(
        'run.start',
        expect.objectContaining({ input: 'first' })
      );
      expect(f.runtime.sessionQueue(f.session.id).itemIds).toEqual([queuedIds[1]]);
      expect(f.runtime.activeSessionRun(f.session.id)?.id).toBe(command.id);
      const firstExecution = f.runtime.currentExecutionId(command.id)!;
      expect(firstExecution).not.toBe(command.id);
      expect(f.runtime.isExecutionActive(command.id)).toBe(false);

      f.events.emit(firstExecution, 'run.completed', {}, 'SUCCEEDED');
      await vi.runOnlyPendingTimersAsync();
      expect(f.control).toHaveBeenCalledTimes(2);
      expect(f.control).toHaveBeenLastCalledWith(
        'run.start',
        expect.objectContaining({ input: 'second' })
      );
      const secondExecution = f.runtime.currentExecutionId(command.id)!;
      f.events.emit(secondExecution, 'run.completed', {}, 'SUCCEEDED');
      expect(f.runtime.activeSessionRun(f.session.id)).toBeUndefined();
      expect(f.runtime.activeExecutionCount()).toBe(0);
    }
  );

  it('keeps queued messages until a failed command settles, then dispatches once', async () => {
    const f = fixture();
    const queuedIds = await f.stopWithQueue();
    const command = f.startCommand(true);
    f.queues.resumeAfterCommandRun(f.session.id);
    await vi.runOnlyPendingTimersAsync();
    expect(f.runtime.sessionQueue(f.session.id).itemIds).toEqual(queuedIds);
    expect(f.control).not.toHaveBeenCalled();

    f.events.emit(command.id, 'run.failed', { code: 'COMPACT_FAILED' }, 'FAILED');
    await vi.runOnlyPendingTimersAsync();
    expect(f.control).toHaveBeenCalledExactlyOnceWith(
      'run.start',
      expect.objectContaining({ input: 'first' })
    );
    expect(f.runtime.sessionQueue(f.session.id).itemIds).toEqual([queuedIds[1]]);
  });

  it('preserves an explicit Queue pause while the command finishes', async () => {
    const f = fixture();
    const queuedIds = await f.stopWithQueue();
    const command = f.startCommand(true);
    f.queues.resumeAfterCommandRun(f.session.id);
    await vi.runOnlyPendingTimersAsync();
    f.queues.pauseSessionQueue(f.session.id);

    f.events.emit(command.id, 'run.completed', {}, 'SUCCEEDED');
    await vi.runOnlyPendingTimersAsync();
    expect(f.runtime.sessionQueue(f.session.id)).toMatchObject({
      paused: true,
      itemIds: queuedIds
    });
    expect(f.runtime.activeSessionRun(f.session.id)).toBeUndefined();
    expect(f.control).not.toHaveBeenCalled();

    await f.coordinator.resume(f.session.id);
    await vi.runOnlyPendingTimersAsync();
    expect(f.control).toHaveBeenCalledExactlyOnceWith(
      'run.start',
      expect.objectContaining({ input: 'first' })
    );
  });

  it('interrupts the actual command handle and retains the paused Queue on cancellation', async () => {
    const f = fixture();
    const queuedIds = await f.stopWithQueue();
    const command = f.startCommand(true);
    f.queues.resumeAfterCommandRun(f.session.id);
    await vi.runOnlyPendingTimersAsync();

    f.workbench.operations()['run.interrupt']!({ runId: command.id });
    expect(f.control).toHaveBeenCalledExactlyOnceWith('run.interrupt', { runId: command.id });
    f.events.emit(command.id, 'run.cancelled', {}, 'CANCELLED');
    await vi.runOnlyPendingTimersAsync();

    expect(f.control).toHaveBeenCalledTimes(1);
    expect(f.runtime.sessionQueue(f.session.id)).toMatchObject({
      paused: true,
      itemIds: queuedIds
    });
    expect(f.runtime.activeSessionRun(f.session.id)).toBeUndefined();
    expect(f.runtime.activeExecutionCount()).toBe(0);
  });
});
