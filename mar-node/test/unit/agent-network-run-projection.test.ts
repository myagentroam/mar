import { describe, expect, it, vi } from 'vitest';
import { NodeMetrics } from '../../src/operational.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { AgentNetworkObservations } from '../../src/service/agent-network-observations.js';
import { AgentNetworkRunProjection } from '../../src/service/agent-network-run-projection.js';
import { waitForAgentTargets } from '../../src/service/agent-network-wait.js';
import { ContinuousRunCoordinator } from '../../src/service/continuous-run-coordinator.js';
import { RunEventService } from '../../src/service/run-event-service.js';

function fixture(parentWorkspace = 'workspace') {
  const runtime = new NodeRuntimeState(
    () => 'node',
    (id) => ({ id, path: '/' + id, kind: 'DIRECTORY', gitSummary: null })
  );
  const observations = new AgentNetworkObservations();
  const projection = new AgentNetworkRunProjection(runtime, observations);
  const parent = runtime.createAgentSession({
    workspaceId: parentWorkspace,
    cwd: '/' + parentWorkspace,
    runner: 'codex'
  });
  const child = runtime.createAgentSession({
    workspaceId: 'workspace',
    cwd: '/workspace',
    runner: 'codex',
    parentSessionId: parent.id
  });
  const { run } = runtime.createMessageRun({
    sessionId: child.id,
    clientMessageId: 'input',
    content: 'work',
    initiatedByUserId: 7
  });
  return { runtime, observations, projection, parent, child, run };
}

describe('Agent Network Run projection', () => {
  it('retains pending approval details when a later public reply arrives', async () => {
    const f = fixture();
    const parent = f.observations.attach(f.parent.id);
    f.runtime.createApproval({
      runId: f.run.id,
      approvalId: 'approval-to-retain',
      payload: { toolName: 'command' },
      expiresAt: Date.now() + 60_000
    });
    f.projection.accept({
      run: f.run,
      executionId: 'execution',
      eventType: 'approval.request',
      payload: {}
    });
    f.projection.accept({
      run: f.run,
      executionId: 'execution',
      eventType: 'conversation.item',
      payload: {
        kind: 'assistant_message',
        status: 'COMPLETED',
        payload: { text: 'Waiting for approval', phase: 'commentary' }
      }
    });
    const [item] = await parent.collect(new AbortController().signal);
    expect(item!.content).toContain('pendingApprovals');
    expect(item!.content).toContain('approval-to-retain');
    expect(item!.content).toContain('Waiting for approval');
    item!.acknowledge();
    expect(await parent.collect(new AbortController().signal)).toEqual([]);
    parent.close();
    f.projection.dispose();
  });

  it('projects approvals and terminal identity to the direct parent, not a foreign Workspace', () => {
    const f = fixture();
    const parent = f.observations.attach(f.parent.id);
    f.runtime.createApproval({
      runId: f.run.id,
      approvalId: 'approval',
      payload: { toolName: 'command' },
      expiresAt: Date.now() + 60_000
    });
    const history = vi.spyOn(f.runtime, 'conversationTail').mockImplementation(() => {
      throw new Error('APPROVAL_MUST_NOT_READ_CONVERSATION');
    });
    f.projection.accept({
      run: f.run,
      executionId: 'execution',
      eventType: 'approval.request',
      payload: {}
    });
    expect(parent.capture(f.child.id)).toMatchObject({
      runId: f.run.id,
      executionId: 'execution',
      updates: [{ kind: 'message', value: expect.stringContaining('pendingApprovals') }]
    });
    expect(history).not.toHaveBeenCalled();
    f.projection.accept({
      run: f.run,
      executionId: 'execution',
      eventType: 'run.completed',
      payload: {},
      terminalStatus: 'SUCCEEDED'
    });
    expect(parent.capture(f.child.id)?.updates).toContainEqual(
      expect.objectContaining({ kind: 'terminal', value: 'SUCCEEDED' })
    );
    parent.close();
    const other = fixture('foreign');
    const foreign = other.observations.attach(other.parent.id);
    other.projection.accept({
      run: other.run,
      executionId: 'execution',
      eventType: 'run.completed',
      payload: {},
      terminalStatus: 'SUCCEEDED'
    });
    expect(foreign.capture(other.child.id)).toBeUndefined();
    foreign.close();
  });

  it('owns transient attachment and closes it only for the matching terminal Run', () => {
    const f = fixture();
    expect(() =>
      f.projection.ensureObservations({ sessionId: f.child.id, runId: 'missing' })
    ).toThrow('AGENT_ACTOR_NOT_ACTIVE');
    const observer = f.projection.ensureObservations({ sessionId: f.child.id, runId: f.run.id });
    expect(f.projection.ensureObservations({ sessionId: f.child.id, runId: f.run.id })).toBe(
      observer
    );
    f.projection.accept({
      run: { ...f.run, id: 'stale' },
      executionId: 'stale',
      eventType: 'run.completed',
      payload: {},
      terminalStatus: 'SUCCEEDED',
      runTerminal: true
    });
    expect(f.observations.get(f.child.id)).toBe(observer);
    f.projection.accept({
      run: f.run,
      executionId: 'execution',
      eventType: 'run.completed',
      payload: {},
      terminalStatus: 'SUCCEEDED',
      runTerminal: true
    });
    expect(f.observations.get(f.child.id)).toBeUndefined();
  });

  it('delivers the first Execution completion before the same Run dispatches queued work', async () => {
    const { runtime, observations, projection, parent, child, run } = fixture();
    const observer = observations.attach(parent.id);
    const childObserver = projection.ensureObservations({ sessionId: child.id, runId: run.id });
    const abort = new AbortController();
    const resumeDispatch = Promise.withResolvers<void>();
    const dispatchQueue = vi.fn(async (sessionId: string) => {
      await resumeDispatch.promise;
      if (!abort.signal.aborted) await coordinator.dispatch(sessionId);
    });
    const start = vi.fn();
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: vi.fn(),
      emitConversation: vi.fn(),
      clearImages: vi.fn(),
      cleanupAttachments: vi.fn(),
      migrateAssets: vi.fn(),
      emitRun: vi.fn(),
      control: (operation, payload) => {
        if (operation === 'run.start') start(payload.runId);
      },
      stopped: () => false,
      markInterrupted: vi.fn(),
      mcps: () => [],
      executionTerminating: () => undefined,
      keepRunActive: () => false
    });
    const emitWorkbench = vi.fn();
    const onTerminalRun = vi.fn();
    const idleSnapshot = Promise.withResolvers<void>();
    const refreshWorkspaceSessions = vi.fn(() => idleSnapshot.promise);
    const events = new RunEventService({
      runtime,
      metrics: new NodeMetrics(),
      isBootstrapSession: () => false,
      presentSession: (session) => session,
      rejectBootstrap: vi.fn(),
      emitWorkbench,
      cleanupAttachments: vi.fn(),
      expireImages: vi.fn(),
      scheduleContextRefresh: vi.fn(),
      refreshWorkspaceSessions,
      dispatchQueue,
      acceptExecutionTerminal: (input) => coordinator.acceptExecutionTerminal(input),
      publishGoalUpdate: vi.fn(),
      publishQueueChange: (sessionId) => coordinator.publish(sessionId),
      releaseExecution: (id) => coordinator.remove(id),
      observeAgentEvent: projection.accept,
      onTerminalRun
    });
    const notifyEvents = () =>
      emitWorkbench.mock.calls.filter(
        ([category, payload]) =>
          category === 'conversation' && payload.event?.eventType === 'notification'
      );
    const wait = (executionId: string) =>
      waitForAgentTargets({
        targets: [
          {
            agentId: child.id,
            runId: run.id,
            executionId,
            read: () => runtime.executionSnapshot(executionId)!
          }
        ],
        observations: observer,
        waitFor: 'completion',
        waitMs: 300,
        signal: abort.signal,
        single: true
      });
    const answer = (executionId: string, text: string) =>
      events.emit(executionId, 'conversation.item', {
        itemId: executionId,
        kind: 'assistant_message',
        status: 'COMPLETED',
        payload: { text, phase: 'final_answer' }
      });

    vi.useFakeTimers();
    try {
      const first = runtime.createExecution(run.id);
      runtime.executionAccepted(first.id);
      events.emit(first.id, 'run.running', {}, 'RUNNING');
      const next = coordinator.accept({
        runId: 'queued',
        sessionId: child.id,
        clientMessageId: 'second',
        content: 'second input',
        initiatedByUserId: 7
      });
      coordinator.prepare(next.queueItem!.id, {
        runId: next.queueItem!.id,
        sessionId: child.id,
        workspaceId: child.workspaceId,
        executionContext: { runner: 'codex' },
        input: 'second input',
        attachments: [],
        attachmentPaths: [],
        cwd: child.cwd,
        externalSessionId: 'thread-1',
        modelId: null,
        effort: null,
        access: null,
        collaborationMode: 'default',
        secretEnvironment: {}
      });
      answer(first.id, 'First final answer');
      const completion = wait(first.id);
      void completion.catch(() => undefined);
      expect(vi.getTimerCount()).toBe(1);

      const sequence = runtime.lastRunSequence(run.id);
      vi.spyOn(runtime, 'lastRunSequence').mockReturnValueOnce(sequence - 1);
      events.emit(first.id, 'run.completed', {}, 'SUCCEEDED');
      expect(runtime.lastRunSequence(run.id)).toBe(sequence);
      expect(runtime.executionSnapshot(first.id)?.status).toBe('RUNNING');
      expect(vi.getTimerCount()).toBe(1);
      expect(dispatchQueue).not.toHaveBeenCalled();

      emitWorkbench.mockClear();
      events.emit(first.id, 'run.completed', {}, 'SUCCEEDED');
      // No timers advanced, and the next Execution cannot emit anything until dispatch is released.
      expect(vi.getTimerCount()).toBe(0);
      expect(await completion).toMatchObject({
        executionId: first.id,
        status: 'SUCCEEDED',
        waitOutcome: 'completion',
        summary: 'First final answer',
        updates: [expect.objectContaining({ kind: 'terminal', value: 'SUCCEEDED' })]
      });
      // A duplicate can arrive before the Run moves to the next Turn.
      events.emit(first.id, 'run.completed', {}, 'SUCCEEDED');
      const repeated = await wait(first.id);
      expect(repeated).not.toHaveProperty('summary');
      expect(repeated).not.toHaveProperty('updates');
      expect(runtime.activeSessionRun(child.id)).toMatchObject({ id: run.id, status: 'RUNNING' });
      expect(observations.get(child.id)).toBe(childObserver);
      expect(emitWorkbench.mock.calls.some(([category]) => category === 'run')).toBe(false);
      expect(onTerminalRun).not.toHaveBeenCalled();
      expect(refreshWorkspaceSessions).not.toHaveBeenCalled();
      expect(notifyEvents()).toEqual([]);
      expect(start).not.toHaveBeenCalled();

      resumeDispatch.resolve();
      await dispatchQueue.mock.results[0]!.value;
      const secondId = runtime.currentExecutionId(run.id)!;
      expect(start).toHaveBeenCalledExactlyOnceWith(secondId);
      expect(secondId).not.toBe(first.id);
      const secondCompletion = wait(secondId);
      void secondCompletion.catch(() => undefined);
      answer(first.id, 'Stale answer');
      events.emit(first.id, 'run.completed', {}, 'SUCCEEDED');
      expect(vi.getTimerCount()).toBe(1);
      expect(observer.capture(child.id, first.id)).toBeUndefined();
      expect(observer.capture(child.id, secondId)).toBeUndefined();
      expect(onTerminalRun).not.toHaveBeenCalled();
      expect(notifyEvents()).toEqual([]);

      answer(secondId, 'Second final answer');
      events.emit(secondId, 'run.completed', {}, 'SUCCEEDED');
      expect(vi.getTimerCount()).toBe(0);
      expect(await secondCompletion).toMatchObject({
        executionId: secondId,
        status: 'SUCCEEDED',
        waitOutcome: 'completion',
        summary: 'Second final answer'
      });
      expect(runtime.activeSessionRun(child.id)).toBeUndefined();
      expect(onTerminalRun).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: run.id }),
        'SUCCEEDED'
      );
      expect(observations.get(child.id)).toBeUndefined();
      expect(notifyEvents()).toEqual([]);
      idleSnapshot.resolve();
      await idleSnapshot.promise;
      await Promise.resolve();
      expect(notifyEvents()).toEqual([
        [
          'conversation',
          expect.objectContaining({
            event: expect.objectContaining({
              payload: expect.objectContaining({ kind: 'RUN_TERMINAL', outcome: 'SUCCEEDED' })
            })
          })
        ]
      ]);
    } finally {
      abort.abort();
      resumeDispatch.resolve();
      idleSnapshot.resolve();
      events.clear();
      coordinator.clear();
      observer.close();
      projection.dispose();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('disposes its transient observers without closing Runner-owned contexts', () => {
    const f = fixture();
    const context = f.observations.attach(f.parent.id);
    f.projection.ensureObservations({ sessionId: f.child.id, runId: f.run.id });
    f.projection.dispose();
    expect(f.observations.get(f.child.id)).toBeUndefined();
    expect(f.observations.get(f.parent.id)).toBe(context);
    context.close();
  });

  it.each(['terminal', 'dispose'] as const)(
    'closes the owned observer after Session identity promotion on %s',
    (boundary) => {
      const f = fixture();
      const observer = f.projection.ensureObservations({ sessionId: f.child.id, runId: f.run.id });
      const promoted = f.runtime.promoteSessionIdentity(f.child.id, 'native-session');
      f.observations.promote(f.child.id, promoted.id);
      expect(f.observations.get(promoted.id)).toBe(observer);
      if (boundary === 'dispose') f.projection.dispose();
      else
        f.projection.accept({
          run: f.runtime.getRun(f.run.id)!,
          executionId: 'execution',
          eventType: 'run.completed',
          payload: {},
          terminalStatus: 'SUCCEEDED',
          runTerminal: true
        });
      expect(f.observations.get(promoted.id)).toBeUndefined();
    }
  );

  it.each(['terminal', 'dispose'] as const)(
    'does not close a replacement Runner context on %s',
    (boundary) => {
      const f = fixture();
      const transient = f.projection.ensureObservations({
        sessionId: f.child.id,
        runId: f.run.id
      });
      transient.close();
      const context = f.observations.attach(f.child.id);
      if (boundary === 'dispose') f.projection.dispose();
      else
        f.projection.accept({
          run: f.run,
          executionId: 'execution',
          eventType: 'run.completed',
          payload: {},
          terminalStatus: 'SUCCEEDED',
          runTerminal: true
        });
      expect(f.observations.get(f.child.id)).toBe(context);
      context.close();
    }
  );
});
