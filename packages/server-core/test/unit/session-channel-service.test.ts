import { describe, expect, it, vi } from 'vitest';
import { parseComposerTags } from '@myagentroam/protocol';
import { SessionChannelService } from '../../src/session-channel-service.js';

const context = {
  nodeId: 'node-one',
  workspaceId: 'workspace-one',
  sessionId: 'session-one',
  user: { userId: 7, username: 'owner', sessionHash: 'share-fingerprint' }
};
const origin = {
  source: 'WEB_SHARE' as const,
  channelId: 'share-one',
  senderId: 'visitor-one',
  name: 'Alice'
};

describe('Session Channel entry', () => {
  it('delegates input with provenance, existing message identity and delivery intent', async () => {
    const receipt = { delivery: 'QUEUED', queueItemId: 'queued-one' };
    const submitMessage = vi.fn().mockResolvedValue(receipt);
    const interrupt = vi.fn();
    const service = new SessionChannelService({
      submitMessage,
      interrupt,
      executeCommand: vi.fn()
    });
    const message = {
      clientMessageId: 'message-one',
      content: 'Continue',
      attachmentIds: ['attachment-one'],
      deliveryIntent: 'REPLACE_CURRENT' as const,
      modelId: 'selected-model'
    };
    expect(await service.submitMessage(context, { origin, message })).toBe(receipt);
    const [target, submitted] = submitMessage.mock.calls[0]!;
    expect(target).toBe(context);
    expect(submitted).toMatchObject({ ...message, content: expect.any(String) });
    expect(parseComposerTags(submitted.content)).toMatchObject([
      { kind: 'mar_channel', payload: origin },
      { kind: 'text', text: '\nContinue' }
    ]);
    expect(message.content).toBe('Continue');
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('retains attachment-only input and returns the original interruption result', async () => {
    const submitMessage = vi.fn();
    const result = { interrupted: true };
    const interrupt = vi.fn().mockResolvedValue(result);
    const service = new SessionChannelService({
      submitMessage,
      interrupt,
      executeCommand: vi.fn()
    });
    await service.submitMessage(context, {
      origin,
      message: { clientMessageId: 'attachment-only', content: '', attachmentIds: ['file'] }
    });
    expect(parseComposerTags(submitMessage.mock.calls[0]![1].content)).toMatchObject([
      { kind: 'mar_channel', payload: origin }
    ]);
    expect(await service.interrupt(context)).toBe(result);
    expect(interrupt).toHaveBeenCalledWith(context);
  });

  it('does not swallow authorization or Node errors or dispatch invalid provenance', async () => {
    const failure = new Error('NODE_NOT_AUTHORIZED');
    const submitMessage = vi.fn().mockRejectedValue(failure);
    const service = new SessionChannelService({
      submitMessage,
      interrupt: vi.fn(),
      executeCommand: vi.fn()
    });
    await expect(
      service.submitMessage(context, {
        origin,
        message: { content: 'Continue', clientMessageId: 'one' }
      })
    ).rejects.toBe(failure);
    submitMessage.mockClear();
    await expect(
      service.submitMessage(context, {
        origin: { ...origin, name: '' },
        message: { content: 'Continue', clientMessageId: 'two' }
      })
    ).rejects.toThrow('COMPOSER_TAG_INVALID');
    expect(submitMessage).not.toHaveBeenCalled();
  });
});
