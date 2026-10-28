import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { describe, expect, it, vi } from 'vitest';
import { hashOpaque } from '../../ee/server/src/database.js';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import type { NodeControl } from '../../ee/server/src/node-control.js';
import { registerMarAgentModelRoutes } from '../../ee/server/src/route/mar-agent-model-routes.js';
import type { MarAgentModelService } from '../../ee/server/src/service/mar-agent-model-service.js';
import type { MarAgentRuntimeModelService } from '../../ee/server/src/service/mar-agent-runtime-model-service.js';

const csrfToken = 'csrf-token';
const headers = {
  cookie: 'mar_user_session=session-id',
  'x-csrf-token': csrfToken
};

describe('Server MAR Agent model transport test route', () => {
  it.each([true, false])(
    'duplicates a manageable model for an authenticated user (admin=%s)',
    async (isAdmin) => {
      const fixture = routeFixture();
      fixture.database.findCurrentUserSession.mockReturnValue({
        userId: 7,
        username: 'owner',
        isAdmin,
        sessionHash: 'owner-session',
        mustChangePassword: false,
        csrfTokenHash: hashOpaque(csrfToken)
      });
      const app = Fastify();
      registerMarAgentModelRoutes({ app, ...fixture });
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/mar-agent/models/model-1/duplicate',
        headers,
        payload: { name: 'Model copy' }
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ model: { id: 'model-copy' } });
      expect(fixture.models.duplicate).toHaveBeenCalledWith(7, 'model-1', { name: 'Model copy' });
      await app.close();
    }
  );

  it.each(['csrf', 'origin', 'permission', 'session'])(
    'rejects an invalid duplicate request: %s',
    async (failure) => {
      const fixture = routeFixture();
      if (failure === 'permission')
        fixture.models.duplicate.mockRejectedValue(new Error('MODEL_RESOURCE_ADMIN_REQUIRED'));
      if (failure === 'session') fixture.database.findCurrentUserSession.mockReturnValue(undefined);
      const app = Fastify();
      registerMarAgentModelRoutes({
        app,
        ...fixture,
        publicOrigin: 'https://console.example.test'
      });
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/mar-agent/models/model-1/duplicate',
        headers: {
          ...headers,
          ...(failure === 'csrf' ? { 'x-csrf-token': 'invalid' } : {}),
          ...(failure === 'origin' ? { origin: 'https://untrusted.example.test' } : {})
        },
        payload: { name: 'Model copy' }
      });
      expect(response.statusCode).toBe(failure === 'session' ? 401 : 403);
      if (failure !== 'permission') expect(fixture.models.duplicate).not.toHaveBeenCalled();
      await app.close();
    }
  );

  it('lets a non-admin read and save only their personal model order', async () => {
    const fixture = routeFixture();
    fixture.database.findCurrentUserSession.mockReturnValue({
      userId: 7,
      username: 'member',
      isAdmin: false,
      sessionHash: 'member-session',
      mustChangePassword: false,
      csrfTokenHash: hashOpaque(csrfToken)
    });
    const app = Fastify();
    registerMarAgentModelRoutes({
      app,
      database: fixture.database,
      authorizeNodeRequest: fixture.authorizeNodeRequest,
      models: fixture.models,
      runtimeModels: fixture.runtimeModels,
      nodeControl: fixture.nodeControl
    });

    const listing = await app.inject({ method: 'GET', url: '/api/mar-agent/models', headers });
    const saving = await app.inject({
      method: 'PUT',
      url: '/api/mar-agent/models/order',
      headers,
      payload: { modelIds: ['model-1'] }
    });

    expect(listing.statusCode).toBe(200);
    expect(listing.json()).toEqual({ models: [{ id: 'model-1' }] });
    expect(saving.statusCode).toBe(204);
    expect(fixture.models.listForUser).toHaveBeenCalledWith(7);
    expect(fixture.models.reorderForUser).toHaveBeenCalledWith(7, { modelIds: ['model-1'] });
    expect(fixture.models.reorder).toBeUndefined();
    await app.close();
  });

  it('prepares one runtime model and forwards the real test to the selected Node', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerMarAgentModelRoutes({
      app,
      database: fixture.database,
      authorizeNodeRequest: fixture.authorizeNodeRequest,
      models: fixture.models,
      runtimeModels: fixture.runtimeModels,
      nodeControl: fixture.nodeControl
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/mar-agent/models/model-1/test',
      headers,
      payload: { nodeId: 'node-1' }
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.runtimeModels.prepareTest).toHaveBeenCalledWith({
      userId: 1,
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      modelId: 'model-1'
    });
    expect(fixture.nodeControl.requestNode).toHaveBeenCalledWith(
      'node-1',
      'mar-agent.model.test',
      {
        runtimeScopeId: 'scope-1',
        executionId: expect.any(String),
        model: expect.objectContaining({ id: 'model-1' })
      },
      expect.objectContaining({
        userId: 1,
        sessionHash: 'admin-session',
        workspaceId: 'workspace-1'
      }),
      45_000
    );
    expect(fixture.models.recordTestResult).toHaveBeenCalledWith(
      'model-1',
      {
        success: true,
        code: null,
        message: null,
        httpStatus: null
      },
      1
    );
    expect(response.json()).toEqual({
      success: true,
      code: null,
      message: null,
      httpStatus: null,
      requestId: expect.any(String)
    });
    await app.close();
  });

  it('returns the Node model error without replacing its code, status or message', async () => {
    const fixture = routeFixture();
    const diagnostics = {
      body: '{"error":"Store must be set to false"}',
      bodyTruncated: false,
      contentType: 'application/json',
      requestId: 'upstream-request',
      retryAfter: null
    };
    fixture.nodeControl.requestNode.mockResolvedValueOnce({
      success: false,
      code: 'invalid_request_error',
      message: 'Store must be set to false',
      httpStatus: 400,
      response: diagnostics
    });
    const app = Fastify();
    registerMarAgentModelRoutes({
      app,
      database: fixture.database,
      authorizeNodeRequest: fixture.authorizeNodeRequest,
      models: fixture.models,
      runtimeModels: fixture.runtimeModels,
      nodeControl: fixture.nodeControl
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/mar-agent/models/model-1/test',
      headers,
      payload: { nodeId: 'node-1' }
    });

    const result = {
      success: false,
      code: 'invalid_request_error',
      message: 'Store must be set to false',
      httpStatus: 400,
      response: diagnostics
    };
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...result, requestId: expect.any(String) });
    expect(fixture.models.recordTestResult).toHaveBeenCalledWith('model-1', result, 1);
    await app.close();
  });

  it('rejects a Node without a registered real Workspace before issuing a ticket', async () => {
    const fixture = routeFixture([]);
    const app = Fastify();
    registerMarAgentModelRoutes({
      app,
      database: fixture.database,
      authorizeNodeRequest: fixture.authorizeNodeRequest,
      models: fixture.models,
      runtimeModels: fixture.runtimeModels,
      nodeControl: fixture.nodeControl
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/mar-agent/models/model-1/test',
      headers,
      payload: { nodeId: 'node-empty' }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: 'MAR_AGENT_MODEL_TEST_WORKSPACE_REQUIRED' }
    });
    expect(fixture.runtimeModels.prepareTest).not.toHaveBeenCalled();
    expect(fixture.nodeControl.requestNode).not.toHaveBeenCalled();
    await app.close();
  });

  it('selects the first Workspace the administrator can actually use', async () => {
    const fixture = routeFixture(['workspace-1', 'workspace-2'], ['workspace-2']);
    const app = Fastify();
    registerMarAgentModelRoutes({
      app,
      database: fixture.database,
      authorizeNodeRequest: fixture.authorizeNodeRequest,
      models: fixture.models,
      runtimeModels: fixture.runtimeModels,
      nodeControl: fixture.nodeControl
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/mar-agent/models/model-1/test',
      headers,
      payload: { nodeId: 'node-1' }
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.authorizeNodeRequest).toHaveBeenCalledWith(
      1,
      'node-1',
      'mar-agent.model.test',
      {},
      'workspace-1'
    );
    expect(fixture.authorizeNodeRequest).toHaveBeenCalledWith(
      1,
      'node-1',
      'mar-agent.model.test',
      {},
      'workspace-2'
    );
    expect(fixture.runtimeModels.prepareTest).toHaveBeenCalledWith({
      userId: 1,
      nodeId: 'node-1',
      workspaceId: 'workspace-2',
      modelId: 'model-1'
    });
    await app.close();
  });

  it('rejects malformed requests without contacting any Node', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerMarAgentModelRoutes({
      app,
      database: fixture.database,
      authorizeNodeRequest: fixture.authorizeNodeRequest,
      models: fixture.models,
      runtimeModels: fixture.runtimeModels,
      nodeControl: fixture.nodeControl
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/mar-agent/models/model-1/test',
      headers,
      payload: { nodeId: 'unknown', transport: 'HTTP/1.1' }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'MAR_AGENT_MODEL_TEST_INPUT_INVALID' }
    });
    expect(fixture.nodeControl.requestNode).not.toHaveBeenCalled();
    await app.close();
  });
});

function routeFixture(
  workspaceIds: readonly string[] = ['workspace-1'],
  allowedWorkspaceIds: readonly string[] = workspaceIds
) {
  const authorizeNodeRequest = vi.fn(
    async (
      _userId: number,
      _nodeId: string,
      _operation: string,
      _data: unknown,
      workspaceId?: string
    ) => workspaceId !== undefined && allowedWorkspaceIds.includes(workspaceId)
  );
  const database = {
    findCurrentUserSession: vi.fn(() => ({
      userId: 1,
      username: 'admin',
      isAdmin: true,
      sessionHash: 'admin-session',
      mustChangePassword: false,
      csrfTokenHash: hashOpaque(csrfToken)
    })),
    raw: {
      execute: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        if (sql.includes('FROM workspaces WHERE node_id=?')) {
          const nodeId = values?.[0];
          return [
            nodeId === 'node-empty'
              ? []
              : workspaceIds.map((workspaceId) => ({ workspace_id: workspaceId })),
            []
          ];
        }
        throw new Error(`UNEXPECTED_SQL:${sql}`);
      })
    }
  } as unknown as MysqlServerDatabase & {
    findCurrentUserSession: ReturnType<typeof vi.fn>;
  };
  const models = {
    duplicate: vi.fn(async () => ({ id: 'model-copy' })),
    assertCanManage: vi.fn(async () => undefined),
    recordTestResult: vi.fn(async () => undefined),
    listForUser: vi.fn(async () => [{ id: 'model-1' }]),
    reorderForUser: vi.fn(async () => undefined)
  } as unknown as MarAgentModelService & {
    duplicate: ReturnType<typeof vi.fn>;
    assertCanManage: ReturnType<typeof vi.fn>;
    recordTestResult: ReturnType<typeof vi.fn>;
    listForUser: ReturnType<typeof vi.fn>;
    reorderForUser: ReturnType<typeof vi.fn>;
  };
  const runtimeModels = {
    prepareTest: vi.fn(async () => ({
      runtimeScopeId: 'scope-1',
      model: runtimeModel()
    }))
  } as unknown as MarAgentRuntimeModelService & {
    prepareTest: ReturnType<typeof vi.fn>;
  };
  const nodeControl = {
    requestNode: vi.fn(async () => ({
      success: true,
      code: null,
      message: null,
      httpStatus: null
    }))
  } as unknown as NodeControl & {
    requestNode: ReturnType<typeof vi.fn>;
  };
  return {
    database,
    authorizeNodeRequest,
    models,
    runtimeModels,
    nodeControl
  };
}

function runtimeModel() {
  return {
    id: 'model-1',
    name: 'Model One',
    protocol: 'OPENAI_RESPONSES',
    baseUrl: 'https://models.example.test/v1',
    credential: {
      type: 'RUNTIME_TICKET',
      credentialId: 'credential-1',
      ticket: {
        credentialId: 'credential-1',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        runtimeScopeId: 'scope-1',
        allowedModelIds: ['model-1'],
        issuedAt: 1,
        expiresAt: 900_001,
        nonce: 'nonce-1',
        signature: 'a'.repeat(64)
      }
    },
    modelId: 'gpt-5-codex',
    contextWindowTokens: 100_000,
    maxOutputTokens: 4_096,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['high'],
    hostedWebSearch: false,
    responsesTransport: { transport: 'WEBSOCKET' },
    responsesPreviousResponseId: true,
    enabled: true
  };
}
