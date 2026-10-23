import { describe, expect, it, vi } from 'vitest';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { RunWorkbenchService } from '../../src/service/run-workbench-service.js';
import { SessionMessageService } from '../../src/service/session-message-service.js';
import { WorkspaceQueueWorkbenchService } from '../../src/service/workspace-queue-workbench-service.js';
import { withNonImageAttachmentPrompt } from '../../src/util/node-operation-parsers.js';
import { steerComposerMessage } from '@myagentroam/protocol';
import * as operational from '../../src/operational.js';

function preparedRuntime(now: () => number = () => 100): NodeRuntimeState {
  return new NodeRuntimeState(
    () => 'node-queue',
    (id) =>
      id === 'workspace-1'
        ? {
            id,
            path: '/workspace',
            kind: 'DIRECTORY',
            gitSummary: null,
            createdAt: 1,
            updatedAt: 1
          }
        : undefined,
    now
  );
}

function session(
  runtime: NodeRuntimeState,
  runner: 'codex' | 'claude-code' | 'opencode' | 'mar-agent' = 'codex'
) {
  return runtime.createAgentSession({ workspaceId: 'workspace-1', runner, cwd: '/workspace' });
}

describe('Node Session message FIFO', () => {
  it.each(['SUCCEEDED', 'FAILED', 'INTERRUPTED'] as const)(
    'retains first, FIFO and native-steer identities after %s resource cleanup',
    (status) => {
      const runtime = preparedRuntime();
      const current = session(runtime);
      const run = runtime.createMessageRun({
        sessionId: current.id,
        clientMessageId: 'first',
        content: 'First'
      }).run;
      runtime.createQueueItem({ sessionId: current.id, clientMessageId: 'fifo', content: 'Next' });
      runtime.claimNextQueueItem(current.id);
      const item = runtime.createQueueItem({
        sessionId: current.id,
        clientMessageId: 'steer',
        content: 'Context'
      }).item;
      const release = runtime.reserveQueueItem(item.id);
      runtime.consumeSteeredQueueItem(item.id, run.id);
      release();
      runtime.finishRun(run.id, status);
      runtime.removeTerminalRun(run.id);
      for (const id of ['first', 'fifo', 'steer']) {
        expect(runtime.findMessageSubmission(current.id, id)).toMatchObject({
          kind: 'run',
          run: { id: run.id, status }
        });
        expect(runtime.findMessageRun(current.id, id)).toBeUndefined();
      }
      expect(runtime.getRun(run.id)).toBeUndefined();
      expect(runtime.activeSessionRun(current.id)).toBeUndefined();
      const other = session(runtime);
      expect(runtime.findMessageSubmission(other.id, 'first')).toBeUndefined();
      runtime.promoteSessionIdentity(current.id, 'native-retained');
      expect(runtime.findMessageSubmission('native-retained', 'fifo')).toMatchObject({
        run: { id: run.id, sessionId: 'native-retained' }
      });
      expect(runtime.findMessageSubmission(current.id, 'fifo')).toBeUndefined();
    }
  );

  it.each(['history', 'session', 'workspace'] as const)(
    'releases terminal receipts on %s removal',
    (scope) => {
      const runtime = preparedRuntime();
      const current = session(runtime);
      const run = runtime.createMessageRun({
        sessionId: current.id,
        clientMessageId: 'first',
        content: 'First'
      }).run;
      runtime.finishRun(run.id, 'SUCCEEDED');
      runtime.removeTerminalRun(run.id);
      if (scope === 'history') runtime.resetAgentSessionHistory(current.id, 200);
      else if (scope === 'session') runtime.removeAgentSession(current.id);
      else runtime.removeWorkspace(current.workspaceId);
      expect(runtime.findMessageSubmission(current.id, 'first')).toBeUndefined();
    }
  );

  it('bounds terminal receipts per message even when a continuous Run outlives the Turn window', () => {
    const runtime = preparedRuntime();
    const current = session(runtime);
    const run = runtime.createMessageRun({
      sessionId: current.id,
      clientMessageId: 'first',
      content: 'First'
    }).run;
    for (let index = 0; index < 1_025; index++) {
      const item = runtime.createQueueItem({
        sessionId: current.id,
        clientMessageId: `message-${index}`,
        content: 'Context'
      }).item;
      const release = runtime.reserveQueueItem(item.id);
      runtime.consumeSteeredQueueItem(item.id, run.id);
      release();
    }
    runtime.finishRun(run.id, 'SUCCEEDED');
    runtime.removeTerminalRun(run.id);
    expect(runtime.findMessageSubmission(current.id, 'first')).toBeUndefined();
    expect(runtime.findMessageSubmission(current.id, 'message-0')).toBeUndefined();
    expect(runtime.findMessageSubmission(current.id, 'message-1')).toMatchObject({
      run: { id: run.id }
    });
    expect(runtime.findMessageSubmission(current.id, 'message-1024')).toMatchObject({
      run: { id: run.id }
    });
    // Runs without message receipts can evict the retained summary first.
    for (let index = 0; index < 1_024; index++) {
      const next = runtime.adoptRun({
        runId: `envelope-${index}`,
        sessionId: current.id,
        runner: current.runner,
        cwd: current.cwd
      });
      runtime.finishRun(next.id, 'SUCCEEDED');
      runtime.removeTerminalRun(next.id);
    }
    expect(runtime.findMessageSubmission(current.id, 'message-1024')).toBeUndefined();
  });

  it.each(['resume', 'publish'] as const)(
    'settles a background command-queue %s failure without an unhandled rejection',
    async (stage) => {
      const runtime = preparedRuntime();
      const current = session(runtime);
      runtime.pauseSessionQueue(current.id);
      const error = Object.assign(new Error('Queue resume fixture failure'), {
        code: 'QUEUE_FIXTURE_FAILURE'
      });
      const log = vi.spyOn(operational, 'nodeLog').mockImplementation(() => undefined);
      const emit = vi.fn(() => {
        if (stage === 'publish') throw error;
      });
      const resume = vi.fn(async () => {
        if (stage === 'resume') throw error;
        runtime.resumeSessionQueue(current.id);
      });
      const service = new WorkspaceQueueWorkbenchService({
        runtime,
        resolve: async (id) => runtime.getAgentSession(id),
        coordinator: { resume } as never,
        emit,
        prepareInput: (_runner, input) => input
      });
      try {
        service.resumeAfterCommandRun(current.id);
        await vi.waitFor(() =>
          expect(log).toHaveBeenCalledWith('queue.resume.failed', {
            sessionId: current.id,
            code: 'QUEUE_FIXTURE_FAILURE'
          })
        );
        expect(resume).toHaveBeenCalledOnce();
        expect(emit).toHaveBeenCalledTimes(stage === 'publish' ? 1 : 0);
        expect(runtime.sessionQueue(current.id).paused).toBe(stage === 'resume');
      } finally {
        log.mockRestore();
      }
    }
  );

  it.each([true, false])(
    'uses the claimed input notification policy in a continuous Run (%s)',
    (silent) => {
      const runtime = preparedRuntime();
      const current = session(runtime);
      const active = runtime.createMessageRun({
        sessionId: current.id,
        clientMessageId: 'active',
        content: 'active task',
        suppressNotifications: !silent
      }).run;
      const queued = runtime.createQueueItem({
        sessionId: current.id,
        clientMessageId: 'queued',
        content: 'next task',
        suppressNotifications: silent
      }).item;
      expect(runtime.claimNextQueueItem(current.id)?.item.id).toBe(queued.id);
      expect(runtime.getRun(active.id)?.suppressNotifications === true).toBe(silent);
    }
  );

  it('preserves notification suppression when a queued input starts a fresh Run', () => {
    const runtime = preparedRuntime();
    const current = session(runtime);
    const queued = runtime.createQueueItem({
      sessionId: current.id,
      clientMessageId: 'queued',
      content: 'delegated task',
      suppressNotifications: true
    }).item;
    expect(runtime.startRunFromQueueItem(queued.id).run.suppressNotifications).toBe(true);
  });

  it.each(
    (['codex', 'claude-code', 'opencode', 'mar-agent'] as const).flatMap((runner) =>
      ['New session', 'Untitled session', 'New session - 2026-08-29T06:30:00.000Z'].map(
        (title) => ({ runner, title })
      )
    )
  )(
    'replaces the restored $runner placeholder $title with a user-message title',
    ({ runner, title }) => {
      const runtime = preparedRuntime();
      const restored = runtime.createAgentSession({
        workspaceId: 'workspace-1',
        runner,
        externalSessionId: 'restored',
        cwd: '/workspace',
        title
      });
      expect(runtime.setTemporaryTitleIfMissing(restored.id, '  First\nmessage  ')).toMatchObject({
        runnerTitle: 'First message',
        titleSource: 'AUTO'
      });
      runtime.setRunnerTitleFromNative(restored.id, 'Generated title');
      expect(runtime.setTemporaryTitleIfMissing(restored.id, 'Later message').runnerTitle).toBe(
        'Generated title'
      );
      runtime.updateSessionMetadata({ sessionId: restored.id, customTitle: 'New session' });
      expect(runtime.setTemporaryTitleIfMissing(restored.id, 'Later message').customTitle).toBe(
        'New session'
      );
    }
  );

  it.each(['codex', 'claude-code', 'opencode', 'mar-agent'] as const)(
    ' %s preserves the first user message as a temporary title before the actual Runner title is generated',
    (runner) => {
      const runtime = preparedRuntime();
      const current = runtime.createAgentSession({
        workspaceId: 'workspace-1',
        runner,
        cwd: '/workspace',
        title: 'inspect the current project'
      });

      const placeholder =
        runner === 'opencode' ? 'New session - 2026-08-29T06:30:00.000Z' : 'New session';
      expect(runtime.setRunnerTitleFromNative(current.id, placeholder)).toMatchObject({
        runnerTitle: 'inspect the current project',
        titleSource: 'AUTO'
      });
      expect(
        runtime.setRunnerTitleFromNative(current.id, 'Project architecture review')
      ).toMatchObject({
        runnerTitle: 'Project architecture review',
        titleSource: 'RUNNER'
      });
    }
  );

  it('rejects Hosted Conversation namespaces for ordinary Run image reads', async () => {
    const readImage = vi.fn(async () => ({
      name: 'generated.png',
      mime: 'image/png',
      dataBase64: Buffer.from('hosted-image').toString('base64')
    }));
    const service = new RunWorkbenchService({
      runtime: preparedRuntime(),
      readImage,
      respondUserInput: vi.fn(),
      pauseQueue: vi.fn(),
      runInterrupted: vi.fn(),
      emitRun: vi.fn(),
      control: vi.fn(),
      markInterrupted: vi.fn()
    });

    await expect(
      service.operations()['run.image.read']?.({
        runId: 'native-history:hosted:conversation-1',
        imageIndex: 0
      })
    ).rejects.toThrow('RUN_IMAGE_INVALID');
    expect(readImage).not.toHaveBeenCalled();
  });

  it('rejects Run control, question answers, and approval decisions from non-initiating users', () => {
    const runtime = preparedRuntime();
    const current = session(runtime);
    const run = runtime.createMessageRun({
      sessionId: current.id,
      clientMessageId: 'owned-run',
      content: 'start',
      initiatedByUserId: 7
    }).run;
    const execution = runtime.createExecution(run.id);
    runtime.createApproval({
      runId: execution.id,
      approvalId: 'approval-1',
      payload: {},
      expiresAt: 2_000
    });
    const respondUserInput = vi.fn();
    const control = vi.fn();
    const service = new RunWorkbenchService({
      runtime,
      readImage: async () => undefined,
      respondUserInput,
      pauseQueue: vi.fn(),
      runInterrupted: vi.fn(),
      emitRun: vi.fn(),
      control,
      markInterrupted: vi.fn()
    });
    const operations = service.operations();

    expect(() => operations['run.interrupt']?.({ runId: run.id, __requestUserId: 8 })).toThrow(
      'RUN_OWNED_BY_ANOTHER_USER'
    );
    expect(() =>
      operations['run.user-input.respond']?.({
        runId: run.id,
        requestId: 'input-1',
        answers: {},
        __requestUserId: 8
      })
    ).toThrow('RUN_OWNED_BY_ANOTHER_USER');
    expect(() =>
      operations['run.approval.decide']?.({
        runId: run.id,
        approvalId: 'approval-1',
        decision: 'APPROVED',
        __requestUserId: 8
      })
    ).toThrow('RUN_OWNED_BY_ANOTHER_USER');
    expect(runtime.getApproval('approval-1')?.status).toBe('PENDING');

    operations['run.user-input.respond']?.({
      runId: run.id,
      requestId: 'input-1',
      answers: {},
      __requestUserId: 7
    });
    expect(respondUserInput).toHaveBeenCalledWith(execution.id, 'input-1', {});

    operations['run.approval.decide']?.({
      runId: run.id,
      approvalId: 'approval-1',
      decision: 'APPROVED',
      __requestUserId: 7
    });
    expect(control).toHaveBeenCalledWith('run.approval.decision', {
      runId: execution.id,
      approvalId: 'approval-1',
      decision: 'APPROVED'
    });
  });

  it('clears Goal state even when Runner interrupt control throws', () => {
    const runtime = preparedRuntime();
    const current = session(runtime);
    const run = runtime.createMessageRun({
      sessionId: current.id,
      clientMessageId: 'interrupt-failure',
      content: 'start'
    }).run;
    runtime.createExecution(run.id);
    const runInterrupted = vi.fn();
    const service = new RunWorkbenchService({
      runtime,
      readImage: async () => undefined,
      respondUserInput: vi.fn(),
      pauseQueue: vi.fn(),
      runInterrupted,
      emitRun: vi.fn(),
      control: () => {
        throw new Error('control failed');
      },
      markInterrupted: vi.fn()
    });

    expect(() => service.operations()['run.interrupt']?.({ runId: run.id })).toThrow(
      'control failed'
    );
    expect(runInterrupted).toHaveBeenCalledWith(current.id);
  });

  it('validates Workspace ownership and active Run ownership for QueueItem mutations', () => {
    const runtime = preparedRuntime();
    const current = session(runtime);
    runtime.createMessageRun({
      sessionId: current.id,
      clientMessageId: 'active',
      content: 'start',
      initiatedByUserId: 7
    });
    const item = runtime.createQueueItem({
      sessionId: current.id,
      clientMessageId: 'queued',
      content: 'continue',
      initiatedByUserId: 7
    }).item;
    const service = new WorkspaceQueueWorkbenchService({
      runtime,
      resolve: async (id) => runtime.getAgentSession(id),
      coordinator: {} as never,
      emit: vi.fn(),
      prepareInput: (_runner, input) => input
    });
    const update = service.operations()['workspace.queue.message.update'];

    expect(() =>
      update?.({
        queueItemId: item.id,
        workspaceId: 'workspace-other',
        content: 'outside scope',
        __requestUserId: 7
      })
    ).toThrow('QUEUE_ITEM_INVALID');
    expect(() =>
      update?.({
        queueItemId: item.id,
        workspaceId: item.workspaceId,
        content: 'unauthorized',
        __requestUserId: 8
      })
    ).toThrow('RUN_OWNED_BY_ANOTHER_USER');
    expect(runtime.getQueueItem(item.id)?.content).toBe('continue');
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true]
  ])(
    'preserves QueueItem resources and steering when editing (nested cwd: %s, steering: %s)',
    (nested, steering) => {
      const runtime = preparedRuntime();
      const current = runtime.createAgentSession({
        workspaceId: 'workspace-1',
        runner: 'codex',
        cwd: nested ? '/workspace/subdir' : '/workspace'
      });
      runtime.createMessageRun({
        sessionId: current.id,
        clientMessageId: 'active',
        content: 'start',
        initiatedByUserId: 7
      });
      const item = runtime.createQueueItem({
        sessionId: current.id,
        clientMessageId: 'queued-with-attachment',
        content: 'old content',
        initiatedByUserId: 7
      }).item;
      const attachmentPath = '.mar/temp-files/queued/notes.pdf';
      const attachmentFiles = [
        {
          name: 'notes.pdf',
          mime: 'application/pdf',
          path: nested ? `../${attachmentPath}` : attachmentPath,
          ...(nested ? { workspacePath: attachmentPath } : {})
        }
      ];
      const updatePreparedInput = vi.fn();
      const service = new WorkspaceQueueWorkbenchService({
        runtime,
        resolve: async (id) => runtime.getAgentSession(id),
        coordinator: {
          pending: vi.fn(() => ({
            runner: 'codex',
            steering,
            prepareSteerInput: () => 'old input',
            attachmentPaths: [attachmentPath],
            attachmentFiles,
            collaborationMode: 'default'
          })),
          updatePreparedInput
        } as never,
        emit: vi.fn(),
        prepareInput: (runner, input, mode) => `${runner}:${mode}:${input}`
      });

      service.operations()['workspace.queue.message.update']?.({
        queueItemId: item.id,
        workspaceId: item.workspaceId,
        content: '  new content  ',
        __requestUserId: 7
      });

      expect(runtime.getQueueItem(item.id)?.content).toBe('new content');
      expect(updatePreparedInput).toHaveBeenCalledWith(
        item.id,
        `codex:default:${withNonImageAttachmentPrompt(steering ? steerComposerMessage('new content') : 'new content', [attachmentPath], attachmentFiles)}`,
        expect.any(Function)
      );
      const prepareSteerInput = updatePreparedInput.mock.calls[0]?.[2] as () => string;
      expect(prepareSteerInput()).toBe(
        `codex:default:${withNonImageAttachmentPrompt(steerComposerMessage('new content'), [attachmentPath], attachmentFiles)}`
      );
    }
  );

  it('keeps queued text and prepared input unchanged when steering preparation fails', () => {
    const runtime = preparedRuntime();
    const current = session(runtime);
    const item = runtime.createQueueItem({
      sessionId: current.id,
      clientMessageId: 'steering-edit',
      content: 'old content'
    }).item;
    const updatePreparedInput = vi.fn();
    const emit = vi.fn();
    const service = new WorkspaceQueueWorkbenchService({
      runtime,
      resolve: async (id) => runtime.getAgentSession(id),
      coordinator: {
        pending: () => ({
          runner: 'codex',
          steering: true,
          attachmentPaths: [],
          collaborationMode: 'default'
        }),
        updatePreparedInput
      } as never,
      emit,
      prepareInput: (_runner, input) => input
    });
    const before = runtime.sessionQueue(current.id);
    expect(() =>
      service.operations()['workspace.queue.message.update']?.({
        queueItemId: item.id,
        workspaceId: item.workspaceId,
        content: '字'.repeat(50_000)
      })
    ).toThrow('COMPOSER_TAG_INVALID');
    expect(runtime.getQueueItem(item.id)?.content).toBe('old content');
    expect(runtime.sessionQueue(current.id)).toEqual(before);
    expect(updatePreparedInput).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('returns a schema-shaped audit receipt for a queue edit', () => {
    const runtime = preparedRuntime();
    const current = session(runtime);
    const item = runtime.createQueueItem({
      sessionId: current.id,
      clientMessageId: 'queued-audit',
      content: 'Old content'
    }).item;
    const service = new WorkspaceQueueWorkbenchService({
      runtime,
      resolve: async (id) => runtime.getAgentSession(id),
      coordinator: { pending: vi.fn(() => undefined) } as never,
      emit: vi.fn(),
      prepareInput: (_runner, input) => input
    });

    expect(
      service.operations()['workspace.queue.message.update']?.({
        queueItemId: item.id,
        workspaceId: item.workspaceId,
        content: 'Updated content'
      })
    ).toMatchObject({
      auditReceipt: {
        sessionId: current.id,
        queueItemId: item.id,
        inputMode: 'EDIT_QUEUE'
      }
    });
  });

  it('returns audit receipts for every queue mutation but never for queue reads', async () => {
    const runtime = preparedRuntime();
    const current = session(runtime);
    const item = runtime.createQueueItem({
      sessionId: current.id,
      clientMessageId: 'queued-audit-mutations',
      content: 'Queued content'
    }).item;
    const coordinator = {
      resume: vi.fn(),
      deleteQueueItem: vi.fn(),
      executeQueueItem: vi.fn(() => ({ run: { id: 'run-1' } }))
    };
    const service = new WorkspaceQueueWorkbenchService({
      runtime,
      resolve: async (id) => runtime.getAgentSession(id),
      coordinator: coordinator as never,
      emit: vi.fn(),
      prepareInput: (_runner, input) => input
    });
    const operations = service.operations();

    expect(
      await operations['workspace.queue.get']?.({
        workspaceId: 'workspace-1',
        sessionId: current.id
      })
    ).not.toHaveProperty('auditReceipt');
    expect(
      await operations['workspace.queue.pause']?.({
        workspaceId: 'workspace-1',
        sessionId: current.id
      })
    ).toMatchObject({ auditReceipt: { sessionId: current.id, inputMode: 'PAUSE_QUEUE' } });
    expect(
      await operations['workspace.queue.resume']?.({
        workspaceId: 'workspace-1',
        sessionId: current.id
      })
    ).toMatchObject({ auditReceipt: { sessionId: current.id, inputMode: 'RESUME_QUEUE' } });
    expect(
      operations['workspace.queue.reorder']?.({
        workspaceId: 'workspace-1',
        sessionId: current.id,
        expectedVersion: runtime.sessionQueue(current.id).version,
        queueItemIds: [item.id]
      })
    ).toMatchObject({ auditReceipt: { sessionId: current.id, inputMode: 'REORDER_QUEUE' } });
    expect(
      operations['workspace.queue.message.delete']?.({
        workspaceId: 'workspace-1',
        queueItemId: item.id
      })
    ).toMatchObject({
      auditReceipt: { sessionId: current.id, queueItemId: item.id, inputMode: 'DELETE_QUEUE' }
    });
    expect(
      await operations['workspace.queue.message.execute']?.({
        workspaceId: 'workspace-1',
        queueItemId: item.id
      })
    ).toMatchObject({
      auditReceipt: { sessionId: current.id, queueItemId: item.id, inputMode: 'EXECUTE_QUEUE' }
    });
  });

  it('preserves a non-object queue execution result alongside its audit receipt', async () => {
    const runtime = preparedRuntime();
    const current = session(runtime);
    const item = runtime.createQueueItem({
      sessionId: current.id,
      clientMessageId: 'queued-primitive-result',
      content: 'Queued content'
    }).item;
    const service = new WorkspaceQueueWorkbenchService({
      runtime,
      resolve: async (id) => runtime.getAgentSession(id),
      coordinator: { executeQueueItem: vi.fn(async () => 'QUEUED') } as never,
      emit: vi.fn(),
      prepareInput: (_runner, input) => input
    });

    expect(
      await service.operations()['workspace.queue.message.execute']?.({
        workspaceId: item.workspaceId,
        queueItemId: item.id
      })
    ).toMatchObject({
      result: 'QUEUED',
      auditReceipt: { sessionId: current.id, queueItemId: item.id, inputMode: 'EXECUTE_QUEUE' }
    });
  });

  it.each(
    [undefined, false, true].flatMap((activated) =>
      ['QUEUE', 'REPLACE_CURRENT'].map((intent) => ({ activated, intent }))
    )
  )(
    'releases reserved Composer attachments on receipt failure (Goal activation: $activated, intent: $intent)',
    async ({ activated, intent }) => {
      const runtime = preparedRuntime();
      const current = session(runtime);
      const active = runtime.createMessageRun({
        sessionId: current.id,
        clientMessageId: 'active-message',
        content: 'current message'
      }).run;
      const commit = vi.fn();
      const release = vi.fn();
      const adoptSessionFiles = vi.fn();
      const settle = vi.fn((_input: unknown) => {
        throw new Error('RUN_EXECUTION_NOT_FOUND');
      });
      const coordinator = {
        accept(input: {
          runId: string;
          sessionId: string;
          clientMessageId: string;
          content: string;
        }) {
          const created = runtime.createQueueItem({
            queueItemId: input.runId,
            sessionId: input.sessionId,
            clientMessageId: input.clientMessageId,
            content: input.content
          });
          return { run: active, queueItem: created.item, created: created.created };
        },
        prepare: vi.fn(),
        settle,
        failPreparation: vi.fn(),
        publishCurrentTurn: vi.fn()
      };
      const service = new SessionMessageService({
        runtime,
        uploads: {
          reserve: vi.fn(async () => ({
            attachments: [
              {
                attachment: {
                  name: 'notes.pdf',
                  mime: 'application/pdf',
                  dataBase64: 'cGRm'
                },
                path: '/node-data/temp-files/composer-attachment/notes.pdf',
                resourcePath: '.mar/temp-files/composer-attachment/notes.pdf'
              }
            ],
            commit,
            release
          }))
        } as never,
        attachments: {
          protectSession: vi.fn(() => () => undefined),
          retainSessionFiles: vi.fn(),
          adoptSessionFiles,
          acceptSessionInput: vi.fn(),
          discardFiles: vi.fn(async () => undefined),
          persistFiles: vi.fn(async () => ['.mar/temp-files/queued-message/notes.pdf']),
          cache: vi.fn(),
          clear: vi.fn(),
          cleanup: vi.fn()
        } as never,
        commands: { list: () => [] } as never,
        coordinator: coordinator as never,
        runners: {
          require: () => ({
            prepareMessageInput: (input: string) => input,
            serviceTier: () => undefined
          })
        } as never,
        resolve: async () => ({
          session: current
        }),
        present: (value) => value,
        emitSession: () => undefined,
        channelToken: () => undefined,
        goalMessage: (_session, content) =>
          activated === undefined
            ? undefined
            : {
                runnerContent: content,
                goal: { id: 'goal', revision: 1, epoch: 1 },
                activated
              },
        prepareGoalInsertion: () => true,
        goalPreparationFailed: () => undefined
      });

      await expect(
        service.operations()['session.message']?.({
          sessionId: current.id,
          clientMessageId: 'queued-message',
          content: 'execute after compaction completes',
          deliveryIntent: intent,
          attachmentIds: ['00000000-0000-4000-8000-000000000001']
        })
      ).rejects.toThrow('RUN_EXECUTION_NOT_FOUND');

      expect(settle).toHaveBeenCalledOnce();
      if (activated !== true && intent === 'REPLACE_CURRENT')
        expect(settle.mock.calls[0]?.[0]).toMatchObject({
          steerTarget: {
            turnId: runtime.conversationTurnForRun(active.id)?.id,
            executionId: undefined
          }
        });
      else expect(settle.mock.calls[0]?.[0]).not.toHaveProperty('steerTarget');
      const preparedInput = coordinator.prepare.mock.calls[0]?.[1] as {
        input: string;
        prepareSteerInput: () => string;
      };
      expect(preparedInput.input).not.toContain('<mar_steer>');
      if (activated !== true) expect(preparedInput.prepareSteerInput()).toContain('<mar_steer>');
      else expect(preparedInput.prepareSteerInput).toBeUndefined();
      expect(commit).not.toHaveBeenCalled();
      expect(adoptSessionFiles).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    }
  );

  it('releases QueueItems and the message idempotency index when removing a Workspace', () => {
    const runtime = preparedRuntime();
    const current = runtime.createAgentSession({
      workspaceId: 'workspace-1',
      runner: 'codex',
      externalSessionId: 'native-session',
      cwd: '/workspace'
    });
    runtime.createQueueItem({
      sessionId: current.id,
      clientMessageId: 'queued-message',
      content: 'execute later'
    });

    runtime.removeWorkspace('workspace-1');

    const recreated = runtime.createAgentSession({
      workspaceId: 'workspace-1',
      runner: 'codex',
      externalSessionId: 'native-session',
      cwd: '/workspace'
    });
    expect(
      runtime.createQueueItem({
        sessionId: recreated.id,
        clientMessageId: 'queued-message',
        content: 'resubmit'
      })
    ).toMatchObject({ created: true, item: { content: 'resubmit' } });
  });

  it('settles expired, repeated, and one-time approval decisions in in-process runtime state', () => {
    let clock = 1_000;
    const runtime = preparedRuntime(() => clock);
    const current = session(runtime);
    const run = runtime.createMessageRun({
      sessionId: current.id,
      clientMessageId: 'approval-run',
      content: 'run'
    }).run;
    const pending = runtime.createApproval({
      runId: run.id,
      approvalId: 'pending',
      payload: {},
      expiresAt: 2_000
    });
    expect(runtime.decideApproval(pending.id, 'APPROVED').status).toBe('APPROVED');
    expect(() => runtime.decideApproval(pending.id, 'REJECTED')).toThrow(
      'APPROVAL_ALREADY_DECIDED'
    );
    runtime.createApproval({ runId: run.id, approvalId: 'expired', payload: {}, expiresAt: 1_100 });
    clock = 1_100;
    expect(runtime.getApproval('expired')?.status).toBe('EXPIRED');
    expect(() => runtime.decideApproval('expired', 'APPROVED')).toThrow('APPROVAL_EXPIRED');
  });

  it('settles approval requests and results on the same authoritative Conversation Item', () => {
    const runtime = preparedRuntime();
    const current = session(runtime);
    const run = runtime.createMessageRun({
      sessionId: current.id,
      clientMessageId: 'approval-item-run',
      content: 'execute command'
    }).run;
    const execution = runtime.createExecution(run.id);
    runtime.appendRunEvent({
      runId: execution.id,
      sequence: 1,
      eventType: 'approval.request',
      payload: {
        approvalId: 'approval-item-1',
        payload: { toolName: 'Bash', input: { command: 'pwd' } },
        expiresAt: 2_000
      }
    });
    runtime.appendRunEvent({
      runId: execution.id,
      sequence: 2,
      eventType: 'approval.decided',
      payload: { approvalId: 'approval-item-1', decision: 'APPROVED' }
    });

    const items = runtime
      .listConversationTurns({ sessionId: current.id })
      .turns.flatMap((turn) => turn.items)
      .filter((item) => item.kind === 'approval_request');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      status: 'COMPLETED',
      payload: { approvalId: 'approval-item-1', approvalStatus: 'APPROVED' }
    });
  });

  it('limits FIFO reorder, edit, delete, and prioritize operations to QueueItems', () => {
    const runtime = preparedRuntime();
    const current = session(runtime);
    runtime.createMessageRun({ sessionId: current.id, clientMessageId: 'active', content: 'run' });
    const first = runtime.createQueueItem({
      sessionId: current.id,
      clientMessageId: 'first',
      content: 'first message'
    }).item;
    const second = runtime.createQueueItem({
      sessionId: current.id,
      clientMessageId: 'second',
      content: 'second message'
    }).item;
    const version = runtime.sessionQueue(current.id).version;

    runtime.reorderSessionQueue(current.id, version, [second.id, first.id]);
    runtime.updateQueueItem(first.id, 'edited');
    runtime.prioritizeQueueItem(first.id);
    expect(runtime.sessionQueue(current.id).itemIds).toEqual([first.id, second.id]);
    expect(runtime.getQueueItem(first.id)?.content).toBe('edited');
    runtime.deleteQueueItem(second.id);
    expect(runtime.sessionQueue(current.id).itemIds).toEqual([first.id]);
  });

  it.each([0, 1, 2])(
    'reorders public queue snapshots while preserving a hidden Goal continuation at slot %s',
    async (internalIndex) => {
      const runtime = preparedRuntime();
      const current = session(runtime, 'mar-agent');
      const ids = ['first', 'second'];
      ids.splice(internalIndex, 0, 'goal:continuation');
      const items = ids.map(
        (id) =>
          runtime.createQueueItem({
            sessionId: current.id,
            clientMessageId: id,
            content: id
          }).item
      );
      const internal = items[internalIndex]!;
      const ordinary = items.filter((item) => item !== internal);
      runtime.pauseSessionQueue(current.id);
      const emit = vi.fn();
      const service = new WorkspaceQueueWorkbenchService({
        runtime,
        resolve: async (id) => runtime.getAgentSession(id),
        coordinator: {} as never,
        emit,
        prepareInput: (_runner, input) => input
      });
      const get = async () =>
        (await service.operations()['workspace.queue.get']!({
          workspaceId: current.workspaceId,
          sessionId: current.id
        })) as { queue: { version: number; paused: boolean; items: { queueItemId: string }[] } };
      const initial = (await get()).queue;
      expect(initial.items.map((item) => item.queueItemId)).toEqual(
        ordinary.map((item) => item.id)
      );

      for (let attempt = 0; attempt < 2; attempt++) {
        const snapshot = (await get()).queue;
        const reorderedIds = snapshot.items.map((item) => item.queueItemId).reverse();
        expect(
          service.operations()['workspace.queue.reorder']!({
            workspaceId: current.workspaceId,
            sessionId: current.id,
            expectedVersion: snapshot.version,
            queueItemIds: reorderedIds
          })
        ).toMatchObject({
          queue: {
            version: snapshot.version + 1,
            paused: true,
            items: reorderedIds.map((queueItemId) => ({ queueItemId }))
          },
          auditReceipt: { sessionId: current.id, inputMode: 'REORDER_QUEUE' }
        });
        const expectedIds = [...reorderedIds];
        expectedIds.splice(internalIndex, 0, internal.id);
        expect(runtime.sessionQueue(current.id).itemIds).toEqual(expectedIds);
        expect(runtime.getQueueItem(internal.id)).toBe(internal);
      }
      expect((await get()).queue.version).toBe(initial.version + 2);
      expect(emit.mock.calls).toEqual([
        [current.workspaceId, current.id],
        [current.workspaceId, current.id]
      ]);
    }
  );

  it.each(['stale', 'missing', 'duplicate', 'unknown', 'foreign', 'internal', 'full'] as const)(
    'rejects %s public reorder requests without mutating the queue or publishing a snapshot',
    (invalid) => {
      const runtime = preparedRuntime();
      const current = session(runtime, 'mar-agent');
      const add = (clientMessageId: string, sessionId = current.id) =>
        runtime.createQueueItem({ sessionId, clientMessageId, content: clientMessageId }).item;
      const internal = add('goal:continuation');
      const first = add('first');
      const second = add('second');
      const foreign = add('foreign', session(runtime).id);
      const before = runtime.sessionQueue(current.id);
      const emit = vi.fn();
      const service = new WorkspaceQueueWorkbenchService({
        runtime,
        resolve: async (id) => runtime.getAgentSession(id),
        coordinator: {} as never,
        emit,
        prepareInput: (_runner, input) => input
      });
      const submittedIds = {
        stale: [second.id, first.id],
        missing: [first.id],
        duplicate: [first.id, first.id],
        unknown: [first.id, 'missing-item'],
        foreign: [first.id, foreign.id],
        internal: [first.id, internal.id],
        full: [internal.id, second.id, first.id]
      }[invalid];
      expect(() =>
        service.operations()['workspace.queue.reorder']!({
          workspaceId: current.workspaceId,
          sessionId: current.id,
          expectedVersion: before.version - (invalid === 'stale' ? 1 : 0),
          queueItemIds: submittedIds
        })
      ).toThrow('QUEUE_VERSION_CONFLICT');
      expect(runtime.sessionQueue(current.id)).toEqual(before);
      expect(runtime.getQueueItem(internal.id)).toBe(internal);
      expect(emit).not.toHaveBeenCalled();
    }
  );

  it('does not claim items while paused and claims them in FIFO order into the same Run after resuming', () => {
    const runtime = preparedRuntime();
    const current = session(runtime);
    const run = runtime.createMessageRun({
      sessionId: current.id,
      clientMessageId: 'active',
      content: 'run'
    }).run;
    runtime.createExecution(run.id);
    const item = runtime.createQueueItem({
      sessionId: current.id,
      clientMessageId: 'queued',
      content: 'queued'
    }).item;
    runtime.pauseSessionQueue(current.id);
    expect(runtime.claimNextQueueItem(current.id)).toBeUndefined();
    runtime.resumeSessionQueue(current.id);
    expect(runtime.claimNextQueueItem(current.id)).toMatchObject({ item: { id: item.id } });
    expect(runtime.conversationTurnForRun(run.id)?.runId).toBe(run.id);
  });

  it('creates only one Run or QueueItem for the same clientMessageId', () => {
    const runtime = preparedRuntime();
    const current = session(runtime);
    const first = runtime.createMessageRun({
      sessionId: current.id,
      clientMessageId: 'same-run',
      content: 'start'
    });
    expect(
      runtime.createMessageRun({
        sessionId: current.id,
        clientMessageId: 'same-run',
        content: 'duplicate'
      })
    ).toEqual({ run: first.run, created: false });

    const queued = runtime.createQueueItem({
      sessionId: current.id,
      clientMessageId: 'same-queue',
      content: 'queued'
    });
    expect(
      runtime.createQueueItem({
        sessionId: current.id,
        clientMessageId: 'same-queue',
        content: 'duplicate'
      })
    ).toEqual({ item: queued.item, created: false });
  });

  it.each(['codex', 'claude-code', 'opencode'] as const)(
    ' %s multiple Turns share one Run while preserving user delivery order',
    (runner) => {
      let clock = 100;
      const runtime = preparedRuntime(() => clock++);
      const current = session(runtime, runner);
      const run = runtime.createMessageRun({
        sessionId: current.id,
        clientMessageId: 'first',
        content: 'first message'
      }).run;
      runtime.createExecution(run.id);
      runtime.createQueueItem({
        sessionId: current.id,
        clientMessageId: 'second',
        content: 'second message'
      });
      runtime.claimNextQueueItem(current.id);

      expect(
        runtime.listConversationTurns({ sessionId: current.id }).turns.map((turn) => ({
          runId: turn.runId,
          text: (
            turn.items.find((item) => item.id === turn.userItemId)?.payload as { text: string }
          ).text
        }))
      ).toEqual([
        { runId: run.id, text: 'first message' },
        { runId: run.id, text: 'second message' }
      ]);
    }
  );

  it('atomically migrates Session, Run, Turn, FIFO, Lease, and idempotency indexes on identity promotion', () => {
    const runtime = preparedRuntime();
    const bootstrap = session(runtime);
    const run = runtime.createMessageRun({
      sessionId: bootstrap.id,
      clientMessageId: 'active',
      content: 'start'
    }).run;
    const queued = runtime.createQueueItem({
      sessionId: bootstrap.id,
      clientMessageId: 'queued',
      content: 'continue'
    }).item;

    runtime.promoteSessionIdentity(bootstrap.id, 'native-session');

    expect(runtime.activeSessionRun('native-session')).toMatchObject({ id: run.id });
    expect(runtime.sessionQueue('native-session').itemIds).toEqual([queued.id]);
    expect(runtime.findMessageSubmission('native-session', 'queued')).toMatchObject({
      kind: 'queue',
      item: { id: queued.id }
    });
    expect(runtime.listConversationTurns({ sessionId: 'native-session' })).toMatchObject({
      turns: [{ runId: run.id }]
    });
  });
});
