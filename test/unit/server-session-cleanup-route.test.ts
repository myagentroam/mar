import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE_NAME } from '../../packages/server-core/src/auth.js';
import { sendError } from '../../packages/server-core/src/http-errors.js';
import { hashOpaque } from '../../packages/server-core/src/session-token.js';
import { registerSessionRunRoutes } from '../../packages/server-core/src/session-run-routes.js';

describe('Server workspace session cleanup route', () => {
  it('waits up to 30 seconds and relays partial counts without converting transport failure to success', async () => {
    const partial = {
      deleted: 3,
      skipped: 1,
      failed: 0,
      deletedByRunner: { codex: 3 },
      timedOut: true,
      remaining: 2
    };
    const requestNode = vi
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue(partial);
    const app = Fastify();
    registerSessionRunRoutes({
      app,
      database: {
        findCurrentUserSession: () => ({
          userId: 1,
          username: 'admin',
          isAdmin: true,
          sessionHash: 'session-hash',
          mustChangePassword: false,
          csrfTokenHash: hashOpaque('csrf')
        }),
        userOwnsNode: async () => true
      } as never,
      nodeControl: { requestNode } as never,
      secrets: { resolve: vi.fn() } as never,
      publicOrigin: undefined,
      databaseError: (reply) => sendError(reply, 504, 'NODE_REQUEST_TIMEOUT')
    });
    const input = {
      method: 'POST' as const,
      url: '/api/workspaces/workspace/sessions/cleanup',
      headers: { cookie: `${SESSION_COOKIE_NAME}=session`, 'x-csrf-token': 'csrf' },
      payload: { nodeId: 'node', inactiveDays: 30 }
    };
    try {
      const response = await app.inject(input);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(partial);
      expect(requestNode).toHaveBeenCalledWith(
        'node',
        'workspace.sessions.cleanup',
        { workspaceId: 'workspace', inactiveDays: 30 },
        expect.objectContaining({ workspaceId: 'workspace' }),
        30_000
      );
      requestNode.mockRejectedValueOnce(new Error('NODE_REQUEST_TIMEOUT'));
      const unavailable = await app.inject(input);
      expect(unavailable.statusCode).toBe(504);
      expect(unavailable.json()).toMatchObject({ error: { code: 'NODE_REQUEST_TIMEOUT' } });
    } finally {
      await app.close();
    }
  });
});
