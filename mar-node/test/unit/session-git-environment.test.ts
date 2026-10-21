import { describe, expect, it, vi } from 'vitest';
import { SessionMessageService } from '../../src/service/session-message-service.js';

describe('Channel Git environment forwarding', () => {
  it('preserves the authenticated environment when adapting a channel message', async () => {
    const service = new SessionMessageService({
      runtime: {
        getAgentSession: () => ({ id: 'session', channelToken: 'channel-test-token' })
      }
    } as unknown as ConstructorParameters<typeof SessionMessageService>[0]);
    const message = vi
      .spyOn(service as unknown as { message(input: unknown): Promise<unknown> }, 'message')
      .mockResolvedValue({});
    const environment = { GIT_AUTHOR_NAME: 'User A', MAR_GIT_TOKEN: 'git-test-token' };
    await service.operations()['session.channel.message']!({
      sessionId: 'session',
      token: 'channel-test-token',
      clientMessageId: 'message',
      content: 'commit changes',
      __requestUserId: 7,
      secretEnvironment: environment
    });
    expect(message).toHaveBeenCalledWith(
      expect.objectContaining({
        __requestUserId: 7,
        deliveryIntent: 'QUEUE',
        secretEnvironment: environment
      })
    );
    await expect(
      service.operations()['session.channel.message']!({
        sessionId: 'session',
        token: 'wrong-token',
        clientMessageId: 'other',
        content: 'commit changes',
        __requestUserId: 8,
        secretEnvironment: environment
      })
    ).rejects.toThrow('SESSION_CHANNEL_UNAVAILABLE');
    expect(message).toHaveBeenCalledOnce();
  });
});
