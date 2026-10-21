import { describe, expect, it, vi } from 'vitest';
import { HostedConversationActivityService } from '../../ee/server/src/service/hosted-conversation-activity-service.js';

describe('Server hosted conversation activity service', () => {
  it('Delivers activity to the initiating user only when template authorization and owning Node match', async () => {
    const push = vi.fn();
    const templates = {
      assertCanUse: vi.fn(async () => ({ id: 'template-1', nodeId: 'node-1' }))
    };
    const service = new HostedConversationActivityService(templates as never, push);

    expect(
      await service.consume('node-1', {
        userId: 7,
        templateId: 'template-1',
        conversationId: 'conversation-1',
        activity: {
          status: 'RUNNING',
          version: 2,
          updatedAt: 3
        }
      })
    ).toBe(true);
    expect(templates.assertCanUse).toHaveBeenCalledWith(7, 'template-1');
    expect(push).toHaveBeenCalledWith(7, {
      type: 'hosted-conversation.activity',
      nodeId: 'node-1',
      conversationId: 'conversation-1',
      activity: {
        status: 'RUNNING',
        version: 2,
        updatedAt: 3
      }
    });
  });

  it('Rejects invalid projections, unauthorized templates, and mismatched owning Nodes', async () => {
    const push = vi.fn();
    const templates = {
      assertCanUse: vi
        .fn()
        .mockRejectedValueOnce(new Error('CONVERSATION_TEMPLATE_NOT_AUTHORIZED'))
        .mockResolvedValueOnce({ id: 'template-1', nodeId: 'node-2' })
    };
    const service = new HostedConversationActivityService(templates as never, push);
    const payload = {
      userId: 7,
      templateId: 'template-1',
      conversationId: 'conversation-1',
      activity: {
        status: 'STARTING',
        version: 1,
        updatedAt: 2
      }
    };

    expect(await service.consume('node-1', { ...payload, userId: 0 })).toBe(false);
    expect(await service.consume('node-1', payload)).toBe(false);
    expect(await service.consume('node-1', payload)).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });
});
