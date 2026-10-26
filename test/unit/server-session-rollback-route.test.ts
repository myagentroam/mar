import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE_NAME } from '../../packages/server-core/src/auth.js';
import { sendError } from '../../packages/server-core/src/http-errors.js';
import { hashOpaque } from '../../packages/server-core/src/session-token.js';
import { registerSessionRunRoutes } from '../../packages/server-core/src/session-run-routes.js';

describe('Server ordinary Session rollback route', () => {
  it('forwards a selected itemId and rejects invalid selectors before contacting Node', async () => {
    const csrfToken = 'csrf-token';
    const requestNode = vi.fn(async () => ({ session: { id: 'session-1' } }));
    const app = Fastify();
    registerSessionRunRoutes({
      app,
      database: {
        findCurrentUserSession: (token: string) =>
          token === 'session-id'
            ? {
                userId: 1,
                username: 'admin',
                isAdmin: true,
                sessionHash: 'session-hash',
                mustChangePassword: false,
                csrfTokenHash: hashOpaque(csrfToken)
              }
            : undefined,
        userOwnsNode: async () => true
      } as never,
      nodeControl: { requestNode, ownsWorkbenchConnection: () => false } as never,
      secrets: { resolve: vi.fn(async () => ({})) } as never,
      publicOrigin: undefined,
      databaseError: (reply, error) =>
        sendError(reply, 403, error instanceof Error ? error.message : 'INTERNAL_ERROR')
    });
    const headers = {
      cookie: `${SESSION_COOKIE_NAME}=session-id`,
      'x-csrf-token': csrfToken
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/agent-sessions/session-1/rollback',
      headers,
      payload: {
        nodeId: 'node-1',
        turnId: 'turn-2',
        itemId: 'steered-user-item',
        boundary: 'turn-1'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(requestNode.mock.calls[0]?.[2]).toEqual({
      sessionId: 'session-1',
      turnId: 'turn-2',
      itemId: 'steered-user-item',
      boundary: 'turn-1'
    });

    for (const itemId of ['', 'x'.repeat(129), 7]) {
      const invalid = await app.inject({
        method: 'POST',
        url: '/api/agent-sessions/session-1/rollback',
        headers,
        payload: { nodeId: 'node-1', turnId: 'turn-2', itemId, boundary: 'turn-1' }
      });
      expect(invalid.statusCode).toBe(400);
    }
    expect(requestNode).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
