import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { describe, expect, it, vi } from 'vitest';
import type {
  MarAgentModelSummary,
  MarAgentRuntimeModelConfiguration,
  ServerWorkbenchCapabilities
} from '../../packages/protocol/src/index.js';
import { hashOpaque } from '../../ee/server/src/database.js';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import type { NodeControl } from '../../ee/server/src/node-control.js';
import type { ResourceAccessService } from '../../ee/server/src/rbac/resource-access-service.js';
import { registerNodeRoutes } from '../../ee/server/src/route/node-routes.js';
import { registerResourceGrantRoutes } from '../../ee/server/src/route/resource-grant-routes.js';
import { registerRunControlRoutes } from '../../ee/server/src/route/run-control-routes.js';
import { registerSessionRunRoutes } from '../../ee/server/src/route/session-run-routes.js';
import type { EnvironmentSecretService } from '../../ee/server/src/service/environment-secret-service.js';
import type { MarAgentModelService } from '../../ee/server/src/service/mar-agent-model-service.js';
import type { MarAgentRuntimeModelService } from '../../ee/server/src/service/mar-agent-runtime-model-service.js';
import type { NodeUpgradeService } from '../../packages/server-core/src/node-upgrade-service.js';

const csrfToken = 'csrf-token';
const headers = {
  cookie: 'mar_user_session=session-id',
  'x-csrf-token': csrfToken
};

describe('Server MAR Agent model authorization routes', () => {
  it('filters the Runner Profile model directory for the current user', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerNodeRoutes({
      app,
      database: fixture.database,
      nodeControl: fixture.nodeControl,
      nodeUpgrades: {} as NodeUpgradeService,
      publicOrigin: undefined,
      capabilities: {} as ServerWorkbenchCapabilities,
      secrets: fixture.secrets,
      resources: {
        canAccessNodeContainer: vi.fn(async () => false),
        nodeOwnership: vi.fn(async () => ({ ownerType: 'PERSONAL' as const, ownerUserId: 8 })),
        canManageNode: vi.fn(async () => false),
        canRegisterWorkspace: vi.fn(async () => false),
        canManageNodeSecrets: vi.fn(async () => false),
        assertCanManageNode: vi.fn(async () => {
          throw new Error('NODE_ACCESS_DENIED');
        })
      },
      mutations: {
        changeNodeOwnership: vi.fn(async () => {
          throw new Error('NODE_ACCESS_DENIED');
        })
      },
      marAgentModels: fixture.models
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/runner-profiles?nodeId=node-1',
      headers: { cookie: headers.cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.models.listForUser).toHaveBeenCalledWith(8);
    expect(fixture.nodeControl.requestNode).toHaveBeenCalledWith(
      'node-1',
      'runner.profiles.list',
      expect.objectContaining({
        marAgentModels: [expect.objectContaining({ id: 'coding-id' })]
      }),
      expect.objectContaining({ userId: 8, sessionHash: 'session-hash' }),
      undefined
    );
    expect(
      fixture.nodeControl.requestNode.mock.calls[0]?.[2]?.marAgentModels[0]
    ).not.toHaveProperty('access');

    fixture.nodeControl.requestNode.mockClear();
    await app.inject({
      method: 'GET',
      url: '/api/runner-profiles?nodeId=node-1&cacheOnly=true',
      headers: { cookie: headers.cookie }
    });
    expect(fixture.nodeControl.requestNode).toHaveBeenCalledWith(
      'node-1',
      'runner.profiles.list',
      expect.objectContaining({ waitForRefresh: false }),
      expect.objectContaining({ userId: 8, sessionHash: 'session-hash' }),
      undefined
    );

    fixture.nodeControl.requestNode.mockClear();
    await app.inject({
      method: 'GET',
      url: '/api/runner-profiles?nodeId=node-1&waitForRefresh=true',
      headers: { cookie: headers.cookie }
    });
    expect(fixture.nodeControl.requestNode).toHaveBeenCalledWith(
      'node-1',
      'runner.profiles.list',
      expect.objectContaining({ waitForRefresh: true }),
      expect.objectContaining({ userId: 8, sessionHash: 'session-hash' }),
      120_000
    );
    await app.close();
  });

  it('passes only the current user runtime model set to the parent Agent and Subagents', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerSessionRunRoutes({
      app,
      database: fixture.database,
      nodeControl: fixture.nodeControl,
      secrets: fixture.secrets,
      marAgentModels: fixture.models,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/agent-sessions/start',
      headers,
      payload: {
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        runner: 'mar-agent',
        cwd: '/workspace',
        model: 'coding-id',
        effort: 'high',
        access: 'on-request',
        clientMessageId: 'message-1',
        content: 'Implement the change.'
      }
    });

    expect(response.statusCode).toBe(201);
    expect(fixture.models.runtimeForUser).toHaveBeenCalledWith(8, 'coding-id');
    expect(fixture.models.runtimeConfigurationsForUser).toHaveBeenCalledWith(8);
    expect(fixture.nodeControl.requestNode).toHaveBeenCalledWith(
      'node-1',
      'session.start',
      expect.objectContaining({
        marAgentModel: expect.objectContaining({ id: 'coding-id' }),
        marAgentModels: [
          expect.objectContaining({ id: 'coding-id' }),
          expect.objectContaining({ id: 'review-id' })
        ]
      }),
      expect.objectContaining({
        userId: 8,
        sessionHash: 'session-hash',
        workspaceId: 'workspace-1'
      }),
      undefined
    );
    const request = fixture.nodeControl.requestNode.mock.calls[0]?.[2];
    expect(JSON.stringify(request)).not.toContain('restricted-id');
    await app.close();
  });

  it('uses the unified runtime bundle for starts and commands with workspace authorization', async () => {
    const fixture = routeFixture();
    const runtimeModels = {
      prepare: vi.fn(async () => ({
        runtimeScopeId: 'scope-1',
        model: {
          ...runtimeModel('coding-id'),
          apiKey: undefined,
          credential: {
            type: 'RUNTIME_TICKET',
            credentialId: 'credential-1',
            ticket: {
              credentialId: 'credential-1',
              nodeId: 'node-1',
              workspaceId: 'workspace-1',
              runtimeScopeId: 'scope-1',
              allowedModelIds: ['coding-id'],
              issuedAt: 10,
              expiresAt: 900_010,
              nonce: 'nonce-1',
              signature: 'a'.repeat(64)
            }
          }
        },
        models: [runtimeModel('review-id')]
      }))
    } as unknown as MarAgentRuntimeModelService & {
      prepare: ReturnType<typeof vi.fn>;
    };
    const app = Fastify();
    registerSessionRunRoutes({
      app,
      database: fixture.database,
      nodeControl: fixture.nodeControl,
      secrets: fixture.secrets,
      marAgentModels: fixture.models,
      marAgentRuntimeModels: runtimeModels,
      publicOrigin: undefined
    });
    registerRunControlRoutes({
      authorizeNodeRequest: async () => true,
      app,
      database: fixture.database,
      nodeControl: fixture.nodeControl,
      secrets: fixture.secrets,
      marAgentModels: fixture.models,
      marAgentRuntimeModels: runtimeModels,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/agent-sessions/start',
      headers,
      payload: {
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        runner: 'mar-agent',
        cwd: '/workspace',
        model: 'coding-id',
        clientMessageId: 'message-1',
        content: 'Implement the change.'
      }
    });

    expect(response.statusCode).toBe(201);
    expect(runtimeModels.prepare).toHaveBeenCalledWith({
      userId: 8,
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      selectedModelId: 'coding-id'
    });
    expect(fixture.nodeControl.requestNode).toHaveBeenCalledWith(
      'node-1',
      'session.start',
      expect.objectContaining({
        marAgentRuntimeScopeId: 'scope-1',
        marAgentModel: expect.objectContaining({
          credential: expect.objectContaining({ type: 'RUNTIME_TICKET' })
        })
      }),
      expect.objectContaining({ workspaceId: 'workspace-1' }),
      undefined
    );
    expect(fixture.models.runtimeForUser).not.toHaveBeenCalled();

    runtimeModels.prepare.mockClear();
    fixture.nodeControl.requestNode.mockClear();
    const command = await app.inject({
      method: 'POST',
      url: '/api/agent-sessions/session-1/commands',
      headers,
      payload: {
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        model: 'coding-id',
        commandId: 'compact',
        input: '/compact'
      }
    });

    expect(command.statusCode).toBe(202);
    expect(runtimeModels.prepare).toHaveBeenCalledWith({
      userId: 8,
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      selectedModelId: 'coding-id'
    });
    expect(fixture.nodeControl.requestNode).toHaveBeenCalledWith(
      'node-1',
      'session.command.execute',
      expect.objectContaining({
        sessionId: 'session-1',
        commandId: 'compact',
        input: '/compact',
        marAgentRuntimeScopeId: 'scope-1',
        marAgentModel: expect.objectContaining({
          credential: expect.objectContaining({ type: 'RUNTIME_TICKET' })
        })
      }),
      expect.objectContaining({ workspaceId: 'workspace-1' }),
      undefined
    );
    await app.close();
  });

  it('rejects revoked or disabled models before forwarding sessions, messages and commands', async () => {
    const fixture = routeFixture();
    fixture.models.runtimeForUser.mockRejectedValue(new Error('MAR_AGENT_MODEL_FORBIDDEN'));
    const app = Fastify();
    registerSessionRunRoutes({
      app,
      database: fixture.database,
      nodeControl: fixture.nodeControl,
      secrets: fixture.secrets,
      marAgentModels: fixture.models,
      publicOrigin: undefined
    });
    registerRunControlRoutes({
      authorizeNodeRequest: async () => true,
      app,
      database: fixture.database,
      nodeControl: fixture.nodeControl,
      secrets: fixture.secrets,
      marAgentModels: fixture.models,
      publicOrigin: undefined
    });

    const requests = [
      {
        method: 'POST' as const,
        url: '/api/agent-sessions/start',
        payload: {
          nodeId: 'node-1',
          workspaceId: 'workspace-1',
          runner: 'mar-agent',
          cwd: '/workspace',
          model: 'restricted-id',
          clientMessageId: 'message-1',
          content: 'Start.'
        }
      },
      {
        method: 'POST' as const,
        url: '/api/agent-sessions/session-1/messages',
        payload: {
          nodeId: 'node-1',
          workspaceId: 'workspace-1',
          model: 'restricted-id',
          clientMessageId: 'message-2',
          content: 'Continue.'
        }
      },
      {
        method: 'POST' as const,
        url: '/api/agent-sessions/session-1/commands',
        payload: {
          nodeId: 'node-1',
          model: 'restricted-id',
          commandId: 'compact',
          input: '/compact'
        }
      }
    ];
    for (const request of requests) {
      const response = await app.inject({ ...request, headers });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: { code: 'MAR_AGENT_MODEL_FORBIDDEN', message: expect.any(String) }
      });
    }
    expect(fixture.nodeControl.requestNode).not.toHaveBeenCalled();

    fixture.models.runtimeForUser.mockRejectedValue(new Error('MAR_AGENT_MODEL_DISABLED'));
    const disabled = await app.inject({ ...requests[0], headers });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toMatchObject({
      error: { code: 'MAR_AGENT_MODEL_DISABLED', message: expect.any(String) }
    });
    expect(fixture.nodeControl.requestNode).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects Hosted Conversation image IDs on the ordinary Run image route', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerRunControlRoutes({
      authorizeNodeRequest: async () => true,
      app,
      database: fixture.database,
      nodeControl: fixture.nodeControl,
      secrets: fixture.secrets,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/agent-runs/${encodeURIComponent('native-history:hosted:conversation-1')}/images/0?nodeId=node-1`,
      headers: { cookie: headers.cookie }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'RUN_IMAGE_INVALID' } });
    expect(fixture.nodeControl.requestNode).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not revalidate Terminal authorizations when revoking a model grant', async () => {
    const fixture = routeFixture();
    const resources = {
      removeGrant: vi.fn(async () => 'MODEL' as const)
    } as unknown as ResourceAccessService;
    const app = Fastify();
    registerResourceGrantRoutes({
      app,
      database: fixture.database,
      directory: {
        listManagedResources: async () => {
          throw new Error('UNEXPECTED_DIRECTORY_QUERY');
        },
        listManagedResourcePage: async () => {
          throw new Error('UNEXPECTED_DIRECTORY_QUERY');
        }
      },
      grants: resources as never,
      nodeControl: fixture.nodeControl,
      nodeUpgrades: {} as NodeUpgradeService,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/resource-grants/model-grant-1',
      headers
    });

    expect(response.statusCode).toBe(204);
    expect(fixture.nodeControl.revalidateTerminalAuthorizations).not.toHaveBeenCalled();
    await app.close();
  });
});

function routeFixture() {
  const coding = runtimeModel('coding-id');
  const review = runtimeModel('review-id');
  const summary: MarAgentModelSummary = {
    id: coding.id,
    name: coding.name,
    protocol: coding.protocol,
    baseUrl: coding.baseUrl,
    modelId: coding.modelId,
    contextWindowTokens: coding.contextWindowTokens,
    maxOutputTokens: coding.maxOutputTokens,
    inputCapabilities: coding.inputCapabilities,
    outputCapabilities: coding.outputCapabilities,
    reasoningEfforts: coding.reasoningEfforts,
    titleGeneration: coding.titleGeneration,
    codeMode: coding.codeMode,
    hostedWebSearch: coding.hostedWebSearch,
    responsesPreviousResponseId: coding.responsesPreviousResponseId,
    enabled: coding.enabled,
    sortOrder: 0,
    access: 'PUBLIC'
  };
  const database = {
    findCurrentUserSession: vi.fn(() => ({
      userId: 8,
      username: 'member',
      isAdmin: false,
      sessionHash: 'session-hash',
      mustChangePassword: false,
      csrfTokenHash: hashOpaque(csrfToken)
    })),
    audit: vi.fn(async () => undefined)
  } as unknown as MysqlServerDatabase;
  const nodeControl = {
    requestNode: vi.fn(async () => ({ sessionId: 'session-1', runId: 'run-1' })),
    revalidateTerminalAuthorizations: vi.fn(async () => undefined)
  } as unknown as NodeControl & {
    requestNode: ReturnType<typeof vi.fn>;
    revalidateTerminalAuthorizations: ReturnType<typeof vi.fn>;
  };
  const secrets = {
    resolve: vi.fn(async () => ({}))
  } as unknown as EnvironmentSecretService;
  const models = {
    listForUser: vi.fn(async () => [summary]),
    runtimeForUser: vi.fn(async () => coding),
    runtimeConfigurationsForUser: vi.fn(async () => [coding, review])
  } as unknown as MarAgentModelService & {
    listForUser: ReturnType<typeof vi.fn>;
    runtimeForUser: ReturnType<typeof vi.fn>;
    runtimeConfigurationsForUser: ReturnType<typeof vi.fn>;
  };
  return { database, nodeControl, secrets, models };
}

function runtimeModel(id: string): MarAgentRuntimeModelConfiguration {
  return {
    id,
    name: id,
    protocol: 'OPENAI_RESPONSES',
    baseUrl: 'https://models.example.test',
    credential: { type: 'INLINE_API_KEY', value: `${id}-secret` },
    modelId: id,
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_192,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['high'],
    hostedWebSearch: false,
    responsesPreviousResponseId: false,
    enabled: true
  };
}
