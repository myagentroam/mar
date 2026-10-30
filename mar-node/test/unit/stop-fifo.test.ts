import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import type { RunnerSteerResult } from '../../src/runner/contracts.js';
import {
  ContinuousRunCoordinator,
  type PreparedExecutionInput
} from '../../src/service/continuous-run-coordinator.js';
import { RunWorkbenchService } from '../../src/service/run-workbench-service.js';
import { WorkspaceQueueWorkbenchService } from '../../src/workspace/workspace-queue-workbench-service.js';

const coordinators: ContinuousRunCoordinator<unknown>[] = [];
afterEach(() => {
  for (const coordinator of coordinators) coordinator.clear();
  coordinators.length = 0;
});

async function fixture(native = false) {
  const runtime = new NodeRuntimeState(
    () => 'node',
    () => ({
      id: 'workspace',
      path: '/workspace',
      kind: 'DIRECTORY',
      gitSummary: null,
      createdAt: 1,
      updatedAt: 1
    })
  );
  const session = runtime.createAgentSession({
    workspaceId: 'workspace',
    runner: 'mar-agent',
    cwd: '/workspace'
  });
  const receipt = Promise.withResolvers<RunnerSteerResult>();
  const runner = { control: vi.fn(), steer: vi.fn(() => receipt.promise) };
  const afterExecutionSteered = vi.fn(async () => undefined);
  const goalCurrent = vi.fn((_input: PreparedExecutionInput<unknown>) => true);
  const coordinator = new ContinuousRunCoordinator({
    executionTerminating: () => undefined,
    keepRunActive: () => false,
    runtime,
    control: runner.control,
    ...(native ? { steer: runner.steer } : {}),
    stopped: () => false,
    mcps: () => [],
    emitQueue: vi.fn(),
    emitConversation: vi.fn(),
    clearImages: vi.fn(),
    cleanupAttachments: vi.fn(),
    migrateAssets: vi.fn(),
    emitRun: vi.fn(),
    markInterrupted: vi.fn(),
    afterExecutionSteered,
    goalCurrent
  });
  coordinators.push(coordinator);
  const queueService = new WorkspaceQueueWorkbenchService({
    runtime,
    coordinator,
    resolve: async (id) => runtime.getAgentSession(id),
    emit: vi.fn(),
    prepareInput: (_runner, input) => input
  });
  const service = new RunWorkbenchService({
    runtime,
    control: runner.control,
    pauseQueue: (id) => queueService.pauseSessionQueue(id),
    runInterrupted: () => undefined,
    emitRun: vi.fn(),
    markInterrupted: vi.fn(),
    readImage: async () => undefined,
    respondUserInput: vi.fn()
  });
  const submit = (id: string) => {
    const queueBefore = runtime.sessionQueue(session.id);
    const accepted = coordinator.accept({
      runId: id,
      sessionId: session.id,
      clientMessageId: id,
      content: id
    });
    coordinator.prepare(id, {
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
      secretEnvironment: {}
    });
    return { id, queueBefore, accepted };
  };
  const first = submit('original');
  await coordinator.settle({
    submissionId: first.id,
    intent: 'SEND',
    queueBefore: first.queueBefore
  });
  await coordinator.dispatch(session.id);
  const run = first.accepted.run;
  const executionId = runtime.currentExecutionId(run.id)!;
  coordinator.executionStarted(executionId);
  expect(runner.control).toHaveBeenCalledWith(
    'run.start',
    expect.objectContaining({ input: 'original' })
  );
  runner.control.mockClear();
  const stop = (operation = 'run.interrupt', sessionId = session.id) => {
    service.operations()[operation]!({ runId: run.id, sessionId });
    expect(runtime.getRun(run.id)?.status).toBe('CANCELLING');
    expect(runtime.sessionQueue(sessionId).paused).toBe(true);
    expect(runner.control).toHaveBeenCalledWith(
      operation === 'run.cancel' ? operation : 'run.interrupt',
      { runId: executionId }
    );
  };
  const finishExecution = () => {
    runtime.appendRunEvent({
      runId: executionId,
      sequence: 1,
      eventType: 'run.completed',
      payload: {},
      status: 'INTERRUPTED'
    });
    coordinator.remove(executionId);
  };
  const finishStoppedRun = () => {
    finishExecution();
    runtime.finishRun(run.id, 'INTERRUPTED');
    runtime.removeTerminalRun(run.id);
    expect(runtime.activeSessionRun(session.id)).toBeUndefined();
  };
  const expectRetained = async (ids: string[]) => {
    await coordinator.dispatch(session.id);
    expect(runtime.sessionQueue(session.id)).toMatchObject({ paused: true, itemIds: ids });
    for (const id of ids) {
      expect(runtime.getQueueItem(id)?.content).toBe(id);
      expect(coordinator.pending(id)?.input).toBe(id);
    }
    expect(runner.control.mock.calls.filter(([operation]) => operation === 'run.start')).toEqual(
      []
    );
  };
  return {
    runtime,
    session,
    coordinator,
    runner,
    afterExecutionSteered,
    goalCurrent,
    receipt,
    submit,
    run,
    executionId,
    stop,
    finishExecution,
    finishStoppedRun,
    expectRetained
  };
}

describe('user stop owns the Session FIFO pause', () => {
  it.each(['run.interrupt', 'session.interrupt', 'run.cancel'])(
    'retains ordinary SEND during CANCELLING after %s and after the old Run terminates',
    async (operation) => {
      const f = await fixture();
      const older = f.submit('older');
      // Capture the pre-stop snapshot too: preparation must not undo a later stop.
      const beforeStop = f.submit('preparing-before-stop');
      f.stop(operation);
      const later = f.submit('sent-during-cancelling');
      for (const item of [beforeStop, later]) {
        expect(
          await f.coordinator.settle({
            submissionId: item.id,
            intent: 'SEND',
            queueBefore: item.queueBefore
          })
        ).toBe('QUEUED');
      }
      const ids = [older.id, beforeStop.id, later.id];
      await f.expectRetained(ids);
      f.finishExecution();
      const afterExecution = f.submit('sent-before-run-terminal');
      expect(
        await f.coordinator.settle({
          submissionId: afterExecution.id,
          intent: 'SEND',
          queueBefore: afterExecution.queueBefore
        })
      ).toBe('QUEUED');
      ids.push(afterExecution.id);
      await f.expectRetained(ids);
      f.runtime.finishRun(f.run.id, 'INTERRUPTED');
      await f.expectRetained(ids);
    }
  );

  it.each(['settle', 'execute'] as const)(
    'keeps a newer stop when a native receipt arrives through %s',
    async (entry) => {
      for (const status of ['accepted', 'handled', 'notAccepted'] as const) {
        const f = await fixture(true);
        const ordinary = f.submit('ordinary');
        // Repeated pause must still belong to the newer stop, not this admission.
        f.runtime.pauseSessionQueue(f.session.id);
        const target = f.submit('guidance');
        const attempt =
          entry === 'execute'
            ? f.coordinator.executeQueueItem(target.id)
            : f.coordinator.settle({
                submissionId: target.id,
                intent: 'REPLACE_CURRENT',
                queueBefore: target.queueBefore,
                activeRunId: f.run.id,
                steerTarget: {
                  turnId: f.runtime.conversationTurnForRun(f.run.id)!.id,
                  executionId: f.executionId
                }
              });
        expect(f.runner.steer).toHaveBeenCalledOnce();
        f.stop();
        f.receipt.resolve(
          status === 'accepted'
            ? {
                status,
                item: {
                  itemId: 'accepted-guidance',
                  kind: 'user_message',
                  status: 'COMPLETED',
                  payload: { text: target.id }
                }
              }
            : { status }
        );
        const result = await attempt;
        const delivery = status === 'notAccepted' ? 'QUEUED' : 'ACCEPTED';
        expect(entry === 'execute' ? (result as { delivery: string }).delivery : result).toBe(
          delivery
        );
        const ids = status === 'notAccepted' ? [ordinary.id, target.id] : [ordinary.id];
        if (status !== 'notAccepted') {
          expect(f.runtime.getQueueItem(target.id)).toBeUndefined();
          expect(f.runtime.findMessageSubmission(f.session.id, target.id)).toMatchObject({
            kind: 'run',
            run: { id: f.run.id }
          });
        }
        await f.expectRetained(ids);
        f.finishExecution();
        await f.expectRetained(ids);
        f.runtime.finishRun(f.run.id, 'INTERRUPTED');
        await f.expectRetained(ids);
      }
    }
  );

  it.each(['accepted', 'handled'] as const)(
    'consumes a late %s receipt after resource cleanup without undoing the stop',
    async (status) => {
      const f = await fixture(true);
      const ordinary = f.submit('ordinary');
      const target = f.submit('guidance');
      const attempt = f.coordinator.executeQueueItem(target.id);
      f.stop();
      f.finishStoppedRun();
      expect(f.runtime.getRun(f.run.id)).toBeUndefined();
      f.receipt.resolve(
        status === 'handled'
          ? { status }
          : {
              status,
              item: {
                itemId: 'late-accepted',
                kind: 'user_message',
                status: 'COMPLETED',
                payload: { text: target.id }
              }
            }
      );
      expect(await attempt).toMatchObject({ delivery: 'ACCEPTED' });
      expect(f.runtime.getQueueItem(target.id)).toBeUndefined();
      expect(f.runtime.findMessageSubmission(f.session.id, target.id)).toMatchObject({
        kind: 'run',
        run: { id: f.run.id, status: 'INTERRUPTED' }
      });
      expect(f.runtime.getRun(f.run.id)).toBeUndefined();
      await f.expectRetained([ordinary.id]);
    }
  );

  it('resumes idle FIFO with the new SEND first, then retains older queue order', async () => {
    const f = await fixture();
    const older = f.submit('older');
    const later = f.submit('later');
    f.stop();
    f.finishStoppedRun();
    const fresh = f.submit('fresh');
    expect(
      await f.coordinator.settle({
        submissionId: fresh.id,
        intent: 'SEND',
        queueBefore: fresh.queueBefore
      })
    ).toBe('STARTED');
    await f.coordinator.dispatch(f.session.id);
    expect(f.runner.control).toHaveBeenCalledWith(
      'run.start',
      expect.objectContaining({ input: fresh.id })
    );
    expect(f.runtime.sessionQueue(f.session.id)).toMatchObject({
      paused: false,
      itemIds: [older.id, later.id]
    });
  });

  it('keeps the newer stop after an in-flight native Session changes identity', async () => {
    const f = await fixture(true);
    const ordinary = f.submit('ordinary');
    const target = f.submit('guidance');
    const attempt = f.coordinator.executeQueueItem(target.id);
    const promoted = f.runtime.promoteSessionIdentity(f.session.id, 'native-stopped');
    f.coordinator.migrateSession(f.session.id, promoted.id);
    f.stop('session.interrupt', promoted.id);
    f.receipt.resolve({ status: 'notAccepted' });
    expect(await attempt).toMatchObject({ delivery: 'QUEUED' });
    const ids = [ordinary.id, target.id];
    expect(f.runtime.sessionQueue(promoted.id)).toMatchObject({ paused: true, itemIds: ids });
    f.finishExecution();
    await f.coordinator.dispatch(promoted.id);
    f.runtime.finishRun(f.run.id, 'INTERRUPTED');
    f.runtime.removeTerminalRun(f.run.id);
    await f.coordinator.dispatch(promoted.id);
    expect(f.runtime.sessionQueue(promoted.id)).toMatchObject({ paused: true, itemIds: ids });
    for (const id of ids) {
      expect(f.runtime.getQueueItem(id)?.content).toBe(id);
      expect(f.coordinator.pending(id)?.input).toBe(id);
    }
    expect(f.runner.control.mock.calls.filter(([operation]) => operation === 'run.start')).toEqual(
      []
    );
  });

  it('resumes the admission-owned pause on the promoted native Session', async () => {
    const f = await fixture(true);
    const ordinary = f.submit('ordinary');
    f.runtime.pauseSessionQueue(f.session.id);
    const target = f.submit('guidance');
    const goal = { id: 'active-goal', revision: 2, epoch: 1 };
    f.coordinator.prepare(target.id, { ...f.coordinator.pending(target.id)!, goal });
    const attempt = f.coordinator.executeQueueItem(target.id);
    const promoted = f.runtime.promoteSessionIdentity(f.session.id, 'native-resumed');
    f.coordinator.migrateSession(f.session.id, promoted.id);
    f.goalCurrent.mockImplementation((input) => input.sessionId === promoted.id);
    f.receipt.resolve({ status: 'handled' });
    expect(await attempt).toMatchObject({ delivery: 'ACCEPTED' });
    expect(f.runtime.sessionQueue(promoted.id)).toMatchObject({
      paused: false,
      itemIds: [ordinary.id]
    });
    expect(f.runtime.getQueueItem(target.id)).toBeUndefined();
    expect(f.runtime.findMessageSubmission(promoted.id, target.id)).toMatchObject({
      kind: 'run',
      run: { id: f.run.id, sessionId: promoted.id }
    });
    expect(f.runtime.currentExecutionId(f.run.id)).toBe(f.executionId);
    expect(f.coordinator.pending(f.executionId)?.goal).toEqual(goal);
    expect(f.afterExecutionSteered).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: promoted.id,
        externalSessionId: promoted.id,
        runId: f.executionId
      })
    );
  });

  it('keeps dispatch gated across native Session identity promotion until the receipt settles', async () => {
    const f = await fixture(true);
    const ordinary = f.submit('ordinary');
    const target = f.submit('guidance');
    const attempt = f.coordinator.executeQueueItem(target.id);
    const promoted = f.runtime.promoteSessionIdentity(f.session.id, 'native-in-flight');
    f.coordinator.migrateSession(f.session.id, promoted.id);
    f.finishExecution();
    await f.coordinator.dispatch(promoted.id);
    expect(f.runtime.sessionQueue(promoted.id).itemIds).toEqual([ordinary.id, target.id]);
    expect(f.runner.control).not.toHaveBeenCalled();
    f.receipt.resolve({ status: 'handled' });
    expect(await attempt).toMatchObject({ delivery: 'ACCEPTED' });
    expect(f.runtime.sessionQueue(promoted.id).itemIds).toEqual([ordinary.id]);
  });

  it('resumes the admission-owned pause despite queue edits and consumes native input only once', async () => {
    const f = await fixture(true);
    const older = f.submit('older');
    f.runtime.pauseSessionQueue(f.session.id);
    const target = f.submit('guidance');
    const first = f.coordinator.executeQueueItem(target.id);
    const duplicate = f.coordinator.executeQueueItem(target.id);
    const later = f.submit('later');
    f.runtime.updateQueueItem(older.id, 'edited older');
    f.receipt.resolve({ status: 'handled' });
    expect(await first).toMatchObject({ delivery: 'ACCEPTED' });
    expect(await duplicate).toMatchObject({ delivery: 'ACCEPTED' });
    expect(f.runner.steer).toHaveBeenCalledOnce();
    expect(f.runtime.getQueueItem(target.id)).toBeUndefined();
    expect(f.runtime.sessionQueue(f.session.id)).toMatchObject({
      paused: false,
      itemIds: [older.id, later.id]
    });
    expect(f.runtime.getQueueItem(older.id)?.content).toBe('edited older');
    expect(f.runtime.currentExecutionId(f.run.id)).toBe(f.executionId);
    expect(f.runner.control).not.toHaveBeenCalled();
  });

  it('lets a new explicit REPLACE_CURRENT resume and replace during CANCELLING', async () => {
    const f = await fixture();
    const older = f.submit('older');
    f.stop();
    const target = f.submit('replacement');
    expect(
      await f.coordinator.settle({
        submissionId: target.id,
        intent: 'REPLACE_CURRENT',
        queueBefore: target.queueBefore,
        activeRunId: f.run.id
      })
    ).toBe('ACCEPTED');
    expect(f.runtime.sessionQueue(f.session.id)).toMatchObject({
      paused: false,
      itemIds: [target.id, older.id]
    });
    expect(f.runner.control.mock.calls.filter(([operation]) => operation === 'run.start')).toEqual(
      []
    );
    expect(
      f.coordinator.acceptExecutionTerminal({
        executionId: f.executionId,
        sequence: 1,
        eventType: 'run.completed',
        payload: {},
        status: 'INTERRUPTED'
      })
    ).toMatchObject({ finalStatus: 'INTERRUPTED' });
    expect(f.runtime.getRun(f.run.id)).toMatchObject({
      status: 'INTERRUPTED',
      interruptionReason: 'USER_STOP'
    });
    f.coordinator.remove(f.executionId);
    f.runtime.removeTerminalRun(f.run.id);
    // First dispatch admits the queued Run; the next starts its Execution.
    await f.coordinator.dispatch(f.session.id);
    await f.coordinator.dispatch(f.session.id);
    expect(f.runner.control).toHaveBeenCalledWith(
      'run.start',
      expect.objectContaining({ input: target.id })
    );
    const replacementRun = f.runtime.activeSessionRun(f.session.id);
    expect(replacementRun).toMatchObject({ sessionId: f.session.id });
    expect(replacementRun?.id).not.toBe(f.run.id);
    expect(f.runtime.sessionQueue(f.session.id).itemIds).toEqual([older.id]);
  });
});
