import { describe, expect, it, vi } from 'vitest';
import {
  composerVisibleText,
  steerComposerMessage,
  serializeComposerTag,
  parseComposerTags
} from '@myagentroam/protocol';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import {
  ContinuousRunCoordinator,
  type ContinuousRunCoordinatorOptions
} from '../../src/service/continuous-run-coordinator.js';
import { WorkspaceQueueWorkbenchService } from '../../src/service/workspace-queue-workbench-service.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';

function fixture(
  overrides: Partial<ContinuousRunCoordinatorOptions> = {},
  runner: 'codex' | 'mar-agent' = 'codex'
) {
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
    runner,
    cwd: '/workspace'
  });
  const control = vi.fn();
  const coordinator = new ContinuousRunCoordinator({
    runtime,
    control,
    stopped: () => true,
    mcps: () => [],
    emitQueue: () => undefined,
    emitConversation: () => undefined,
    clearImages: () => undefined,
    cleanupAttachments: () => undefined,
    migrateAssets: () => undefined,
    emitRun: () => undefined,
    markInterrupted: () => undefined,
    ...overrides
  });
  const prepare = (id: string, text: string) => {
    const prepareSteerInput = vi.fn(() => steerComposerMessage(text));
    coordinator.prepare(id, {
      runId: id,
      sessionId: session.id,
      workspaceId: 'workspace',
      executionContext: { runner },
      input: text,
      prepareSteerInput,
      attachments: [],
      attachmentPaths: [],
      cwd: '/workspace',
      externalSessionId: 'native',
      model: null,
      effort: null,
      access: null,
      collaborationMode: 'default',
      secretEnvironment: {}
    });
    return prepareSteerInput;
  };
  const start = () => {
    const run = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'first',
      content: 'Original task'
    }).run;
    const execution = runtime.createExecution(run.id);
    prepare(execution.id, 'Original task');
    return { run, execution };
  };
  const queue = (messageId: string, text = 'Additional context') => {
    const queueBefore = runtime.sessionQueue(session.id);
    const { item } = runtime.createQueueItem({
      sessionId: session.id,
      clientMessageId: messageId,
      content: text
    });
    const prepareSteerInput = prepare(item.id, text);
    return { id: item.id, queueBefore, prepareSteerInput };
  };
  return { runtime, session, coordinator, control, prepare, start, queue };
}

describe('Node steering delivery', () => {
  it('keeps the active MAR configuration when native steer accepts an invalid incoming configuration', async () => {
    const steer = vi.fn(async () => ({ status: 'handled' as const }));
    const f = fixture({ steer, stopped: () => false }, 'mar-agent');
    const { run, execution } = f.start();
    const runner = new MarAgentRunner();
    const activeContext = runner.prepareExecutionContext({
      marAgentModel: { id: 'active-model' },
      marAgentRuntimeScopeId: 'active-scope'
    });
    f.coordinator.prepare(execution.id, {
      ...f.coordinator.pending(execution.id)!,
      executionContext: activeContext
    });
    const target = f.queue('guidance');
    f.coordinator.prepare(target.id, {
      ...f.coordinator.pending(target.id)!,
      executionContext: runner.prepareExecutionContext({ marAgentModel: 'invalid' })
    });
    expect(
      await f.coordinator.settle({
        submissionId: target.id,
        intent: 'REPLACE_CURRENT',
        queueBefore: target.queueBefore,
        activeRunId: run.id,
        steerTarget: { turnId: execution.turnId, executionId: execution.id }
      })
    ).toBe('ACCEPTED');
    expect(steer).toHaveBeenCalledOnce();
    expect(f.coordinator.pending(execution.id)?.executionContext).toBe(activeContext);
    expect(f.runtime.currentExecutionId(run.id)).toBe(execution.id);
    expect(f.runtime.getQueueItem(target.id)).toBeUndefined();
    expect(f.control).not.toHaveBeenCalled();
    f.coordinator.clear();
  });

  it('consumes only the natively accepted item, preserving the active turn and other queue order', async () => {
    const admission =
      Promise.withResolvers<import('../../src/runner/abstract-runner.js').RunnerSteerResult>();
    const steer = vi.fn(() => admission.promise);
    const emitRun = vi.fn();
    const f = fixture({ steer, emitRun, stopped: () => false });
    const { run, execution } = f.start();
    const older = f.queue('older');
    const target = f.queue('target');
    const later = f.queue('later');
    const turn = f.runtime.conversationTurnForRun(run.id)!;
    const first = f.coordinator.executeQueueItem(target.id);
    const duplicate = f.coordinator.executeQueueItem(target.id);
    expect(steer).toHaveBeenCalledOnce();
    expect(() => f.runtime.updateQueueItem(target.id, 'edited')).toThrow('QUEUE_ITEM_RECEIVING');
    expect(() => f.coordinator.deleteQueueItem(target.id)).toThrow('QUEUE_ITEM_RECEIVING');
    const queue = f.runtime.sessionQueue(f.session.id);
    expect(() =>
      f.runtime.reorderSessionQueue(f.session.id, queue.version, [...queue.itemIds].reverse())
    ).toThrow('QUEUE_ITEM_RECEIVING');
    expect(f.runtime.sessionQueue(f.session.id).itemIds).toEqual([older.id, target.id, later.id]);
    admission.resolve({
      status: 'accepted',
      item: {
        itemId: 'canonical-record',
        kind: 'user_message',
        status: 'COMPLETED',
        payload: { text: 'Additional context' }
      }
    });
    expect(await first).toEqual({ run, delivery: 'ACCEPTED' });
    expect(await duplicate).toEqual({ run, delivery: 'ACCEPTED' });
    f.coordinator.suspend();
    expect(f.runtime.sessionQueue(f.session.id).itemIds).toEqual([older.id, later.id]);
    expect(f.runtime.currentExecutionId(run.id)).toBe(execution.id);
    expect(f.runtime.conversationTurnForRun(run.id)!.id).toBe(turn.id);
    expect(f.runtime.findMessageSubmission(f.session.id, 'target')).toMatchObject({
      run: { id: run.id }
    });
    expect(f.control).not.toHaveBeenCalled();
    expect(emitRun).toHaveBeenCalledWith(
      execution.id,
      'conversation.item',
      expect.objectContaining({ itemId: 'canonical-record' })
    );
    f.runtime.finishRun(run.id, 'SUCCEEDED');
    f.runtime.removeTerminalRun(run.id);
    expect(f.runtime.findMessageSubmission(f.session.id, 'target')).toMatchObject({
      kind: 'run',
      run: { id: run.id, status: 'SUCCEEDED' }
    });
    expect(f.runtime.findMessageRun(f.session.id, 'target')).toBeUndefined();
  });

  it.each(['conversation', 'queue', 'continuation'] as const)(
    'settles accepted input and clears temporary images when the %s observer throws',
    async (observer) => {
      const clearImages = vi.fn();
      const emitRun = vi.fn(() => {
        if (observer === 'conversation') throw new Error('observer failed');
      });
      const emitQueue = vi.fn(() => {
        if (observer === 'queue') throw new Error('observer failed');
      });
      const f = fixture({
        steer: async () => ({
          status: 'accepted',
          item: {
            itemId: 'accepted',
            kind: 'user_message',
            status: 'COMPLETED',
            payload: { text: 'guidance' }
          }
        }),
        clearImages,
        afterExecutionSteered: async () => {
          if (observer === 'continuation') throw new Error('continuation failed');
        },
        emitRun,
        emitQueue,
        stopped: () => false
      });
      const { run, execution } = f.start();
      const item = f.queue('target');
      const accepted = vi.fn();
      try {
        expect(
          await f.coordinator.settle({
            submissionId: item.id,
            intent: 'REPLACE_CURRENT',
            queueBefore: item.queueBefore,
            activeRunId: run.id,
            steerTarget: { turnId: execution.turnId, executionId: execution.id },
            onNativeAccepted: accepted
          })
        ).toBe('ACCEPTED');
        expect(accepted).toHaveBeenCalledOnce();
        expect(clearImages).toHaveBeenCalledWith(item.id);
        expect(emitRun).toHaveBeenCalledOnce();
        expect(emitQueue).toHaveBeenCalledOnce();
        expect(f.runtime.getQueueItem(item.id)).toBeUndefined();
        expect(f.runtime.currentExecutionId(run.id)).toBe(execution.id);
        expect(f.control).not.toHaveBeenCalled();
      } finally {
        f.coordinator.suspend();
      }
    }
  );

  it('falls back only on explicit nonacceptance and keeps a handled input from being resent', async () => {
    for (const status of ['handled', 'notAccepted'] as const) {
      const f = fixture({ steer: async () => ({ status }), stopped: () => false });
      const { execution } = f.start();
      const item = f.queue('target');
      await f.coordinator.executeQueueItem(item.id);
      f.coordinator.suspend();
      if (status === 'handled') {
        expect(f.control).not.toHaveBeenCalled();
        expect(f.runtime.getQueueItem(item.id)).toBeUndefined();
      } else {
        expect(f.control).toHaveBeenCalledWith('run.interrupt', { runId: execution.id });
        expect(f.runtime.getQueueItem(item.id)).toBeDefined();
      }
    }
  });

  it('does not interrupt on a failed admission or resend a nonaccepted item during shutdown', async () => {
    const admission =
      Promise.withResolvers<import('../../src/runner/abstract-runner.js').RunnerSteerResult>();
    const f = fixture({ steer: () => admission.promise, stopped: () => false });
    f.start();
    const item = f.queue('target');
    const attempt = f.coordinator.executeQueueItem(item.id);
    f.coordinator.suspend();
    admission.resolve({ status: 'notAccepted' });
    expect(await attempt).toMatchObject({ delivery: 'QUEUED' });
    expect(f.control).not.toHaveBeenCalled();
    expect(f.runtime.getQueueItem(item.id)).toBeDefined();
    expect(() => f.runtime.updateQueueItem(item.id, 'retry')).not.toThrow();
  });
  it.each([false, true])(
    'turns queued input into steering without duplicating it on repeated Run (started: %s)',
    (started) => {
      const f = fixture();
      const { execution } = f.start();
      if (started) f.coordinator.executionStarted(execution.id);
      const item = f.queue('queued');
      f.coordinator.executeQueueItem(item.id);
      f.coordinator.executeQueueItem(item.id);
      expect(item.prepareSteerInput).toHaveBeenCalledOnce();
      expect(f.coordinator.pending(item.id)?.input).toBe(
        `${started ? '' : 'Original task\n\n'}${steerComposerMessage('Additional context')}`
      );
      expect(f.runtime.getQueueItem(item.id)?.content).toBe('Additional context');
      expect(f.control).toHaveBeenCalledWith('run.interrupt', { runId: execution.id });
    }
  );

  it('does not turn idle queue execution into steering and retains queue priority', () => {
    const f = fixture();
    const older = f.queue('older');
    const item = f.queue('selected');
    f.runtime.pauseSessionQueue(f.session.id);
    f.coordinator.executeQueueItem(item.id);
    const run = f.runtime.activeSessionRun(f.session.id)!;
    expect(f.coordinator.pending(run.id)?.input).toBe('Additional context');
    expect(f.runtime.sessionQueue(f.session.id)).toMatchObject({
      paused: false,
      itemIds: [older.id]
    });
    expect(item.prepareSteerInput).not.toHaveBeenCalled();
    expect(f.control).not.toHaveBeenCalled();
  });

  it('uses the latest edited queued text when it is later run as steering', () => {
    const f = fixture();
    const { execution } = f.start();
    f.coordinator.executionStarted(execution.id);
    const item = f.queue('edited');
    const service = new WorkspaceQueueWorkbenchService({
      runtime: f.runtime,
      resolve: async (id) => f.runtime.getAgentSession(id),
      coordinator: f.coordinator,
      emit: () => undefined,
      prepareInput: (_runner, input) => input
    });
    const content = `Edited context\n${serializeComposerTag('mar_references', { references: [{ type: 'file', path: 'src/main.ts', label: 'main.ts' }] })}`;
    service.operations()['workspace.queue.message.update']?.({
      workspaceId: 'workspace',
      queueItemId: item.id,
      content
    });
    f.coordinator.executeQueueItem(item.id);
    const input = f.coordinator.pending(item.id)!.input;
    expect(composerVisibleText(input)).toBe('Edited context');
    expect(parseComposerTags(input)).toContainEqual(
      expect.objectContaining({
        kind: 'mar_steer',
        payload: { message: 'Edited context' },
        raw: expect.stringContaining('<instruction>')
      })
    );
    expect(parseComposerTags(input)).toContainEqual(
      expect.objectContaining({
        kind: 'mar_references',
        payload: {
          references: [
            { type: 'file', path: 'src/main.ts', label: 'main.ts', runnerPath: 'src/main.ts' }
          ]
        }
      })
    );
    expect(f.runtime.getQueueItem(item.id)?.content).toBe(content);
  });

  it('steers an immediately run queue item while waiting for a command without cancelling it', () => {
    const f = fixture();
    f.runtime.adoptRun({
      runId: 'command',
      sessionId: f.session.id,
      runner: 'codex',
      cwd: '/workspace',
      externalSessionId: 'native'
    });
    const item = f.queue('queued');
    f.coordinator.executeQueueItem(item.id);
    expect(f.coordinator.pending(item.id)?.input).toBe(steerComposerMessage('Additional context'));
    expect(f.control).not.toHaveBeenCalled();
  });

  it('prepares queue steering before changing queue state or interrupting work', async () => {
    const f = fixture();
    f.start();
    const item = f.queue('oversized', '字'.repeat(50_000));
    const before = f.runtime.sessionQueue(f.session.id);
    await expect(f.coordinator.executeQueueItem(item.id)).rejects.toThrow('COMPOSER_TAG_INVALID');
    expect(f.runtime.sessionQueue(f.session.id)).toEqual(before);
    expect(f.coordinator.isImmediate(item.id)).toBe(false);
    expect(f.control).not.toHaveBeenCalled();
  });

  it('wraps an active supplement once while leaving public input unchanged', () => {
    const f = fixture();
    const { run, execution } = f.start();
    f.coordinator.executionStarted(execution.id);
    const item = f.queue('supplement');
    const input = {
      submissionId: item.id,
      intent: 'REPLACE_CURRENT' as const,
      queueBefore: item.queueBefore,
      activeRunId: run.id,
      steerTarget: { turnId: execution.turnId, executionId: execution.id }
    };
    expect(f.coordinator.settle(input)).toBe('ACCEPTED');
    expect(f.coordinator.pending(item.id)?.input).toBe(steerComposerMessage('Additional context'));
    expect(f.runtime.getQueueItem(item.id)?.content).toBe('Additional context');
    expect(f.control).toHaveBeenCalledWith('run.interrupt', { runId: execution.id });
    f.coordinator.settle(input);
    expect(item.prepareSteerInput).toHaveBeenCalledOnce();
  });

  it('keeps an unstarted task outside the supplement and retains it after editing', () => {
    const f = fixture();
    const { run, execution } = f.start();
    const item = f.queue('supplement');
    f.coordinator.settle({
      submissionId: item.id,
      intent: 'REPLACE_CURRENT',
      queueBefore: item.queueBefore,
      activeRunId: run.id,
      steerTarget: { turnId: execution.turnId, executionId: execution.id }
    });
    expect(f.coordinator.pending(item.id)?.input).toBe(
      `Original task\n\n${steerComposerMessage('Additional context')}`
    );
    f.coordinator.updatePreparedInput(item.id, steerComposerMessage('Corrected context'));
    const pending = f.coordinator.pending(item.id)!;
    expect(pending.steering).toBe(true);
    expect(pending.input).toBe(`Original task\n\n${steerComposerMessage('Corrected context')}`);
    expect(composerVisibleText(pending.input)).toBe('Original task\n\nCorrected context');
  });

  it('uses ordinary SEND behavior when idle, including a paused existing queue', async () => {
    const f = fixture();
    const old = f.queue('old', 'Older queued input');
    f.runtime.pauseSessionQueue(f.session.id);
    const item = f.queue('new');
    expect(
      await f.coordinator.settle({
        submissionId: item.id,
        intent: 'REPLACE_CURRENT',
        queueBefore: item.queueBefore,
        steerTarget: { turnId: undefined, executionId: undefined }
      })
    ).toBe('STARTED');
    expect(f.runtime.sessionQueue(f.session.id)).toMatchObject({
      paused: false,
      itemIds: [old.id]
    });
    const run = f.runtime.activeSessionRun(f.session.id)!;
    expect(f.coordinator.pending(run.id)?.input).toBe('Additional context');
    expect(f.runtime.conversationTurnForRun(run.id)?.items).toContainEqual(
      expect.objectContaining({
        kind: 'user_message',
        payload: expect.objectContaining({ text: 'Additional context' })
      })
    );
    expect(item.prepareSteerInput).not.toHaveBeenCalled();
    expect(f.control).not.toHaveBeenCalled();
  });

  it('keeps ordinary delivery while the initial input has no replaceable Execution yet', () => {
    const f = fixture();
    const run = f.runtime.createMessageRun({
      sessionId: f.session.id,
      clientMessageId: 'preparing',
      content: 'Original task'
    }).run;
    f.prepare(run.id, 'Original task');
    const item = f.queue('supplement');
    expect(
      f.coordinator.settle({
        submissionId: item.id,
        intent: 'REPLACE_CURRENT',
        queueBefore: item.queueBefore,
        activeRunId: run.id,
        steerTarget: {
          turnId: f.runtime.conversationTurnForRun(run.id)!.id,
          executionId: undefined
        }
      })
    ).toBe('QUEUED');
    expect(f.coordinator.pending(run.id)?.input).toBe('Original task');
    expect(f.coordinator.pending(item.id)?.input).toBe('Additional context');
    expect(item.prepareSteerInput).not.toHaveBeenCalled();
    expect(f.control).not.toHaveBeenCalled();
  });

  it('does not interrupt a later Execution in the same continuous Run', () => {
    const f = fixture();
    const { run, execution } = f.start();
    const later = f.queue('later', 'Next task');
    const item = f.queue('supplement');
    f.runtime.appendRunEvent({
      runId: execution.id,
      sequence: 1,
      eventType: 'run.completed',
      payload: {},
      status: 'SUCCEEDED'
    });
    expect(f.runtime.claimNextQueueItem(f.session.id)?.item.id).toBe(later.id);
    const next = f.runtime.createExecution(run.id);
    f.coordinator.settle({
      submissionId: item.id,
      intent: 'REPLACE_CURRENT',
      queueBefore: item.queueBefore,
      activeRunId: run.id,
      steerTarget: { turnId: execution.turnId, executionId: execution.id }
    });
    expect(f.runtime.currentExecutionId(run.id)).toBe(next.id);
    expect(f.coordinator.pending(item.id)?.steering).toBeUndefined();
    expect(item.prepareSteerInput).not.toHaveBeenCalled();
    expect(f.control).not.toHaveBeenCalled();
  });

  it('does not wrap ordinary queued input or internal replacement operations', () => {
    const f = fixture();
    const { run, execution } = f.start();
    f.coordinator.executionStarted(execution.id);
    for (const intent of ['QUEUE', 'REPLACE_CURRENT'] as const) {
      const item = f.queue(intent);
      f.coordinator.settle({
        submissionId: item.id,
        intent,
        queueBefore: item.queueBefore,
        ...(intent === 'REPLACE_CURRENT' ? { activeRunId: run.id } : {})
      });
      expect(f.coordinator.pending(item.id)?.input).toBe('Additional context');
      expect(item.prepareSteerInput).not.toHaveBeenCalled();
    }
  });

  it('wraps user information during an immediate command without cancelling the command', () => {
    const f = fixture();
    const run = f.runtime.adoptRun({
      runId: 'command',
      sessionId: f.session.id,
      runner: 'codex',
      cwd: '/workspace',
      externalSessionId: 'native'
    });
    const item = f.queue('supplement');
    expect(
      f.coordinator.settle({
        submissionId: item.id,
        intent: 'REPLACE_CURRENT',
        queueBefore: item.queueBefore,
        activeRunId: run.id,
        steerTarget: { turnId: undefined, executionId: undefined }
      })
    ).toBe('QUEUED');
    expect(f.coordinator.pending(item.id)?.input).toBe(steerComposerMessage('Additional context'));
    expect(f.runtime.sessionQueue(f.session.id).itemIds[0]).toBe(item.id);
    expect(f.control).not.toHaveBeenCalled();
  });
});
