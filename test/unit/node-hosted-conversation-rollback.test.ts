import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupHostedConversationRuntimeFixtures,
  createConversation,
  deferredRun,
  hostedHistoryPage,
  modelOne,
  runtimeFixture
} from './support/hosted-conversation-runtime-fixture.js';

afterEach(cleanupHostedConversationRuntimeFixtures);

describe('Node hosted conversation runtime', () => {
  it('validates the authoritative terminal user turn and atomically rolls back the assigned Session', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    const paths = fixture.store.pathsForConversation(7, conversation.id);
    await writeFile(join(paths.outputDirectory, 'keep-after-rollback.txt'), 'keep');
    const [retainedFile] = await fixture.store.reconcileFiles(7, conversation.id);
    const original = fixture.store.requireConversation(7, conversation.id);
    const target = hostedTurn('turn-2', 'Rollback this message.', 'turn-1');
    fixture.runtime.history.mockResolvedValueOnce(
      hostedHistoryPage([hostedTurn('turn-1', 'Keep this message.', null), target])
    );
    fixture.runtime.history.mockResolvedValueOnce(
      hostedHistoryPage([hostedTurn('turn-1', 'Keep this message.', null)])
    );
    const historyCallsBeforeRollback = fixture.runtime.history.mock.calls.length;

    const snapshot = (await fixture.service.operations()['conversation.hosted.rollback']!({
      conversationId: conversation.id,
      turnId: 'turn-2',
      boundary: 'turn-1',
      __requestUserId: 7,
      __marAgentModels: [modelOne]
    })) as {
      nodeAppVersion: string;
      conversation: typeof conversation;
      turns: Array<{ id: string }>;
      files: Array<{ id: string; relativePath: string }>;
    };

    expect(fixture.runtime.rollback).toHaveBeenCalledWith({
      conversationId: conversation.id,
      sessionId: conversation.sessionId,
      homeDirectory: expect.stringMatching(/\/home$/u),
      modelId: conversation.modelId,
      boundaryTurnId: 'turn-1'
    });
    expect(fixture.runtime.history).toHaveBeenCalledTimes(historyCallsBeforeRollback + 2);
    expect(snapshot.nodeAppVersion).toBe('0.9.55');
    expect(snapshot.turns.map((turn) => turn.id)).toEqual(['turn-1']);
    expect(snapshot.files).toEqual([
      expect.objectContaining({
        id: retainedFile!.id,
        relativePath: 'keep-after-rollback.txt'
      })
    ]);
    await expect(
      readFile(join(paths.outputDirectory, 'keep-after-rollback.txt'), 'utf8')
    ).resolves.toBe('keep');
    expect(snapshot.conversation).toMatchObject({
      id: original.id,
      sessionId: original.sessionId,
      templateId: original.templateId,
      activeVersionId: original.activeVersionId,
      modelId: original.modelId,
      title: original.title,
      pinnedAt: original.pinnedAt
    });
  });

  it('rejects rollback while the authoritative activity remains non-idle', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    const service = fixture.service as unknown as {
      readonly activities: Map<
        string,
        {
          readonly status: 'STARTING' | 'RUNNING' | 'CANCELLING';
          readonly version: number;
          readonly updatedAt: number;
        }
      >;
    };
    const rollback = fixture.service.operations()['conversation.hosted.rollback']!;
    const input = {
      conversationId: conversation.id,
      turnId: 'turn-2',
      boundary: 'turn-1',
      __requestUserId: 7,
      __marAgentModels: [modelOne]
    };
    const historyCallsBeforeRollback = fixture.runtime.history.mock.calls.length;

    for (const status of ['STARTING', 'RUNNING', 'CANCELLING'] as const) {
      service.activities.set(conversation.id, { status, version: 1, updatedAt: 2_000 });
      await expect(rollback(input)).rejects.toThrow('HOSTED_CONVERSATION_RUN_ACTIVE');
    }

    expect(fixture.runtime.history).toHaveBeenCalledTimes(historyCallsBeforeRollback);
    expect(fixture.runtime.rollback).not.toHaveBeenCalled();
  });

  it('rejects forged, non-user, and non-terminal rollback targets before touching SDK history', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    const rollback = fixture.service.operations()['conversation.hosted.rollback']!;
    const forged = hostedTurn('turn-2', 'Do not roll back.', 'turn-1');
    fixture.runtime.history.mockResolvedValueOnce(hostedHistoryPage([forged]));

    await expect(
      rollback({
        conversationId: conversation.id,
        turnId: 'turn-2',
        boundary: 'forged-boundary',
        __requestUserId: 7,
        __marAgentModels: [modelOne]
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_ROLLBACK_TARGET_INVALID');

    fixture.runtime.history.mockResolvedValueOnce(
      hostedHistoryPage([
        {
          ...forged,
          status: 'RUNNING',
          completedAt: null
        }
      ])
    );
    await expect(
      rollback({
        conversationId: conversation.id,
        turnId: 'turn-2',
        boundary: 'turn-1',
        __requestUserId: 7,
        __marAgentModels: [modelOne]
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_ROLLBACK_TARGET_INVALID');

    fixture.runtime.history.mockResolvedValueOnce(
      hostedHistoryPage([
        {
          ...forged,
          userItemId: null,
          items: forged.items.map((item) => ({
            ...item,
            kind: 'assistant_message',
            payload: { text: 'Agent output', format: 'markdown', model: null }
          }))
        }
      ])
    );
    await expect(
      rollback({
        conversationId: conversation.id,
        turnId: 'turn-2',
        boundary: 'turn-1',
        __requestUserId: 7,
        __marAgentModels: [modelOne]
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_ROLLBACK_TARGET_INVALID');
    expect(fixture.runtime.rollback).not.toHaveBeenCalled();

    fixture.runtime.history.mockResolvedValueOnce(hostedHistoryPage([forged]));
    fixture.runtime.rollback.mockRejectedValueOnce(new Error('MAR_AGENT_ROLLBACK_TARGET_INVALID'));
    await expect(
      rollback({
        conversationId: conversation.id,
        turnId: 'turn-2',
        boundary: 'turn-1',
        __requestUserId: 7,
        __marAgentModels: [modelOne]
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_ROLLBACK_TARGET_INVALID');
  });

  it('serializes rollback against message admission and pushes the authoritative snapshot to Watch', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    const operations = fixture.service.operations();
    await operations['conversation.hosted.watch']!({
      conversationId: conversation.id,
      mode: 'initial',
      workbenchConnectionId: 'connection-rollback',
      watchId: 'watch-rollback',
      __workspaceWatchSessionHash: 'session-hash',
      __requestUserId: 7,
      __marAgentModels: [modelOne]
    });
    await vi.waitFor(() =>
      expect(
        fixture.watchFrames.filter(
          (frame) => (frame as { type?: string }).type === 'watch.hosted-conversation.snapshot'
        )
      ).toHaveLength(1)
    );

    let releaseHistory!: () => void;
    const historyBlocked = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    fixture.runtime.history.mockImplementationOnce(async () => {
      await historyBlocked;
      return hostedHistoryPage([
        hostedTurn('turn-1', 'Keep this message.', null),
        hostedTurn('turn-2', 'Rollback this message.', 'turn-1')
      ]);
    });
    fixture.runtime.history.mockResolvedValueOnce(
      hostedHistoryPage([hostedTurn('turn-1', 'Keep this message.', null)])
    );
    const rollback = operations['conversation.hosted.rollback']!({
      conversationId: conversation.id,
      turnId: 'turn-2',
      boundary: 'turn-1',
      __requestUserId: 7,
      __marAgentModels: [modelOne]
    });

    await expect(
      operations['conversation.hosted.message']!({
        conversationId: conversation.id,
        clientMessageId: 'message-during-rollback',
        prompt: 'This must not start.',
        attachmentIds: [],
        __requestUserId: 7,
        __marAgentModel: modelOne,
        __marAgentModels: [modelOne]
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_STATE_INVALID');
    expect(fixture.runtime.startRun).not.toHaveBeenCalled();
    releaseHistory();
    await rollback;

    await vi.waitFor(() =>
      expect(
        fixture.watchFrames.filter(
          (frame) => (frame as { type?: string }).type === 'watch.hosted-conversation.snapshot'
        )
      ).toHaveLength(2)
    );
    expect(fixture.watchFrames.at(-1)).toMatchObject({
      type: 'watch.hosted-conversation.snapshot',
      conversationId: conversation.id,
      payload: {
        turns: [{ id: 'turn-1' }]
      }
    });
  });

  it('rejects deletion while rollback owns the conversation history mutation', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    const operations = fixture.service.operations();
    let releaseHistory!: () => void;
    const historyBlocked = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    fixture.runtime.history.mockImplementationOnce(async () => {
      await historyBlocked;
      return hostedHistoryPage([
        hostedTurn('turn-1', 'Keep this message.', null),
        hostedTurn('turn-2', 'Rollback this message.', 'turn-1')
      ]);
    });
    const rollback = operations['conversation.hosted.rollback']!({
      conversationId: conversation.id,
      turnId: 'turn-2',
      boundary: 'turn-1',
      __requestUserId: 7,
      __marAgentModels: [modelOne]
    });

    await expect(
      operations['conversation.hosted.delete']!({
        conversationId: conversation.id,
        __requestUserId: 7
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_STATE_INVALID');
    expect(fixture.store.requireConversation(7, conversation.id).id).toBe(conversation.id);

    releaseHistory();
    await rollback;
  });

  it('rejects rollback while a message is starting, active, or settling', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    const operations = fixture.service.operations();
    const pending = deferredRun('run-rollback-blocked');
    let releaseStart!: () => void;
    const startBlocked = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    fixture.runtime.startRun.mockImplementationOnce(async () => {
      await startBlocked;
      fixture.pendingRuns.push(pending);
      return pending.handle;
    });
    const message = operations['conversation.hosted.message']!({
      conversationId: conversation.id,
      clientMessageId: 'message-rollback-blocked',
      prompt: 'Start.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: modelOne,
      __marAgentModels: [modelOne]
    });
    await Promise.resolve();
    const rollbackInput = {
      conversationId: conversation.id,
      turnId: 'turn-2',
      boundary: 'turn-1',
      __requestUserId: 7,
      __marAgentModels: [modelOne]
    };
    await expect(operations['conversation.hosted.rollback']!(rollbackInput)).rejects.toThrow(
      'HOSTED_CONVERSATION_RUN_ACTIVE'
    );

    releaseStart();
    await message;
    await expect(operations['conversation.hosted.rollback']!(rollbackInput)).rejects.toThrow(
      'HOSTED_CONVERSATION_RUN_ACTIVE'
    );
    pending.complete({ status: 'SUCCEEDED', completedAt: 6_000 });
    await vi.waitFor(() =>
      expect(
        fixture.store.findMessage(7, conversation.id, 'message-rollback-blocked')
      ).toMatchObject({ status: 'SUCCEEDED' })
    );
  });
});

function hostedTurn(id: string, text: string, before: string | null) {
  const userItemId = `${id}:user`;
  return {
    id,
    sessionId: 'session-1',
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
        sessionId: 'session-1',
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
