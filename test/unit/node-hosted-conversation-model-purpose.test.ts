import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupHostedConversationRuntimeFixtures,
  createConversation,
  hostedHistoryPage,
  modelOne,
  modelOneAlternative,
  runtimeFixture
} from './support/hosted-conversation-runtime-fixture.js';

afterEach(cleanupHostedConversationRuntimeFixtures);

describe('Hosted conversation model purpose', () => {
  it('filters Composer choices and default selection without removing auxiliary runtime models', async () => {
    const fixture = await runtimeFixture();
    const auxiliary = { ...modelOne, id: 'auxiliary', conversationModel: false };
    const catalog = [auxiliary, modelOne];
    const conversation = await createConversation(fixture, catalog);
    expect(conversation.modelId).toBe(modelOne.id);
    expect(fixture.runtime.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultModelId: modelOne.id,
        models: [
          expect.objectContaining({ id: 'auxiliary', conversationModel: false }),
          expect.objectContaining({ id: modelOne.id })
        ]
      })
    );
    const snapshot = (await fixture.service.operations()['conversation.hosted.get']!({
      conversationId: conversation.id,
      __requestUserId: 7,
      __marAgentModels: catalog
    })) as { models: { id: string }[] };
    expect(snapshot.models.map(({ id }) => id)).toEqual([modelOne.id]);
    await expect(
      fixture.service.operations()['conversation.hosted.message']!({
        conversationId: conversation.id,
        clientMessageId: 'invalid-auxiliary',
        prompt: 'Do not use the auxiliary model.',
        attachmentIds: [],
        modelId: auxiliary.id,
        __requestUserId: 7,
        __marAgentModels: catalog
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_MODEL_NOT_AVAILABLE');
    expect(fixture.runtime.startRun).not.toHaveBeenCalled();
  });

  it('keeps history readable after purpose changes and requires an explicit replacement model', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    const catalog = [{ ...modelOne, conversationModel: false }, modelOneAlternative];
    const turn = {
      id: 'existing-turn',
      sessionId: 'session-1',
      runId: 'existing-run',
      userItemId: 'existing-turn:user',
      status: 'SUCCEEDED',
      model: modelOne.id,
      effort: null,
      access: 'full-access',
      items: [],
      startedAt: 1000,
      completedAt: 1100
    };
    fixture.runtime.history.mockResolvedValueOnce(hostedHistoryPage([turn], 'older-turns'));
    const snapshot = (await fixture.service.operations()['conversation.hosted.get']!({
      conversationId: conversation.id,
      __requestUserId: 7,
      __marAgentModels: catalog
    })) as {
      conversation: { modelId: string };
      models: { id: string }[];
      turns: unknown[];
      historyNextCursor: string | null;
    };
    expect(snapshot.conversation.modelId).toBe(modelOne.id);
    expect(snapshot.models.map(({ id }) => id)).toEqual([modelOneAlternative.id]);
    expect(snapshot.turns).toEqual([turn]);
    expect(snapshot.historyNextCursor).toBe('older-turns');
    const message = {
      conversationId: conversation.id,
      clientMessageId: 'purpose-change',
      prompt: 'Continue.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModels: catalog
    };
    await expect(
      fixture.service.operations()['conversation.hosted.message']!(message)
    ).rejects.toThrow('HOSTED_CONVERSATION_MODEL_NOT_AVAILABLE');
    expect(fixture.runtime.startRun).not.toHaveBeenCalled();
    await fixture.service.operations()['conversation.hosted.message']!({
      ...message,
      clientMessageId: 'selected-replacement',
      modelId: modelOneAlternative.id
    });
    expect(fixture.runtime.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: modelOneAlternative.id })
    );
  });
});
