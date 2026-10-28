import { createTestSessionWatch } from './support/conversation-watch.js';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConversationTemplateDraft,
  MarAgentRuntimeModelConfiguration,
  WorkbenchEvent
} from '../../../packages/protocol/src/index.js';
import { NodeDatabase, type NodeAgentSession } from '../../src/database.js';
import { SessionWatchSlotCoordinator } from '../../src/service/session-watch-slot-coordinator.js';
import {
  HostedConversationNodeService,
  type HostedConversationRuntime
} from '../../src/hosting/hosted-conversation-node-service.js';
import { HostedConversationStore } from '../../src/hosting/hosted-conversation-store.js';
import { WorkbenchEventService } from '../../src/service/workbench-event-service.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (path) => {
      await makeWritable(path).catch(() => undefined);
      await rm(path, { recursive: true, force: true });
    })
  );
});

describe('Node hosted conversation watch', () => {
  it('uses the shared ordinary sequence without redispatching hosted Watch events', async () => {
    const f = await watchFixture();
    try {
      const conversationId = await createConversation(f);
      await f.service.operations()['conversation.hosted.watch']!({
        conversationId,
        mode: 'initial',
        workbenchConnectionId: 'shared-sequence-connection',
        watchId: 'shared-sequence-watch',
        __workspaceWatchSessionHash: 'session-hash',
        __requestUserId: 7,
        __marAgentModels: [model]
      });
      await vi.waitFor(() => expect(f.frames).toHaveLength(1));
      const sequence = f.workbench.snapshotSequence();
      f.workbench.dispatch('session', { sessionId: 'ordinary-session' });
      expect(f.ordinaryDelivery).toHaveBeenCalledExactlyOnceWith('ordinary-session', {
        sequence: sequence + 1,
        category: 'session',
        payload: { sessionId: 'ordinary-session' }
      });
      f.service.publishRuntimeEvent(conversationId, {
        kind: 'DELTA',
        executionId: 'shared-execution',
        sequence: 1,
        createdAt: 123,
        payload: { text: 'hosted-only' }
      });
      expect(f.frames).toHaveLength(2);
      expect(f.frames[1]).toMatchObject({
        type: 'watch.hosted-conversation.event',
        watchId: 'shared-sequence-watch',
        workbenchConnectionId: 'shared-sequence-connection',
        event: {
          sequence: sequence + 2,
          category: 'hosted-conversation',
          payload: { conversationId }
        }
      });
      expect(f.workbench.snapshotSequence()).toBe(sequence + 2);
      expect(f.ordinaryDelivery).toHaveBeenCalledOnce();
      expect(f.events).toEqual([]);
    } finally {
      await f.service.dispose();
    }
  });

  it('rejects an old renewal without releasing the replacement lease', async () => {
    const fixture = await watchFixture();
    const conversationId = await createConversation(fixture);
    const watch = fixture.service.operations()['conversation.hosted.watch']!;
    const input = {
      conversationId,
      workbenchConnectionId: 'replacement-connection',
      __workspaceWatchSessionHash: 'session-hash',
      __requestUserId: 7,
      __marAgentModels: [model]
    };
    try {
      await watch({ ...input, mode: 'initial', watchId: 'old-watch' });
      await watch({ ...input, mode: 'initial', watchId: 'new-watch' });
      await expect(watch({ ...input, mode: 'renew', watchId: 'old-watch' })).rejects.toThrow(
        'SESSION_WATCH_NOT_FOUND'
      );
      await expect(watch({ ...input, mode: 'renew', watchId: 'new-watch' })).resolves.toMatchObject(
        { watchId: 'new-watch' }
      );
      await vi.waitFor(() =>
        expect(fixture.frames).toContainEqual(
          expect.objectContaining({
            type: 'watch.hosted-conversation.snapshot',
            watchId: 'new-watch'
          })
        )
      );
      fixture.service.publishRuntimeEvent(conversationId, {
        kind: 'DELTA',
        executionId: 'lease-execution',
        sequence: 1,
        createdAt: Date.now(),
        payload: { text: 'still live' }
      });
      expect(fixture.frames.at(-1)).toMatchObject({
        type: 'watch.hosted-conversation.event',
        watchId: 'new-watch'
      });
    } finally {
      await fixture.service.dispose();
    }
  });

  it('settles files before the terminal run and its refreshed snapshot', async () => {
    const fixture = await watchFixture();
    const conversationId = await createConversation(fixture);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconcile = fixture.store.reconcileFiles.bind(fixture.store);
    const scan = vi.spyOn(fixture.store, 'reconcileFiles').mockImplementation(async (...args) => {
      await gate;
      return reconcile(...args);
    });
    try {
      await fixture.service.operations()['conversation.hosted.watch']!({
        conversationId,
        mode: 'initial',
        workbenchConnectionId: 'settlement-connection',
        watchId: 'settlement-watch',
        __workspaceWatchSessionHash: 'session-hash',
        __requestUserId: 7,
        __marAgentModels: [model]
      });
      await vi.waitFor(() => expect(fixture.frames).toHaveLength(1));
      await fixture.service.operations()['conversation.hosted.message']!({
        conversationId,
        clientMessageId: 'settlement-message',
        prompt: 'Generate a file',
        attachmentIds: [],
        __requestUserId: 7,
        __marAgentModel: model,
        __marAgentModels: [model]
      });
      fixture.frames.length = 0;
      fixture.completeRun({ status: 'SUCCEEDED', completedAt: 2300 });
      await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
      expect(fixture.frames).toEqual([]);
      expect(fixture.service.prepareForDisable()).toBeUndefined();
      release();
      await vi.waitFor(() =>
        expect(fixture.frames).toContainEqual(
          expect.objectContaining({ type: 'watch.hosted-conversation.snapshot' })
        )
      );
      const payloads = fixture.frames
        .filter((frame) => frame.type === 'watch.hosted-conversation.event')
        .map((frame) => (frame.event as WorkbenchEvent).payload as { kind: string });
      expect(payloads.slice(0, 2).map((payload) => payload.kind)).toEqual(['files', 'run']);
      expect(
        fixture.frames.findIndex((frame) => frame.type === 'watch.hosted-conversation.snapshot')
      ).toBeGreaterThan(1);
    } finally {
      release();
      await fixture.service.dispose();
    }
  });

  it('keeps the original hosted handle and settles all natively steered messages with that run', async () => {
    const f = await watchFixture();
    try {
      const id = await createConversation(f);
      const completion = Promise.withResolvers<{ status: 'SUCCEEDED'; completedAt: number }>();
      const admission = Promise.withResolvers<import('@myagentroam/agent').SteerResult>();
      const cancel = vi.fn(() => true),
        steer = vi.fn(() => admission.promise);
      f.runtime.startRun.mockImplementationOnce(async () => ({
        run: { id: 'native-run', status: 'RUNNING', startedAt: 2000, completedAt: null },
        completion: completion.promise,
        cancel,
        steer
      }));
      const send = (clientMessageId: string, deliveryIntent?: 'REPLACE_CURRENT') =>
        f.service.operations()['conversation.hosted.message']!({
          conversationId: id,
          clientMessageId,
          prompt: clientMessageId,
          attachmentIds: [],
          ...(deliveryIntent ? { deliveryIntent } : {}),
          __requestUserId: 7,
          __marAgentModels: [model]
        });
      await send('original');
      const pending = send('guidance', 'REPLACE_CURRENT');
      await vi.waitFor(() => expect(steer).toHaveBeenCalledOnce());
      expect(send('guidance', 'REPLACE_CURRENT')).toBe(pending);
      expect(f.runtime.startRun).toHaveBeenCalledOnce();
      expect(cancel).not.toHaveBeenCalled();
      completion.resolve({ status: 'SUCCEEDED', completedAt: 2200 });
      admission.resolve({
        status: 'accepted',
        entry: {
          kind: 'user',
          recordId: 'received',
          sequence: 3,
          timestamp: new Date(2100).toISOString(),
          sessionId: id,
          executionId: 'native-run',
          turnId: 'native-turn',
          text: 'guidance',
          clientMessageId: 'guidance'
        }
      });
      expect(await pending).toMatchObject({ run: { id: 'native-run' } });
      await vi.waitFor(() =>
        expect(f.store.findMessage(7, id, 'guidance')).toMatchObject({
          runId: 'native-run',
          status: 'SUCCEEDED'
        })
      );
      expect(f.store.findMessage(7, id, 'original')).toMatchObject({
        runId: 'native-run',
        status: 'SUCCEEDED'
      });
      expect(f.runtime.startRun).toHaveBeenCalledOnce();
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      f.service.dispose();
      f.database.close();
    }
  });
  it('releases the admission after a runtime start failure so a later message can start', async () => {
    const f = await watchFixture();
    try {
      const conversationId = await createConversation(f);
      f.runtime.startRun.mockRejectedValueOnce(new Error('START_FAILED'));
      const send = (clientMessageId: string) =>
        f.service.operations()['conversation.hosted.message']!({
          conversationId,
          clientMessageId,
          prompt: 'hello',
          attachmentIds: [],
          __requestUserId: 7,
          __marAgentModels: [model]
        });
      await expect(send('failed')).rejects.toThrow('START_FAILED');
      expect(f.store.findMessage(7, conversationId, 'failed')).toBeUndefined();
      await expect(send('retry')).resolves.toMatchObject({ run: { status: 'RUNNING' } });
      f.completeRun({ status: 'SUCCEEDED', completedAt: 2300 });
    } finally {
      await f.service.dispose();
      f.database.close();
    }
  });

  it('cancels and joins the native handle when message acceptance persistence fails', async () => {
    const f = await watchFixture();
    try {
      const conversationId = await createConversation(f);
      const completion = Promise.withResolvers<{ status: 'INTERRUPTED'; completedAt: number }>();
      const cancel = vi.fn(() => true);
      f.runtime.startRun.mockResolvedValueOnce({
        run: { id: 'failed-acceptance', status: 'RUNNING', startedAt: 2000, completedAt: null },
        completion: completion.promise,
        cancel
      });
      vi.spyOn(f.store, 'saveMessageAcceptance').mockRejectedValueOnce(new Error('SAVE_FAILED'));
      const operation = f.service.operations()['conversation.hosted.message']!({
        conversationId,
        clientMessageId: 'failed',
        prompt: 'hello',
        attachmentIds: [],
        __requestUserId: 7,
        __marAgentModels: [model]
      });
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      completion.resolve({ status: 'INTERRUPTED', completedAt: 2100 });
      await expect(operation).rejects.toThrow('SAVE_FAILED');
      expect(f.store.findMessage(7, conversationId, 'failed')).toMatchObject({
        status: 'INTERRUPTED'
      });
      await expect(
        f.service.operations()['conversation.hosted.message']!({
          conversationId,
          clientMessageId: 'retry',
          prompt: 'retry',
          attachmentIds: [],
          __requestUserId: 7,
          __marAgentModels: [model]
        })
      ).resolves.toMatchObject({ run: { status: 'RUNNING' } });
      f.completeRun({ status: 'SUCCEEDED', completedAt: 2300 });
    } finally {
      await f.service.dispose();
      f.database.close();
    }
  });

  it('does not advertise or expose Prompt Tab in hosted conversations', async () => {
    const fixture = await watchFixture();
    try {
      const conversationId = await createConversation(fixture);
      const snapshot = await fixture.service.operations()['conversation.hosted.get']!({
        conversationId,
        __requestUserId: 7,
        __marAgentModels: [model]
      });
      expect(snapshot).not.toHaveProperty('promptCompletion');
      expect(
        fixture.service.operations()['conversation.hosted.prompt-completion.generate']
      ).toBeUndefined();
      expect(fixture.runtime.startRun).not.toHaveBeenCalled();
    } finally {
      fixture.service.dispose();
      fixture.database.close();
    }
  });

  it('injects durable instruction maintenance and current-output lifecycle guidance', async () => {
    const fixture = await watchFixture();
    const conversationId = await createConversation(fixture);
    const createInstruction = fixture.runtime.createSession.mock.calls[0]![0].systemInstruction;
    const requiredGuidance = [
      'Automatically identify requirements, preferences, terminology, conventions, quality checks, and recurring workflows',
      'Treat ambiguous guidance as current-task-only.',
      'do not rewrite the file when its effective rules would remain unchanged',
      'Do not automatically persist requirements that apply only to the current task',
      'Do not append raw messages or maintain a conversation transcript there',
      'Treat /workspace/output as the current deliverable set, not an append-only history of runs.',
      'unless the user explicitly requests a separate variant or snapshot',
      '/workspace/output/bak',
      '/workspace/output/assets',
      'do not relocate existing referenced assets solely to enforce that layout',
      'do not delete user uploads'
    ];
    for (const guidance of requiredGuidance) expect(createInstruction).toContain(guidance);

    await fixture.service.operations()['conversation.hosted.message']!({
      conversationId,
      clientMessageId: 'message-output-lifecycle',
      prompt: 'Revise the current document.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModels: [model]
    });

    const runInstruction = fixture.runtime.startRun.mock.calls[0]![0].systemInstruction;
    for (const guidance of requiredGuidance) expect(runInstruction).toContain(guidance);
    expect(runInstruction).toContain('/generated_images');
  });

  it('keeps snapshots, Watch and deletion available when the current model catalog is empty', async () => {
    const fixture = await watchFixture();
    const conversationId = await createConversation(fixture);
    const operations = fixture.service.operations();

    await expect(
      operations['conversation.hosted.get']!({
        conversationId,
        __requestUserId: 7,
        __marAgentModels: []
      })
    ).resolves.toMatchObject({ models: [] });

    await expect(
      operations['conversation.hosted.watch']!({
        conversationId,
        mode: 'initial',
        workbenchConnectionId: 'connection-empty-models',
        watchId: 'watch-empty-models',
        __workspaceWatchSessionHash: 'session-hash',
        __requestUserId: 7,
        __marAgentModels: []
      })
    ).resolves.toMatchObject({ accepted: true });
    await vi.waitFor(() =>
      expect(
        fixture.frames.find(
          (frame) =>
            frame.type === 'watch.hosted-conversation.snapshot' &&
            frame.watchId === 'watch-empty-models'
        )
      ).toMatchObject({
        templateId: 'template-1',
        payload: { models: [] }
      })
    );

    await expect(
      operations['conversation.hosted.message']!({
        conversationId,
        clientMessageId: 'message-empty-models',
        prompt: 'This must not start a new Run.',
        attachmentIds: [],
        __requestUserId: 7,
        __marAgentModels: []
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_MODEL_NOT_AVAILABLE');

    await expect(
      operations['conversation.hosted.delete']!({
        conversationId,
        __requestUserId: 7
      })
    ).resolves.toEqual({ deletedConversationId: conversationId });
  });

  it('lists draft model options and honors an allowed model when creating', async () => {
    const fixture = await watchFixture();
    await seedUpgradeVersion(fixture.database, fixture.store, {
      allowedModels: [
        { modelId: 'model-one', name: 'Model One' },
        { modelId: 'model-two', name: 'Model Two' }
      ],
      defaultModelId: 'model-one'
    });
    const template = {
      id: 'template-1',
      nodeId: 'node-1',
      name: 'Research',
      description: 'Research template',
      status: 'ACTIVE',
      currentVersionId: 'version-2',
      available: true,
      createdAt: 1_000,
      updatedAt: 1_500
    };
    const operations = fixture.service.operations();

    await expect(
      operations['conversation.hosted.model-options']!({
        templateId: template.id,
        __requestUserId: 7,
        __template: template,
        __marAgentModels: [{ ...model, serviceTier: 'priority' }, modelTwo]
      })
    ).resolves.toMatchObject({
      models: [{ id: 'model-1', serviceTier: 'priority' }, { id: 'model-2' }],
      defaultModelId: 'model-1'
    });
    await expect(
      operations['conversation.hosted.create']!({
        templateId: template.id,
        clientRequestId: 'create-selected-model',
        modelId: 'model-2',
        __requestUserId: 7,
        __template: template,
        __marAgentModels: [model, modelTwo]
      })
    ).resolves.toMatchObject({ conversation: { modelId: 'model-2' } });
    expect(fixture.runtime.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModelId: 'model-2' })
    );
    await expect(
      operations['conversation.hosted.create']!({
        templateId: template.id,
        clientRequestId: 'create-disallowed-model',
        modelId: 'model-3',
        __requestUserId: 7,
        __template: template,
        __marAgentModels: [model, modelTwo]
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_MODEL_NOT_AVAILABLE');
    expect(fixture.runtime.createSession).toHaveBeenCalledTimes(1);
  });

  it('uses the latest available template version for snapshot model range', async () => {
    const fixture = await watchFixture();
    const conversationId = await createConversation(fixture);
    await seedUpgradeVersion(fixture.database, fixture.store, {
      allowedModels: [
        { modelId: 'model-one', name: 'Model One' },
        { modelId: 'model-two', name: 'Model Two' }
      ],
      defaultModelId: 'model-one'
    });
    const operations = fixture.service.operations();

    await expect(
      operations['conversation.hosted.get']!({
        conversationId,
        __requestUserId: 7,
        __marAgentModels: [model, modelTwo]
      })
    ).resolves.toMatchObject({ models: [{ id: 'model-1' }, { id: 'model-2' }] });

    await expect(
      operations['conversation.hosted.config.update']!({
        conversationId,
        modelId: 'model-2',
        __requestUserId: 7,
        __marAgentModels: [model, modelTwo]
      })
    ).resolves.toMatchObject({ conversation: { modelId: 'model-2' } });
  });

  it('returns an empty model range when the latest version allows no available model', async () => {
    const fixture = await watchFixture();
    const conversationId = await createConversation(fixture);
    await seedUpgradeVersion(fixture.database, fixture.store, {
      allowedModels: [{ modelId: 'model-two', name: 'Model Two' }],
      defaultModelId: 'model-two'
    });
    const operations = fixture.service.operations();

    await expect(
      operations['conversation.hosted.get']!({
        conversationId,
        __requestUserId: 7,
        __marAgentModels: [model]
      })
    ).resolves.toMatchObject({ models: [] });

    await expect(
      operations['conversation.hosted.message']!({
        conversationId,
        clientMessageId: 'message-no-model',
        prompt: 'This must not start a new Run.',
        attachmentIds: [],
        __requestUserId: 7,
        __marAgentModels: [model]
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_UPGRADE_FAILED');
  });

  it('publishes one asynchronous snapshot and safe runtime events to the active page lease', async () => {
    const fixture = await watchFixture();
    const conversationId = await createConversation(fixture);
    const watch = fixture.service.operations()['conversation.hosted.watch']!;

    await expect(
      watch({
        conversationId,
        mode: 'initial',
        workbenchConnectionId: 'connection-hosted',
        watchId: 'watch-hosted-1',
        __workspaceWatchSessionHash: 'session-hash',
        __requestUserId: 7,
        __marAgentModels: [model]
      })
    ).resolves.toMatchObject({
      accepted: true,
      watchId: 'watch-hosted-1',
      nodeGeneration: 'generation-hosted'
    });
    await vi.waitFor(() =>
      expect(
        fixture.frames.filter((frame) => frame.type === 'watch.hosted-conversation.snapshot')
      ).toHaveLength(1)
    );
    expect(
      fixture.frames.filter((frame) => String(frame.type).startsWith('watch.hosted-conversation.'))
    ).toEqual([expect.objectContaining({ templateId: 'template-1' })]);

    const startRun = fixture.runtime.startRun.getMockImplementation()!;
    fixture.runtime.startRun.mockImplementationOnce(async (input) => {
      await input.onEvent?.({
        kind: 'ITEM',
        executionId: 'run-1',
        turnId: 'turn-1',
        sequence: 1,
        createdAt: 2_050,
        payload: {
          item: {
            itemId: 'assistant-1',
            kind: 'assistant_message',
            status: 'IN_PROGRESS',
            payload: { text: 'started', format: 'markdown', model: null }
          }
        }
      });
      return startRun(input);
    });
    await fixture.service.operations()['conversation.hosted.message']!({
      conversationId,
      clientMessageId: 'message-watch-1',
      prompt: 'Stream this run.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: model,
      __marAgentModels: [model]
    });
    const acceptedEvents = fixture.frames
      .filter((frame) => frame.type === 'watch.hosted-conversation.event')
      .map((frame) => (frame.event as WorkbenchEvent).payload as { kind?: string });
    expect(acceptedEvents.findIndex((payload) => payload.kind === 'runtime')).toBeGreaterThan(
      acceptedEvents.findIndex((payload) => payload.kind === 'run')
    );
    const runInput = fixture.runtime.startRun.mock.calls[0]![0];
    runInput.onEvent!({
      kind: 'DELTA',
      executionId: 'run-1',
      turnId: 'turn-1',
      sequence: 2,
      createdAt: 2_100,
      payload: {
        itemId: 'assistant-1',
        text: 'partial',
        phase: 'commentary'
      }
    });

    await vi.waitFor(() =>
      expect(
        fixture.frames.filter((frame) => frame.type === 'watch.hosted-conversation.event')
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conversationId,
            event: expect.objectContaining({
              category: 'hosted-conversation',
              payload: expect.objectContaining({
                kind: 'runtime',
                runtimeEvent: expect.objectContaining({ kind: 'DELTA' })
              })
            })
          })
        ])
      )
    );

    const paths = fixture.store.pathsForConversation(7, conversationId);
    await writeFile(join(paths.outputDirectory, 'result.txt'), 'result');
    const completedTurn = rollbackTurn('turn-1', 'Stream this run.', null);
    fixture.runtime.history.mockResolvedValue({ turns: [completedTurn], nextCursor: null });
    fixture.completeRun({
      status: 'SUCCEEDED',
      completedAt: 2_200,
      title: 'Generated streamed report'
    });
    await vi.waitFor(() =>
      expect(
        fixture.frames.filter((frame) => frame.type === 'watch.hosted-conversation.event')
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conversationId,
            event: expect.objectContaining({
              category: 'hosted-conversation',
              payload: expect.objectContaining({
                kind: 'files',
                files: [
                  expect.objectContaining({
                    category: 'OUTPUT',
                    relativePath: 'result.txt',
                    source: 'AGENT'
                  })
                ]
              })
            })
          })
        ])
      )
    );
    expect(
      fixture.frames.filter((frame) => frame.type === 'watch.hosted-conversation.event')
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationId,
          event: expect.objectContaining({
            category: 'hosted-conversation',
            payload: expect.objectContaining({
              kind: 'conversation',
              conversation: expect.objectContaining({
                id: conversationId,
                title: 'Generated streamed report'
              })
            })
          })
        })
      ])
    );
    await vi.waitFor(() =>
      expect(
        fixture.frames.filter((frame) => frame.type === 'watch.hosted-conversation.snapshot')
      ).toHaveLength(2)
    );
    expect(
      fixture.frames.filter((frame) => frame.type === 'watch.hosted-conversation.snapshot').at(-1)
        ?.payload
    ).toMatchObject({
      run: null,
      turns: [expect.objectContaining({ id: completedTurn.id, status: 'SUCCEEDED' })]
    });

    const snapshotsBeforeRenew = fixture.frames.filter(
      (frame) => frame.type === 'watch.hosted-conversation.snapshot'
    ).length;
    await expect(
      watch({
        conversationId,
        mode: 'renew',
        workbenchConnectionId: 'connection-hosted',
        watchId: 'watch-hosted-1',
        __workspaceWatchSessionHash: 'session-hash',
        __requestUserId: 7,
        __marAgentModels: [model]
      })
    ).resolves.toMatchObject({ accepted: true });
    expect(
      fixture.frames.filter((frame) => frame.type === 'watch.hosted-conversation.snapshot')
    ).toHaveLength(snapshotsBeforeRenew);
  });

  it('drops a completed Run snapshot callback after a newer Run becomes active', async () => {
    const fixture = await watchFixture();
    const conversationId = await createConversation(fixture);
    await fixture.service.operations()['conversation.hosted.watch']!({
      conversationId,
      mode: 'initial',
      workbenchConnectionId: 'connection-newer-run',
      watchId: 'watch-newer-run',
      __workspaceWatchSessionHash: 'session-hash',
      __requestUserId: 7,
      __marAgentModels: [model]
    });
    await vi.waitFor(() =>
      expect(
        fixture.frames.filter((frame) => frame.type === 'watch.hosted-conversation.snapshot')
      ).toHaveLength(1)
    );
    const service = fixture.service as unknown as {
      readonly runs: {
        accept(
          conversationId: string,
          handle: {
            readonly run: {
              readonly id: string;
              readonly status: 'RUNNING';
              readonly startedAt: number;
              readonly completedAt: null;
            };
          }
        ): void;
      };
      hostedWatch: {
        refreshReadySnapshots(conversationId: string, completedRunId: string): Promise<void>;
      };
    };
    service.runs.accept(conversationId, {
      run: {
        id: 'run-newer',
        status: 'RUNNING',
        startedAt: 3_000,
        completedAt: null
      }
    });

    await service.hostedWatch.refreshReadySnapshots(conversationId, 'run-completed');

    expect(
      fixture.frames.filter((frame) => frame.type === 'watch.hosted-conversation.snapshot')
    ).toHaveLength(1);
  });

  it('serially replaces an active Run while preserving its generated title without interruption notifications', async () => {
    const fixture = await watchFixture();
    const conversationId = await createConversation(fixture);
    const operations = fixture.service.operations();
    await operations['conversation.hosted.watch']!({
      conversationId,
      mode: 'initial',
      workbenchConnectionId: 'connection-title-interruption',
      watchId: 'watch-title-interruption',
      __workspaceWatchSessionHash: 'session-hash',
      __requestUserId: 7,
      __marAgentModels: [model]
    });
    let finishFirst!: (completion: {
      status: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
      completedAt: number;
      title?: string;
    }) => void;
    const firstCompletion = new Promise<{
      status: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
      completedAt: number;
      title?: string;
    }>((resolve) => {
      finishFirst = resolve;
    });
    const firstCancel = vi.fn(() => true);
    fixture.runtime.startRun
      .mockImplementationOnce(async () => ({
        run: { id: 'run-replaced', status: 'RUNNING', startedAt: 2_000, completedAt: null },
        completion: firstCompletion,
        cancel: firstCancel
      }))
      .mockImplementationOnce(async () => ({
        run: { id: 'run-replacement', status: 'RUNNING', startedAt: 2_100, completedAt: null },
        completion: Promise.resolve({ status: 'SUCCEEDED', completedAt: 2_200 }),
        cancel: vi.fn(() => true)
      }));

    await operations['conversation.hosted.message']!({
      conversationId,
      clientMessageId: 'message-active',
      prompt: 'Initial Run.',
      attachmentIds: [],
      deliveryIntent: 'REPLACE_CURRENT',
      __requestUserId: 7,
      __marAgentModel: model,
      __marAgentModels: [model]
    });

    await expect(
      operations['conversation.hosted.message']!({
        conversationId,
        clientMessageId: 'oversized-steer',
        prompt: '<'.repeat(90_000),
        attachmentIds: [],
        deliveryIntent: 'REPLACE_CURRENT',
        __requestUserId: 7,
        __marAgentModel: model,
        __marAgentModels: [model]
      })
    ).rejects.toThrow('COMPOSER_TAG_INVALID');
    expect(firstCancel).not.toHaveBeenCalled();

    const replacement = operations['conversation.hosted.message']!({
      conversationId,
      clientMessageId: 'message-replace',
      prompt: 'Replace the initial Run.',
      attachmentIds: [],
      deliveryIntent: 'REPLACE_CURRENT',
      __requestUserId: 7,
      __marAgentModel: model,
      __marAgentModels: [model]
    });

    await vi.waitFor(() => expect(firstCancel).toHaveBeenCalledOnce());
    await expect(
      operations['conversation.hosted.message']!({
        conversationId,
        clientMessageId: 'message-normal-while-active',
        prompt: 'This must not queue.',
        attachmentIds: [],
        __requestUserId: 7,
        __marAgentModel: model,
        __marAgentModels: [model]
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_RUN_ACTIVE');
    await expect(
      operations['conversation.hosted.message']!({
        conversationId,
        clientMessageId: 'message-second-replace',
        prompt: 'This must not replace concurrently.',
        attachmentIds: [],
        deliveryIntent: 'REPLACE_CURRENT',
        __requestUserId: 7,
        __marAgentModel: model,
        __marAgentModels: [model]
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_RUN_ACTIVE');
    expect(fixture.runtime.startRun).toHaveBeenCalledTimes(1);
    expect(fixture.events).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          kind: 'activity',
          activity: expect.objectContaining({ status: 'CANCELLING' })
        })
      })
    );

    finishFirst({
      status: 'INTERRUPTED',
      completedAt: 2_050,
      title: 'Generated initial task title'
    });

    await expect(replacement).resolves.toMatchObject({ run: { id: 'run-replacement' } });
    expect(fixture.runtime.startRun).toHaveBeenCalledTimes(2);
    expect(fixture.runtime.startRun.mock.calls[0]?.[0]).toMatchObject({
      prompt: 'Initial Run.',
      userPrompt: 'Initial Run.'
    });
    expect(fixture.runtime.startRun.mock.calls[1]?.[0]).toMatchObject({
      prompt: expect.stringContaining('<mar_steer>'),
      userPrompt: 'Replace the initial Run.'
    });
    expect(fixture.store.requireConversation(7, conversationId)).toMatchObject({
      title: 'Generated initial task title',
      titleSource: 'AUTO'
    });
    expect(fixture.frames).toContainEqual(
      expect.objectContaining({
        type: 'watch.hosted-conversation.event',
        event: expect.objectContaining({
          payload: expect.objectContaining({
            kind: 'conversation',
            conversation: expect.objectContaining({
              id: conversationId,
              title: 'Generated initial task title',
              titleSource: 'AUTO'
            })
          })
        })
      })
    );
    expect(
      fixture.events.some(
        (event) =>
          (event.payload as { kind?: string; event?: { payload?: { runId?: string } } }).kind ===
            'notification' &&
          (event.payload as { event?: { payload?: { runId?: string } } }).event?.payload?.runId ===
            'run-replaced'
      )
    ).toBe(false);
  });

  it('releases the Run gate after an already-resolved completion settles', async () => {
    const fixture = await watchFixture();
    const conversationId = await createConversation(fixture);
    const operations = fixture.service.operations();
    fixture.runtime.startRun
      .mockImplementationOnce(async () => ({
        run: { id: 'run-immediate', status: 'RUNNING', startedAt: 2_000, completedAt: null },
        completion: Promise.resolve({ status: 'SUCCEEDED', completedAt: 2_100 }),
        cancel: vi.fn(() => true)
      }))
      .mockImplementationOnce(async () => ({
        run: { id: 'run-follow-up', status: 'RUNNING', startedAt: 2_200, completedAt: null },
        completion: Promise.resolve({ status: 'SUCCEEDED', completedAt: 2_300 }),
        cancel: vi.fn(() => true)
      }));

    await operations['conversation.hosted.message']!({
      conversationId,
      clientMessageId: 'message-immediate',
      prompt: 'Complete immediately.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: model,
      __marAgentModels: [model]
    });
    await vi.waitFor(async () =>
      expect(
        await operations['conversation.hosted.get']!({
          conversationId,
          __requestUserId: 7,
          __marAgentModels: [model]
        })
      ).toMatchObject({ run: null })
    );

    await expect(
      operations['conversation.hosted.message']!({
        conversationId,
        clientMessageId: 'message-follow-up',
        prompt: 'Start after settlement.',
        attachmentIds: [],
        __requestUserId: 7,
        __marAgentModel: model,
        __marAgentModels: [model]
      })
    ).resolves.toMatchObject({ run: { id: 'run-follow-up' } });
  });

  it('emits the initial snapshot before buffered events and then publishes a fast terminal Run', async () => {
    const fixture = await watchFixture();
    const conversationId = await createConversation(fixture);
    let releaseHistory!: () => void;
    const historyReleased = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    fixture.runtime.history.mockImplementationOnce(async () => {
      await historyReleased;
      return { turns: [], nextCursor: null };
    });
    let reportReconcileStarted!: () => void;
    let releaseReconcile!: () => void;
    const reconcileStarted = new Promise<void>((resolve) => {
      reportReconcileStarted = resolve;
    });
    const reconcileReleased = new Promise<void>((resolve) => {
      releaseReconcile = resolve;
    });
    vi.spyOn(fixture.store, 'reconcileFiles').mockImplementationOnce(async () => {
      reportReconcileStarted();
      await reconcileReleased;
      return [];
    });

    await fixture.service.operations()['conversation.hosted.watch']!({
      conversationId,
      mode: 'initial',
      workbenchConnectionId: 'connection-fast-terminal',
      watchId: 'watch-fast-terminal',
      __workspaceWatchSessionHash: 'session-hash',
      __requestUserId: 7,
      __marAgentModels: [model]
    });
    await vi.waitFor(() => expect(fixture.runtime.history).toHaveBeenCalledTimes(2));
    await fixture.service.operations()['conversation.hosted.message']!({
      conversationId,
      clientMessageId: 'message-fast-terminal',
      prompt: 'Finish while the initial snapshot is loading.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: model,
      __marAgentModels: [model]
    });
    fixture.completeRun({ status: 'SUCCEEDED', completedAt: 2_200 });
    await reconcileStarted;

    releaseHistory();
    await vi.waitFor(() =>
      expect(
        fixture.frames.filter((frame) => frame.type === 'watch.hosted-conversation.snapshot')
      ).toHaveLength(1)
    );
    const snapshotIndex = fixture.frames.findIndex(
      (frame) => frame.type === 'watch.hosted-conversation.snapshot'
    );
    expect(fixture.frames[snapshotIndex]?.payload).toMatchObject({
      run: { id: 'run-1', status: 'RUNNING' }
    });
    expect(
      fixture.frames
        .slice(snapshotIndex + 1)
        .filter((frame) => frame.type === 'watch.hosted-conversation.event')
        .map((frame) => (frame.event as WorkbenchEvent).payload)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'run',
          run: expect.objectContaining({ id: 'run-1', status: 'RUNNING' })
        })
      ])
    );

    expect(
      fixture.frames.some(
        (frame) =>
          frame.type === 'watch.hosted-conversation.event' &&
          ((frame.event as WorkbenchEvent).payload as { run?: { status?: string } }).run?.status ===
            'SUCCEEDED'
      )
    ).toBe(false);
    releaseReconcile();
    await vi.waitFor(() =>
      expect(fixture.frames).toContainEqual(
        expect.objectContaining({
          type: 'watch.hosted-conversation.event',
          event: expect.objectContaining({
            payload: expect.objectContaining({
              kind: 'run',
              run: expect.objectContaining({ id: 'run-1', status: 'SUCCEEDED', completedAt: 2200 })
            })
          })
        })
      )
    );
    const terminalIndex = fixture.frames.findIndex(
      (frame) =>
        frame.type === 'watch.hosted-conversation.event' &&
        ((frame.event as WorkbenchEvent).payload as { run?: { status?: string } }).run?.status ===
          'SUCCEEDED'
    );
    const filesIndex = fixture.frames.findIndex(
      (frame) =>
        frame.type === 'watch.hosted-conversation.event' &&
        ((frame.event as WorkbenchEvent).payload as { kind?: string }).kind === 'files'
    );
    expect(filesIndex).toBeGreaterThan(snapshotIndex);
    expect(terminalIndex).toBeGreaterThan(filesIndex);
  });

  it('re-reads an initial Watch snapshot when rollback completes during its history read', async () => {
    const fixture = await watchFixture();
    const conversationId = await createConversation(fixture);
    const retained = rollbackTurn('turn-retained', 'Keep this message.', null);
    const removed = rollbackTurn('turn-removed', 'Remove this message.', 'turn-retained');
    let releaseInitialHistory!: () => void;
    const initialHistoryBlocked = new Promise<void>((resolve) => {
      releaseInitialHistory = resolve;
    });
    fixture.runtime.history
      .mockImplementationOnce(async () => {
        await initialHistoryBlocked;
        return { turns: [retained, removed], nextCursor: null };
      })
      .mockResolvedValueOnce({ turns: [retained, removed], nextCursor: null })
      .mockResolvedValue({ turns: [retained], nextCursor: null });

    await fixture.service.operations()['conversation.hosted.watch']!({
      conversationId,
      mode: 'initial',
      workbenchConnectionId: 'connection-rollback-during-initial',
      watchId: 'watch-rollback-during-initial',
      __workspaceWatchSessionHash: 'session-hash',
      __requestUserId: 7,
      __marAgentModels: [model]
    });
    await vi.waitFor(() => expect(fixture.runtime.history).toHaveBeenCalledTimes(2));

    await fixture.service.operations()['conversation.hosted.rollback']!({
      conversationId,
      turnId: removed.id,
      boundary: removed.rewind.before,
      __requestUserId: 7,
      __marAgentModels: [model]
    });
    expect(
      fixture.frames.filter(
        (frame) =>
          frame.type === 'watch.hosted-conversation.snapshot' &&
          frame.watchId === 'watch-rollback-during-initial'
      )
    ).toHaveLength(0);

    releaseInitialHistory();
    await vi.waitFor(() =>
      expect(
        fixture.frames.filter(
          (frame) =>
            frame.type === 'watch.hosted-conversation.snapshot' &&
            frame.watchId === 'watch-rollback-during-initial'
        )
      ).toHaveLength(1)
    );
    expect(
      fixture.frames.find(
        (frame) =>
          frame.type === 'watch.hosted-conversation.snapshot' &&
          frame.watchId === 'watch-rollback-during-initial'
      )?.payload
    ).toMatchObject({
      turns: [{ id: retained.id }]
    });
    expect(fixture.runtime.history).toHaveBeenCalledTimes(5);
  });

  it('publishes the authoritative file list after a projected upload or output is deleted', async () => {
    const fixture = await watchFixture();
    const conversationId = await createConversation(fixture);
    const paths = fixture.store.pathsForConversation(7, conversationId);
    await writeFile(join(paths.outputDirectory, 'remove.txt'), 'remove');
    const [file] = await fixture.store.reconcileFiles(7, conversationId);
    await fixture.service.operations()['conversation.hosted.watch']!({
      conversationId,
      mode: 'initial',
      workbenchConnectionId: 'connection-file-delete',
      watchId: 'watch-file-delete',
      __workspaceWatchSessionHash: 'session-hash',
      __requestUserId: 7,
      __marAgentModels: [model]
    });
    await vi.waitFor(() =>
      expect(
        fixture.frames.filter((frame) => frame.type === 'watch.hosted-conversation.snapshot')
      ).toHaveLength(1)
    );

    await expect(
      fixture.service.operations()['conversation.hosted.file.delete']!({
        conversationId,
        fileId: file!.id,
        __requestUserId: 7
      })
    ).resolves.toEqual({
      deletedFileId: file!.id,
      files: []
    });
    await vi.waitFor(() =>
      expect(
        fixture.frames.filter((frame) => frame.type === 'watch.hosted-conversation.event')
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conversationId,
            event: expect.objectContaining({
              payload: {
                conversationId,
                kind: 'files',
                files: [],
                error: null
              }
            })
          })
        ])
      )
    );
  });

  it('publishes self-contained configuration and template upgrade events', async () => {
    const fixture = await watchFixture();
    const conversationId = await createConversation(fixture);
    await fixture.service.operations()['conversation.hosted.watch']!({
      conversationId,
      mode: 'initial',
      workbenchConnectionId: 'connection-state',
      watchId: 'watch-state-1',
      __workspaceWatchSessionHash: 'session-hash',
      __requestUserId: 7,
      __marAgentModels: [model]
    });
    await vi.waitFor(() =>
      expect(
        fixture.frames.filter((frame) => frame.type === 'watch.hosted-conversation.snapshot')
      ).toHaveLength(1)
    );

    await fixture.service.operations()['conversation.hosted.config.update']!({
      conversationId,
      modelId: 'model-1',
      __requestUserId: 7,
      __marAgentModels: [model]
    });
    await seedUpgradeVersion(fixture.database, fixture.store);
    await fixture.service.operations()['conversation.hosted.message']!({
      conversationId,
      clientMessageId: 'message-upgrade-event',
      prompt: 'Use the upgraded template.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: model,
      __marAgentModels: [model]
    });

    await vi.waitFor(() =>
      expect(
        fixture.frames.filter((frame) => frame.type === 'watch.hosted-conversation.event')
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({
              payload: expect.objectContaining({
                kind: 'configuration',
                conversation: expect.objectContaining({ id: conversationId, modelId: 'model-1' })
              })
            })
          }),
          expect.objectContaining({
            event: expect.objectContaining({
              payload: expect.objectContaining({
                kind: 'upgrade',
                upgrade: expect.objectContaining({
                  status: 'SUCCEEDED',
                  previousVersionId: 'version-1',
                  activeVersionId: 'version-2'
                })
              })
            })
          })
        ])
      )
    );
  });

  it('still publishes a terminal Run when file reconciliation fails safely', async () => {
    const fixture = await watchFixture();
    const conversationId = await createConversation(fixture);
    await fixture.service.operations()['conversation.hosted.watch']!({
      conversationId,
      mode: 'initial',
      workbenchConnectionId: 'connection-failed-files',
      watchId: 'watch-failed-files',
      __workspaceWatchSessionHash: 'session-hash',
      __requestUserId: 7,
      __marAgentModels: [model]
    });
    await vi.waitFor(() =>
      expect(
        fixture.frames.filter((frame) => frame.type === 'watch.hosted-conversation.snapshot')
      ).toHaveLength(1)
    );
    await fixture.service.operations()['conversation.hosted.message']!({
      conversationId,
      clientMessageId: 'message-failed-files',
      prompt: 'Finish despite an invalid file.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: model,
      __marAgentModels: [model]
    });
    const paths = fixture.store.pathsForConversation(7, conversationId);
    const outside = join(fixture.store.rootDirectory, '..', 'outside-file.txt');
    await writeFile(outside, 'outside');
    await symlink(outside, join(paths.outputDirectory, 'invalid.txt'));
    fixture.completeRun({ status: 'SUCCEEDED', completedAt: 2_300 });

    await vi.waitFor(() =>
      expect(
        fixture.frames.filter((frame) => frame.type === 'watch.hosted-conversation.event')
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({
              payload: expect.objectContaining({
                kind: 'run',
                run: expect.objectContaining({ status: 'SUCCEEDED', completedAt: 2_300 })
              })
            })
          })
        ])
      )
    );
  });

  it('releases the active Hosted Watch when the conversation is permanently deleted', async () => {
    const fixture = await watchFixture();
    const conversationId = await createConversation(fixture);
    const watch = fixture.service.operations()['conversation.hosted.watch']!;
    await watch({
      conversationId,
      mode: 'initial',
      workbenchConnectionId: 'connection-delete',
      watchId: 'watch-delete-1',
      __workspaceWatchSessionHash: 'session-hash',
      __requestUserId: 7,
      __marAgentModels: [model]
    });
    await vi.waitFor(() =>
      expect(
        fixture.frames.filter((frame) => frame.type === 'watch.hosted-conversation.snapshot')
      ).toHaveLength(1)
    );

    await fixture.service.operations()['conversation.hosted.delete']!({
      conversationId,
      __requestUserId: 7
    });
    expect(
      fixture.service.publishRuntimeEvent(conversationId, {
        kind: 'RUN',
        executionId: 'after-delete',
        sequence: 10,
        createdAt: 3_000,
        payload: { status: 'RUNNING' }
      })
    ).toBe(false);
    await expect(
      watch({
        conversationId,
        mode: 'renew',
        workbenchConnectionId: 'connection-delete',
        watchId: 'watch-delete-1',
        __workspaceWatchSessionHash: 'session-hash',
        __requestUserId: 7,
        __marAgentModels: [model]
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_NOT_AUTHORIZED');
  });

  it('shares one Session Watch slot with native sessions and replaces leases in both directions', async () => {
    const fixture = await watchFixture();
    const conversationId = await createConversation(fixture);
    const nativeFrames: unknown[] = [];
    const session = {
      id: 'session-native-1',
      workspaceId: 'workspace-1',
      externalSessionId: 'external-native-1'
    } as NodeAgentSession;
    const native = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => false,
      refreshActivity: async () => undefined,
      present: () => ({ activity: 'IDLE' }),
      readPage: async () => ({ turns: [] }),
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => nativeFrames.push(event),
      nodeId: () => 'node-1',
      nodeGeneration: () => 'generation-hosted',
      sessionWatchSlots: fixture.slots
    });
    const nativeWatch = native.operations()['session.watch']!;

    await nativeWatch({
      sessionId: session.id,
      workspaceId: session.workspaceId,
      workbenchConnectionId: 'connection-shared',
      watchId: 'watch-native-1',
      mode: 'initial',
      __workspaceWatchSessionHash: 'session-hash'
    });
    await vi.waitFor(() => expect(nativeFrames).toHaveLength(1));

    await fixture.service.operations()['conversation.hosted.watch']!({
      conversationId,
      mode: 'initial',
      workbenchConnectionId: 'connection-shared',
      watchId: 'watch-hosted-2',
      __workspaceWatchSessionHash: 'session-hash',
      __requestUserId: 7,
      __marAgentModels: [model]
    });
    await vi.waitFor(() =>
      expect(
        fixture.frames.filter(
          (frame) =>
            frame.type === 'watch.hosted-conversation.snapshot' &&
            frame.workbenchConnectionId === 'connection-shared'
        )
      ).toHaveLength(1)
    );
    expect(
      native.emitRealtime(session.id, {
        sequence: 1,
        category: 'run',
        payload: { run: { id: 'run-native' } }
      })
    ).toBe(false);

    await nativeWatch({
      sessionId: session.id,
      workspaceId: session.workspaceId,
      workbenchConnectionId: 'connection-shared',
      watchId: 'watch-native-2',
      mode: 'initial',
      __workspaceWatchSessionHash: 'session-hash'
    });
    const hostedEventCount = fixture.frames.filter(
      (frame) => frame.type === 'watch.hosted-conversation.event'
    ).length;
    fixture.service.publishRuntimeEvent(conversationId, {
      kind: 'RUN',
      executionId: 'run-2',
      sequence: 3,
      createdAt: 2_200,
      payload: { status: 'RUNNING' }
    });
    expect(
      fixture.frames.filter((frame) => frame.type === 'watch.hosted-conversation.event')
    ).toHaveLength(hostedEventCount);
    await expect(
      fixture.service.operations()['conversation.hosted.watch']!({
        conversationId,
        mode: 'renew',
        workbenchConnectionId: 'connection-shared',
        watchId: 'watch-hosted-2',
        __workspaceWatchSessionHash: 'session-hash',
        __requestUserId: 7,
        __marAgentModels: [model]
      })
    ).rejects.toThrow('SESSION_WATCH_NOT_FOUND');
    native.clear();
  });
});

const model: MarAgentRuntimeModelConfiguration = {
  id: 'model-1',
  name: 'Model One',
  protocol: 'OPENAI_RESPONSES',
  baseUrl: 'https://models.example.test/v1',
  apiKey: 'secret',
  modelId: 'model-one',
  contextWindowTokens: 100_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: ['high'],
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true
};

const modelTwo: MarAgentRuntimeModelConfiguration = {
  ...model,
  id: 'model-2',
  name: 'Model Two',
  apiKey: 'secret-2',
  modelId: 'model-two'
};

const draft: ConversationTemplateDraft = {
  templateId: 'template-1',
  nodeId: 'node-1',
  workspaceId: 'workspace-1',
  revision: 1,
  name: 'Research',
  description: 'Research template',
  allowedModels: [{ modelId: 'model-one', name: 'Model One' }],
  defaultModelId: 'model-one',
  mcpIds: [],
  networkMode: 'NONE',
  quotas: {
    maxStorageBytes: 1_000_000,
    maxUploadBytes: 100_000
  },
  updatedAt: 1_000
};

async function watchFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mar-node-hosted-watch-'));
  directories.push(directory);
  const dataDirectory = join(directory, 'data');
  const database = new NodeDatabase(join(directory, 'node.sqlite'), 'node-1');
  const store = new HostedConversationStore({
    dataDirectory,
    rootDirectory: join(dataDirectory, 'hosted'),
    nodeId: 'node-1',
    database
  });
  await store.initialize();
  await seedVersion(database, store);
  let completeRun!: (completion: {
    status: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
    completedAt: number;
    title?: string;
  }) => void;
  const completion = new Promise<{
    status: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
    completedAt: number;
    title?: string;
  }>((resolve) => {
    completeRun = resolve;
  });
  const runtime = {
    createSession: vi.fn<HostedConversationRuntime['createSession']>(async () => ({
      sessionId: 'session-hosted-1'
    })),
    history: vi.fn<HostedConversationRuntime['history']>(async () => ({
      turns: [],
      nextCursor: null
    })),
    rollback: vi.fn<HostedConversationRuntime['rollback']>(async () => ({
      lastActivityAt: 2_000
    })),
    startRun: vi.fn<HostedConversationRuntime['startRun']>(async () => ({
      run: { id: 'run-1', status: 'RUNNING', startedAt: 2_000, completedAt: null },
      completion,
      cancel: vi.fn(() => true)
    })),
    releaseSession: vi.fn<HostedConversationRuntime['releaseSession']>(async () => undefined)
  } satisfies HostedConversationRuntime;
  const frames: Array<Record<string, unknown>> = [];
  const events: WorkbenchEvent[] = [];
  const slots = new SessionWatchSlotCoordinator();
  const ordinaryDelivery = vi.fn(() => true);
  const workbench = new WorkbenchEventService({
    send: (envelope) => events.push(envelope.payload as WorkbenchEvent),
    accepts: () => true,
    projection: {
      getRun: () => undefined,
      conversationTurnForRun: () => undefined,
      progress: () => {
        throw new Error('unexpected ordinary progress query');
      }
    },
    emitRealtime: ordinaryDelivery
  });
  let id = 0;
  const service = new HostedConversationNodeService({
    database,
    store,
    runtime,
    nodeId: () => 'node-1',
    nodeGeneration: () => 'generation-hosted',
    sessionWatchSlots: slots,
    emitWatchEvent: (frame) => frames.push(frame as Record<string, unknown>),
    nextWorkbenchEvent: (payload) => workbench.next('hosted-conversation', payload),
    emitWorkbenchEvent: (event) => workbench.publish(event),
    processExecutorFactory: vi.fn(() => ({ spawn: vi.fn() }) as never),
    id: () => `conversation-${++id}`,
    readImage: vi.fn(async () => undefined)
  });
  return {
    database,
    store,
    runtime,
    frames,
    events,
    slots,
    service,
    completeRun,
    workbench,
    ordinaryDelivery
  };
}

function rollbackTurn(id: string, text: string, before: string | null) {
  const userItemId = `${id}:user`;
  return {
    id,
    sessionId: 'session-hosted-1',
    runId: `run-${id}`,
    userItemId,
    status: 'SUCCEEDED' as const,
    model: 'model-1',
    effort: null,
    access: 'full-access' as const,
    rewind: { before, after: id },
    items: [
      {
        id: userItemId,
        sessionId: 'session-hosted-1',
        turnId: id,
        runId: `run-${id}`,
        parentItemId: null,
        sourceSequence: null,
        revision: 0,
        kind: 'user_message' as const,
        status: 'COMPLETED' as const,
        payload: {
          clientMessageId: `message-${id}`,
          text,
          contexts: [],
          delivery: 'ACCEPTED'
        },
        startedAt: 1,
        completedAt: 2
      }
    ],
    startedAt: 1,
    completedAt: 2
  };
}

async function createConversation(fixture: Awaited<ReturnType<typeof watchFixture>>) {
  const result = (await fixture.service.operations()['conversation.hosted.create']!({
    templateId: 'template-1',
    clientRequestId: 'create-watch-1',
    __requestUserId: 7,
    __template: {
      id: 'template-1',
      nodeId: 'node-1',
      name: 'Research',
      description: 'Research template',
      status: 'ACTIVE',
      currentVersionId: 'version-1',
      available: true,
      createdAt: 1_000,
      updatedAt: 1_000
    },
    __marAgentModels: [model]
  })) as { conversation: { id: string } };
  return result.conversation.id;
}

async function seedUpgradeVersion(
  database: NodeDatabase,
  store: HostedConversationStore,
  draftOverride: Partial<ConversationTemplateDraft> = {}
) {
  const storageKey = 'template_version_2';
  const directory = store.templateVersionDirectory(storageKey);
  await Promise.all(
    ['content', 'content/inbox', 'content/output'].map((relativePath) =>
      mkdir(join(directory, relativePath), { recursive: true })
    )
  );
  const upgradedDraft = {
    ...draft,
    revision: 2,
    updatedAt: 1_500,
    ...draftOverride
  };
  const directories: string[] = [];
  const entries: Record<string, unknown>[] = [];
  const contentHash = createHash('sha256').update('').digest('hex');
  const manifest = {
    schemaVersion: 2,
    sourceWorkspacePath: '/projects/watch-template',
    templateId: 'template-1',
    versionId: 'version-2',
    versionNumber: 2,
    draftRevision: 2,
    hostPolicyVersion: 1,
    publishedByUserId: 1,
    publishedAt: 1_500,
    draft: upgradedDraft,
    mcpServers: [],
    mcpConfigHash: EMPTY_MCP_CONFIG_HASH,
    directories,
    entries,
    contentHash
  };
  const manifestJson = JSON.stringify(manifest);
  const manifestHash = createHash('sha256').update(manifestJson).digest('hex');
  await writeFile(join(directory, 'manifest.json'), manifestJson);
  await sealTemplateFixture(directory);
  database.raw
    .prepare(
      `INSERT INTO conversation_template_versions
       (id,template_id,version_number,draft_revision,status,storage_key,manifest,content_hash,
        mcp_config_hash,manifest_hash,file_count,total_bytes,host_policy_version,published_by_user_id,
        published_at,reference_count)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`
    )
    .run(
      'version-2',
      'template-1',
      2,
      2,
      'AVAILABLE',
      storageKey,
      manifestJson,
      contentHash,
      EMPTY_MCP_CONFIG_HASH,
      manifestHash,
      0,
      0,
      1,
      1,
      1_500
    );
}

async function seedVersion(database: NodeDatabase, store: HostedConversationStore) {
  const storageKey = 'template_version_1';
  const directory = store.templateVersionDirectory(storageKey);
  await Promise.all(
    ['content', 'content/inbox', 'content/output'].map((relativePath) =>
      mkdir(join(directory, relativePath), { recursive: true })
    )
  );
  const content = Buffer.from('hosted');
  const sha256 = createHash('sha256').update(content).digest('hex');
  await writeFile(join(directory, 'content', 'instructions.md'), content);
  const files = [
    {
      relativePath: 'instructions.md',
      size: content.byteLength,
      executable: false,
      sha256
    }
  ];
  const directories: string[] = [];
  const entries = files.map((file) => ({ kind: 'FILE' as const, ...file }));
  const contentHash = createHash('sha256')
    .update(
      entries
        .map(
          (entry) =>
            `FILE\0${entry.relativePath}\0${entry.size}\0${entry.executable ? 1 : 0}\0${entry.sha256}`
        )
        .join('\n')
    )
    .digest('hex');
  const manifest = {
    schemaVersion: 2,
    sourceWorkspacePath: '/projects/watch-template',
    templateId: 'template-1',
    versionId: 'version-1',
    versionNumber: 1,
    draftRevision: 1,
    hostPolicyVersion: 1,
    publishedByUserId: 1,
    publishedAt: 1_001,
    draft,
    mcpServers: [],
    mcpConfigHash: EMPTY_MCP_CONFIG_HASH,
    directories,
    entries,
    contentHash
  };
  const manifestJson = JSON.stringify(manifest);
  const manifestHash = createHash('sha256').update(manifestJson).digest('hex');
  await writeFile(join(directory, 'manifest.json'), manifestJson);
  await sealTemplateFixture(directory);
  database.raw
    .prepare(
      `INSERT INTO conversation_template_versions
       (id,template_id,version_number,draft_revision,status,storage_key,manifest,content_hash,
        mcp_config_hash,manifest_hash,file_count,total_bytes,host_policy_version,published_by_user_id,
        published_at,reference_count)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`
    )
    .run(
      'version-1',
      'template-1',
      1,
      1,
      'AVAILABLE',
      storageKey,
      manifestJson,
      contentHash,
      EMPTY_MCP_CONFIG_HASH,
      manifestHash,
      files.length,
      content.byteLength,
      1,
      1,
      1_001
    );
}

const EMPTY_MCP_CONFIG_HASH = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';

async function sealTemplateFixture(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isDirectory()) {
    for (const entry of await readdir(path)) await sealTemplateFixture(join(path, entry));
    await chmod(path, 0o555);
    return;
  }
  await chmod(path, 0o444);
}

async function makeWritable(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await makeWritable(join(path, entry));
    return;
  }
  await chmod(path, 0o600);
}
