import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { describe, expect, it, vi } from 'vitest';
import { hashOpaque } from '../../ee/server/src/database.js';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import type { NodeControl } from '../../ee/server/src/node-control.js';
import { registerMarAgentModelRoutes } from '../../ee/server/src/route/mar-agent-model-routes.js';
import type { MarAgentModelService } from '../../ee/server/src/service/mar-agent-model-service.js';
import type { MarAgentRuntimeModelService } from '../../ee/server/src/service/mar-agent-runtime-model-service.js';

const csrfToken = 'csrf-token';
const headers = { cookie: 'mar_user_session=session-id' };
const socks5Url = 'socks5://proxy-user:proxy-password@proxy.example.test:1080';

describe('Server MAR Agent model connection route', () => {
  it('returns sensitive connection details with private no-store caching for an administrator', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerMarAgentModelRoutes({ app, ...fixture });

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/mar-agent/models/model-1/connection',
      headers
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ details: { socks5Url } });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(fixture.models.connectionDetails).toHaveBeenCalledWith(7, 'model-1');
    await app.close();
  });

  it('does not read connection details for an unauthenticated user', async () => {
    const fixture = routeFixture();
    fixture.database.findCurrentUserSession.mockReturnValue(undefined);
    const app = Fastify();
    registerMarAgentModelRoutes({ app, ...fixture });

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/mar-agent/models/model-1/connection',
      headers
    });

    expect(response.statusCode).toBe(401);
    expect(fixture.models.connectionDetails).not.toHaveBeenCalled();
    await app.close();
  });

  it('forwards the authenticated user to the model-management permission check', async () => {
    const fixture = routeFixture();
    fixture.database.findCurrentUserSession.mockReturnValue({
      userId: 8,
      username: 'member',
      isAdmin: false,
      sessionHash: 'member-session',
      mustChangePassword: false,
      csrfTokenHash: hashOpaque(csrfToken)
    });
    fixture.models.connectionDetails.mockRejectedValue(new Error('MODEL_RESOURCE_ADMIN_REQUIRED'));
    const app = Fastify();
    registerMarAgentModelRoutes({ app, ...fixture });

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/mar-agent/models/model-1/connection',
      headers
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'MODEL_RESOURCE_ADMIN_REQUIRED' } });
    expect(response.body).not.toContain('proxy-password');
    expect(fixture.models.connectionDetails).toHaveBeenCalledWith(8, 'model-1');
    await app.close();
  });
});

function routeFixture() {
  const database = {
    findCurrentUserSession: vi.fn(() => ({
      userId: 7,
      username: 'admin',
      isAdmin: true,
      sessionHash: 'admin-session',
      mustChangePassword: false,
      csrfTokenHash: hashOpaque(csrfToken)
    })),
    raw: { execute: vi.fn(async () => [[], []]) }
  } as unknown as MysqlServerDatabase & {
    findCurrentUserSession: ReturnType<typeof vi.fn>;
  };
  const models = {
    connectionDetails: vi.fn(async () => ({ socks5Url }))
  } as unknown as MarAgentModelService & {
    connectionDetails: ReturnType<typeof vi.fn>;
  };
  const runtimeModels = { prepareTest: vi.fn() } as unknown as MarAgentRuntimeModelService;
  const nodeControl = { requestNode: vi.fn() } as unknown as NodeControl;
  return {
    database,
    models,
    runtimeModels,
    nodeControl,
    authorizeNodeRequest: vi.fn()
  };
}
