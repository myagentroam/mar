import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { describe, expect, it, vi } from 'vitest';
import { registerRunControlRoutes } from '../../packages/server-core/src/run-control-routes.js';

const resourceId = 'a'.repeat(64);
const signature = 'b'.repeat(43);

async function fixture() {
  const app = Fastify({ logger: false });
  const requestNode = vi.fn(async () => ({
    image: { mimeType: 'image/png', dataBase64: Buffer.from('pixels').toString('base64') }
  }));
  registerRunControlRoutes({
    app,
    database: {} as never,
    secrets: {} as never,
    nodeControl: { requestNode } as never,
    publicOrigin: undefined,
    databaseError: (reply) => reply.code(403).send({ error: 'RESOURCE_DENIED' })
  });
  await app.ready();
  return { app, requestNode };
}

describe('Signed model resource routing', () => {
  it.each([
    ['workspaces', 'workspaceId'],
    ['conversations', 'conversationId']
  ] as const)(
    'relays the immutable %s identity using the dedicated capability',
    async (scope, field) => {
      const { app, requestNode } = await fixture();
      try {
        const response = await app.inject({
          method: 'GET',
          url: `/api/nodes/node/${scope}/scope/sessions/session/resources/${resourceId}?expiresAt=1800000000000&signature=${signature}`
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toBe('image/png');
        expect(response.rawPayload).toEqual(Buffer.from('pixels'));
        expect(requestNode).toHaveBeenCalledWith(
          'node',
          'model.resource.read',
          {
            [field]: 'scope',
            sessionId: 'session',
            resourceId,
            expiresAt: 1800000000000,
            signature
          },
          expect.objectContaining({ userId: 0, sessionHash: 'model-resource' })
        );
      } finally {
        await app.close();
      }
    }
  );

  it('rejects unsigned resources and does not restore the old image route', async () => {
    const { app, requestNode } = await fixture();
    try {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/nodes/node/workspaces/scope/sessions/session/resources/${resourceId}`
          })
        ).statusCode
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/nodes/node/workspaces/scope/sessions/session/images/${resourceId}?expiresAt=1800000000000&signature=${signature}`
          })
        ).statusCode
      ).toBe(404);
      expect(requestNode).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
