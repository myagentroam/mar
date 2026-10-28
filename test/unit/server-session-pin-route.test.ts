import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { expect, it, vi } from 'vitest';
import { SESSION_COOKIE_NAME } from '../../packages/server-core/src/auth.js';
import { sendError } from '../../packages/server-core/src/http-errors.js';
import { hashOpaque } from '../../packages/server-core/src/session-token.js';
import { registerSessionRunRoutes } from '../../packages/server-core/src/session-run-routes.js';
import { NodeDatabase } from '../../mar-node/src/database.js';
import { SessionLifecycleService } from '../../mar-node/src/session/session-lifecycle-service.js';

it('relays a pinned drop to one atomic Node move and preserves adjacent menu moves', async () => {
  const database = new NodeDatabase(':memory:', 'node-pin-route');
  const workspace = database.saveWorkspace({
    path: '/workspace',
    kind: 'DIRECTORY',
    gitSummary: null
  });
  for (const id of ['three', 'two', 'one'])
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: id,
      workspaceId: workspace.id,
      pinned: true
    });
  const invalidateWorkspaceSessions = vi.fn();
  const lifecycle = new SessionLifecycleService({
    database: () => database,
    invalidateWorkspaceSessions
  } as never);
  const requestNode = vi.fn(async (_nodeId: string, operation: string, data: unknown) =>
    lifecycle.operations()[operation]!(data)
  );
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
    databaseError: (reply) => sendError(reply, 400, 'SESSION_PIN_MOVE_INVALID')
  });
  const input = {
    method: 'PATCH' as const,
    url: '/api/agent-sessions/one/pin-order',
    headers: { cookie: `${SESSION_COOKIE_NAME}=session`, 'x-csrf-token': 'csrf' }
  };
  const order = () => database.listSessionRecords(workspace.id).map((record) => record.id);
  try {
    const response = await app.inject({
      ...input,
      payload: { nodeId: 'node', direction: 'down', targetSessionId: 'three', position: 'after' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ moved: true });
    expect(requestNode).toHaveBeenCalledOnce();
    expect(invalidateWorkspaceSessions).toHaveBeenCalledExactlyOnceWith(workspace.id);
    expect(order()).toEqual(['two', 'three', 'one']);

    const menu = await app.inject({ ...input, payload: { nodeId: 'node', direction: 'up' } });
    expect(menu.statusCode).toBe(200);
    expect(order()).toEqual(['two', 'one', 'three']);

    const invalid = await app.inject({
      ...input,
      payload: { nodeId: 'node', direction: 'down', targetSessionId: '' }
    });
    expect(invalid.statusCode).toBe(400);
    expect(requestNode).toHaveBeenCalledTimes(2);
    expect(() =>
      lifecycle.operations()['session.pin.move']!({
        sessionId: 'one',
        direction: 'down',
        targetSessionId: 42
      })
    ).toThrow('SESSION_PIN_MOVE_INVALID');
    const foreignWorkspace = database.saveWorkspace({
      path: '/other',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: 'foreign',
      workspaceId: foreignWorkspace.id,
      pinned: true
    });
    const foreign = await app.inject({
      ...input,
      payload: { nodeId: 'node', direction: 'down', targetSessionId: 'foreign', position: 'after' }
    });
    expect(foreign.statusCode).toBe(400);
    expect(order()).toEqual(['two', 'one', 'three']);
    expect(invalidateWorkspaceSessions).toHaveBeenCalledTimes(2);
  } finally {
    await app.close();
    database.close();
  }
});
