import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConversationTemplateSummary,
  HostedConversationSummary,
  MarAgentRuntimeModelConfiguration
} from '../../packages/protocol/src/index.js';
import { hashOpaque } from '../../ee/server/src/database.js';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import type { NodeControl, StoredNodePresence } from '../../ee/server/src/node-control.js';
import { registerHostedConversationRoutes } from '../../ee/server/src/route/hosted-conversation-routes.js';
import type { ConversationTemplateService } from '../../ee/server/src/service/conversation-template-service.js';
import type { MarAgentModelService } from '../../ee/server/src/service/mar-agent-model-service.js';
import type { MarAgentRuntimeModelService } from '../../ee/server/src/service/mar-agent-runtime-model-service.js';
import {
  cleanupHostedConversationRuntimeFixtures,
  createConversation,
  draft as runtimeDraft,
  modelOne as nodeModelOne,
  modelTwo as nodeModelTwo,
  runtimeFixture,
  seedVersion
} from './support/hosted-conversation-runtime-fixture.js';

const csrfToken = 'csrf-token';
const headers = {
  cookie: 'mar_user_session=session-id',
  'x-csrf-token': csrfToken
};

afterEach(cleanupHostedConversationRuntimeFixtures);

describe('Server hosted conversation routes', () => {
  it('aggregates valid Node pages with stable ordering and forwards each Node cursor', async () => {
    const fixture = routeFixture();
    fixture.nodeControl.listNodes.mockResolvedValue([storedNode('node-b'), storedNode('node-a')]);
    fixture.nodeControl.requestHostedConversationNode.mockImplementation(
      async (nodeId: string, operation: string, data: unknown) => {
        if (operation !== 'conversation.hosted.list') return { run: { id: 'run-1' } };
        const cursor = (data as { readonly cursor?: string }).cursor;
        if (nodeId === 'node-a' && cursor === undefined)
          return {
            items: [
              hostedSummary('node-a', 'conversation-a-normal', {
                lastActivityAt: 3_000
              }),
              hostedSummary('node-a', 'conversation-a-pinned', {
                pinnedAt: 2_500,
                lastActivityAt: 1_000
              })
            ],
            nextCursor: 'node-a-next'
          };
        if (nodeId === 'node-b' && cursor === undefined)
          return {
            items: [
              hostedSummary('node-b', 'conversation-b-normal', {
                lastActivityAt: 3_000
              })
            ],
            nextCursor: 'node-b-next'
          };
        if (nodeId === 'node-a' && cursor === 'node-a-next')
          return {
            items: [
              hostedSummary('node-a', 'conversation-a-later', {
                lastActivityAt: 500
              })
            ],
            nextCursor: null
          };
        if (nodeId === 'node-b' && cursor === 'node-b-next')
          return {
            items: [
              hostedSummary('node-b', 'conversation-b-later', {
                lastActivityAt: 600
              })
            ],
            nextCursor: null
          };
        throw new Error('unexpected hosted list request');
      }
    );
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const first = await app.inject({
      method: 'GET',
      url: '/api/hosted-conversations?limit=2',
      headers: { cookie: headers.cookie }
    });

    expect(first.statusCode).toBe(200);
    expect(first.json().items.map((item: HostedConversationSummary) => item.id)).toEqual([
      'conversation-a-pinned',
      'conversation-a-normal',
      'conversation-b-normal'
    ]);
    const nextCursor = first.json().nextCursor as string;
    expect(nextCursor).toEqual(expect.any(String));
    expect(nextCursor).not.toContain('node-a-next');
    expect(nextCursor).not.toContain('node-b-next');

    const second = await app.inject({
      method: 'GET',
      url: `/api/hosted-conversations?limit=2&cursor=${encodeURIComponent(nextCursor)}`,
      headers: { cookie: headers.cookie }
    });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({
      items: [
        hostedSummary('node-b', 'conversation-b-later', { lastActivityAt: 600 }),
        hostedSummary('node-a', 'conversation-a-later', { lastActivityAt: 500 })
      ],
      nextCursor: null
    });
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenCalledWith(
      'node-a',
      'conversation.hosted.list',
      { limit: 2, cursor: 'node-a-next' },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenCalledWith(
      'node-b',
      'conversation.hosted.list',
      { limit: 2, cursor: 'node-b-next' },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
  });

  it('filters aggregate and per-Node directories by current template authorization', async () => {
    const fixture = routeFixture();
    fixture.nodeControl.listNodes.mockResolvedValue([storedNode('node-1')]);
    fixture.nodeControl.requestHostedConversationNode.mockResolvedValue({
      items: [
        hostedSummary('node-1', 'conversation-authorized'),
        hostedSummary('node-1', 'conversation-revoked', {
          templateId: 'template-revoked'
        })
      ],
      nextCursor: null
    });
    fixture.templates.assertCanUse.mockImplementation(async (_userId, templateId) => {
      if (templateId === 'template-revoked')
        throw new Error('CONVERSATION_TEMPLATE_NOT_AUTHORIZED');
      return { ...template, id: templateId, nodeId: 'node-1' };
    });
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const aggregate = await app.inject({
      method: 'GET',
      url: '/api/hosted-conversations',
      headers: { cookie: headers.cookie }
    });
    const perNode = await app.inject({
      method: 'GET',
      url: '/api/nodes/node-1/hosted-conversations',
      headers: { cookie: headers.cookie }
    });

    expect(aggregate.statusCode).toBe(200);
    expect(perNode.statusCode).toBe(200);
    expect(aggregate.json().items.map((item: HostedConversationSummary) => item.id)).toEqual([
      'conversation-authorized'
    ]);
    expect(perNode.json().items.map((item: HostedConversationSummary) => item.id)).toEqual([
      'conversation-authorized'
    ]);
    expect(fixture.nodeControl.requestNode).not.toHaveBeenCalled();
  });

  it('silently skips unavailable Nodes, request failures and invalid Node pages', async () => {
    const fixture = routeFixture();
    fixture.nodeControl.listNodes.mockResolvedValue([
      storedNode('node-valid'),
      storedNode('node-failed'),
      storedNode('node-invalid-page'),
      storedNode('node-invalid-capability', { metadata: '{not-json' }),
      storedNode('node-old', { version: '0.9.26' }),
      storedNode('node-disabled', { disabled: true }),
      storedNode('node-offline', { connected: false })
    ]);
    fixture.nodeControl.requestHostedConversationNode.mockImplementation(
      async (nodeId: string, operation: string) => {
        if (operation !== 'conversation.hosted.list') return { run: { id: 'run-1' } };
        if (nodeId === 'node-valid')
          return {
            items: [hostedSummary('node-valid', 'conversation-valid')],
            nextCursor: null
          };
        if (nodeId === 'node-failed') throw new Error('NODE_OFFLINE');
        return {
          items: [{ id: 'incomplete-conversation' }],
          nextCursor: 'invalid-next'
        };
      }
    );
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/hosted-conversations?limit=20',
      headers: { cookie: headers.cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [hostedSummary('node-valid', 'conversation-valid')],
      nextCursor: null
    });
    expect(
      fixture.nodeControl.requestHostedConversationNode.mock.calls
        .filter((call) => call[1] === 'conversation.hosted.list')
        .map((call) => call[0])
        .sort()
    ).toEqual(['node-failed', 'node-invalid-page', 'node-valid']);
  });

  it('returns an ordinary empty page when no Node is valid or every valid Node fails', async () => {
    const fixture = routeFixture();
    fixture.nodeControl.listNodes.mockResolvedValue([]);
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const withoutNodes = await app.inject({
      method: 'GET',
      url: '/api/hosted-conversations',
      headers: { cookie: headers.cookie }
    });

    expect(withoutNodes.statusCode).toBe(200);
    expect(withoutNodes.json()).toEqual({ items: [], nextCursor: null });

    fixture.nodeControl.listNodes.mockResolvedValue([
      storedNode('node-failed'),
      storedNode('node-invalid')
    ]);
    fixture.nodeControl.requestHostedConversationNode
      .mockRejectedValueOnce(new Error('NODE_ACCESS_DENIED'))
      .mockResolvedValueOnce({ items: [], nextCursor: 42 });

    const withoutResults = await app.inject({
      method: 'GET',
      url: '/api/hosted-conversations',
      headers: { cookie: headers.cookie }
    });

    expect(withoutResults.statusCode).toBe(200);
    expect(withoutResults.json()).toEqual({ items: [], nextCursor: null });
  });

  it('binds aggregate cursors to the authenticated user and original limit', async () => {
    const fixture = routeFixture();
    fixture.nodeControl.listNodes.mockResolvedValue([storedNode('node-1')]);
    fixture.nodeControl.requestHostedConversationNode.mockResolvedValue({
      items: [hostedSummary('node-1', 'conversation-1')],
      nextCursor: 'node-next'
    });
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const first = await app.inject({
      method: 'GET',
      url: '/api/hosted-conversations?limit=2',
      headers: { cookie: headers.cookie }
    });
    const cursor = first.json().nextCursor as string;

    const changedLimit = await app.inject({
      method: 'GET',
      url: `/api/hosted-conversations?limit=3&cursor=${encodeURIComponent(cursor)}`,
      headers: { cookie: headers.cookie }
    });

    expect(changedLimit.statusCode).toBe(400);
    expect(changedLimit.json()).toMatchObject({
      error: { code: 'HOSTED_CONVERSATION_INPUT_INVALID' }
    });

    const validAfterChangedLimit = await app.inject({
      method: 'GET',
      url: `/api/hosted-conversations?limit=2&cursor=${encodeURIComponent(cursor)}`,
      headers: { cookie: headers.cookie }
    });
    expect(validAfterChangedLimit.statusCode).toBe(200);

    fixture.findCurrentUserSession.mockReturnValue({
      userId: 8,
      username: 'other-member',
      isAdmin: false,
      sessionHash: 'other-session-hash',
      mustChangePassword: false,
      csrfTokenHash: hashOpaque(csrfToken)
    });
    const changedUser = await app.inject({
      method: 'GET',
      url: `/api/hosted-conversations?limit=2&cursor=${encodeURIComponent(cursor)}`,
      headers: { cookie: headers.cookie }
    });

    expect(changedUser.statusCode).toBe(400);
    expect(changedUser.json()).toMatchObject({
      error: { code: 'HOSTED_CONVERSATION_INPUT_INVALID' }
    });

    fixture.findCurrentUserSession.mockReturnValue({
      userId: 7,
      username: 'member',
      isAdmin: false,
      sessionHash: 'session-hash',
      mustChangePassword: false,
      csrfTokenHash: hashOpaque(csrfToken)
    });
    const validAfterChangedUser = await app.inject({
      method: 'GET',
      url: `/api/hosted-conversations?limit=2&cursor=${encodeURIComponent(cursor)}`,
      headers: { cookie: headers.cookie }
    });
    expect(validAfterChangedUser.statusCode).toBe(200);
  });

  it('injects the authorized template snapshot and model runtime catalog when creating', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations',
      headers,
      payload: {
        templateId: 'template-1',
        clientRequestId: 'create-1'
      }
    });

    expect(response.statusCode).toBe(201);
    expect(fixture.templates.requireForCreate).toHaveBeenCalledWith(7, 'template-1');
    expect(fixture.models.runtimeConfigurationsForUser).toHaveBeenCalledWith(7);
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenCalledWith(
      'node-1',
      'conversation.hosted.create',
      {
        templateId: 'template-1',
        clientRequestId: 'create-1',
        __template: template,
        __marAgentModels: [model]
      },
      expect.objectContaining({ userId: 7, sessionHash: 'session-hash' }),
      undefined
    );
    expect(fixture.nodeControl.requestNode).not.toHaveBeenCalled();
    expect(response.json()).toEqual(hostedSnapshot());
  });

  it('reads draft model options and injects the selected model when creating', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });
    const optionModel = {
      id: model.id,
      name: model.name,
      protocol: model.protocol,
      baseUrl: model.baseUrl,
      modelId: model.modelId,
      contextWindowTokens: model.contextWindowTokens,
      maxOutputTokens: model.maxOutputTokens,
      inputCapabilities: model.inputCapabilities,
      outputCapabilities: model.outputCapabilities,
      reasoningEfforts: model.reasoningEfforts,
      defaultReasoningEffort: 'high',
      titleGeneration: false,
      codeMode: false,
      conversationModel: true,
      hostedWebSearch: false,
      responsesPreviousResponseId: false,
      enabled: true,
      sortOrder: 0,
      apiKeyConfigured: true
    };
    fixture.nodeControl.requestHostedConversationNode.mockResolvedValueOnce({
      models: [optionModel],
      defaultModelId: 'model-1'
    });

    const options = await app.inject({
      method: 'GET',
      url: '/api/nodes/node-1/conversation-templates/template-1/model-options',
      headers
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations',
      headers,
      payload: { templateId: 'template-1', clientRequestId: 'create-model', modelId: 'model-1' }
    });

    expect(options.statusCode).toBe(200);
    expect(options.json()).toEqual({ models: [optionModel], defaultModelId: 'model-1' });
    expect(created.statusCode).toBe(201);
    expect(fixture.models.runtimeForUser).toHaveBeenCalledWith(7, 'model-1');
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      1,
      'node-1',
      'conversation.hosted.model-options',
      { templateId: 'template-1', __template: template, __marAgentModels: [model] },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      2,
      'node-1',
      'conversation.hosted.create',
      {
        templateId: 'template-1',
        clientRequestId: 'create-model',
        modelId: 'model-1',
        __template: template,
        __marAgentModel: model,
        __marAgentModels: [model]
      },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
  });

  it('uses the hosted relay for owner-scoped Watch when ordinary Node access is denied', async () => {
    const fixture = routeFixture();
    fixture.nodeControl.requestHostedConversationNode
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce({
        accepted: true,
        watchId: 'watch-hosted-1',
        nodeGeneration: 'generation-hosted',
        expiresAt: Date.now() + 45_000
      });
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1/watch',
      headers,
      payload: {
        mode: 'initial',
        workbenchConnectionId: 'connection-hosted',
        watchId: 'watch-hosted-1'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      1,
      'node-1',
      'conversation.hosted.get',
      { conversationId: 'conversation-1', __marAgentModels: [] },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      2,
      'node-1',
      'conversation.hosted.get',
      {
        conversationId: 'conversation-1',
        __sourceTemplateId: 'template-1',
        __marAgentModels: [model]
      },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      3,
      'node-1',
      'conversation.hosted.watch',
      {
        conversationId: 'conversation-1',
        mode: 'initial',
        workbenchConnectionId: 'connection-hosted',
        watchId: 'watch-hosted-1',
        __sourceTemplateId: 'template-1',
        __marAgentModels: [model]
      },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
    expect(fixture.nodeControl.requestNode).not.toHaveBeenCalled();
  });

  it('authorizes and forwards opaque hosted history pagination without caching the page', async () => {
    const fixture = routeFixture();
    fixture.nodeControl.requestHostedConversationNode.mockImplementation(
      async (_nodeId: string, operation: string, data: unknown) => {
        if (operation === 'conversation.hosted.get') return hostedSnapshot();
        if (operation === 'conversation.hosted.history') {
          expect(data).toEqual({
            conversationId: 'conversation-1',
            limit: 7,
            cursor: 'opaque-node-cursor'
          });
          return { turns: [], nextCursor: 'older-node-cursor' };
        }
        throw new Error(`unexpected operation: ${operation}`);
      }
    );
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1/history?limit=7&cursor=opaque-node-cursor',
      headers
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ turns: [], nextCursor: 'older-node-cursor' });
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenCalledWith(
      'node-1',
      'conversation.hosted.history',
      {
        conversationId: 'conversation-1',
        limit: 7,
        cursor: 'opaque-node-cursor'
      },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
    await app.close();
  });

  it('binds hosted create runtime models to the template source workspace without exposing it', async () => {
    const fixture = routeFixture();
    const prepare = vi.fn(async () => ({
      runtimeScopeId: 'scope-create',
      models: [model]
    }));
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      marAgentRuntimeModels: { prepare } as unknown as MarAgentRuntimeModelService,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations',
      headers,
      payload: {
        templateId: 'template-1',
        clientRequestId: 'create-runtime-1'
      }
    });

    expect(response.statusCode).toBe(201);
    expect(fixture.templates.runtimeContext).toHaveBeenCalledWith(7, 'template-1');
    expect(prepare).toHaveBeenCalledWith({
      userId: 7,
      nodeId: 'node-1',
      workspaceId: 'workspace-source'
    });
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenCalledWith(
      'node-1',
      'conversation.hosted.create',
      {
        templateId: 'template-1',
        clientRequestId: 'create-runtime-1',
        __template: template,
        __marAgentRuntimeScopeId: 'scope-create',
        __marAgentModels: [model]
      },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
    expect(
      JSON.stringify(fixture.nodeControl.requestHostedConversationNode.mock.calls)
    ).not.toContain('workspace-source');
  });

  it('probes existing hosted ownership before binding runtime models to the source workspace', async () => {
    const fixture = routeFixture();
    const prepare = vi.fn(async () => ({
      runtimeScopeId: 'scope-existing',
      models: [model]
    }));
    fixture.nodeControl.requestHostedConversationNode
      .mockResolvedValueOnce(hostedSnapshot({ conversation: { status: 'ACTIVE' } }))
      .mockResolvedValueOnce(hostedSnapshot({ conversation: { status: 'ACTIVE' } }));
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      marAgentRuntimeModels: { prepare } as unknown as MarAgentRuntimeModelService,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1',
      headers: { cookie: headers.cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      1,
      'node-1',
      'conversation.hosted.get',
      {
        conversationId: 'conversation-1',
        __marAgentModels: []
      },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
    expect(fixture.templates.runtimeContext).toHaveBeenCalledWith(7, 'template-1');
    expect(prepare).toHaveBeenCalledWith({
      userId: 7,
      nodeId: 'node-1',
      workspaceId: 'workspace-source'
    });
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      2,
      'node-1',
      'conversation.hosted.get',
      {
        conversationId: 'conversation-1',
        __marAgentRuntimeScopeId: 'scope-existing',
        __sourceTemplateId: 'template-1',
        __marAgentModels: [model]
      },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
  });

  it('authorizes the existing binding and prepares target-template runtime models before switching', async () => {
    const fixture = routeFixture();
    const target = { ...template, id: 'template-2', name: 'Office', currentVersionId: 'version-2' };
    fixture.templates.requireForCreate.mockResolvedValue(target);
    fixture.templates.runtimeContext.mockImplementation(async (_userId, templateId) => ({
      template: templateId === target.id ? target : template,
      nodeId: 'node-1',
      workspaceId: templateId === target.id ? 'workspace-target' : 'workspace-source'
    }));
    const prepare = vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({
      runtimeScopeId: workspaceId === 'workspace-target' ? 'scope-target' : 'scope-source',
      models: [model]
    }));
    const result = hostedTemplateSwitchResult(target);
    fixture.nodeControl.requestHostedConversationNode
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce(result);
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      marAgentRuntimeModels: { prepare } as unknown as MarAgentRuntimeModelService,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1/template',
      headers,
      payload: { expectedTemplateId: 'template-1', templateId: target.id }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(result);
    expect(fixture.templates.runtimeContext).toHaveBeenCalledWith(7, 'template-1');
    expect(fixture.templates.requireForCreate).toHaveBeenCalledWith(7, target.id);
    expect(fixture.templates.runtimeContext).toHaveBeenCalledWith(7, target.id);
    expect(prepare).toHaveBeenNthCalledWith(1, {
      userId: 7,
      nodeId: 'node-1',
      workspaceId: 'workspace-source'
    });
    expect(prepare).toHaveBeenCalledWith({
      userId: 7,
      nodeId: 'node-1',
      workspaceId: 'workspace-target'
    });
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      1,
      'node-1',
      'conversation.hosted.get',
      { conversationId: 'conversation-1', __marAgentModels: [] },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      2,
      'node-1',
      'conversation.hosted.get',
      {
        conversationId: 'conversation-1',
        __sourceTemplateId: 'template-1',
        __marAgentRuntimeScopeId: 'scope-source',
        __marAgentModels: [model]
      },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      3,
      'node-1',
      'conversation.hosted.template.switch',
      {
        conversationId: 'conversation-1',
        expectedTemplateId: 'template-1',
        templateId: target.id,
        __template: target,
        __marAgentRuntimeScopeId: 'scope-target',
        __marAgentModels: [model]
      },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
    expect(
      JSON.stringify(fixture.nodeControl.requestHostedConversationNode.mock.calls)
    ).not.toContain('workspace-target');
  });

  it('persists a routed template switch through the real Node service and exposes it on the next GET', async () => {
    const node = await runtimeFixture();
    let closeApp: (() => Promise<void>) | undefined;
    try {
      const targetDraft = {
        ...runtimeDraft,
        templateId: 'template-2',
        workspaceId: 'workspace-target',
        name: 'Office',
        description: 'Office template',
        allowedModels: [{ modelId: nodeModelTwo.modelId, name: nodeModelTwo.name }],
        defaultModelId: nodeModelTwo.modelId
      };
      await seedVersion(node, 'office-v1', 2, targetDraft);
      const original = await createConversation(node, [nodeModelOne, nodeModelTwo]);
      const target = {
        ...template,
        id: targetDraft.templateId,
        name: targetDraft.name,
        description: targetDraft.description,
        currentVersionId: 'office-v1'
      };
      const fixture = routeFixture();
      fixture.models.runtimeConfigurationsForUser.mockResolvedValue([nodeModelOne, nodeModelTwo]);
      fixture.templates.requireForCreate.mockResolvedValue(target);
      fixture.templates.runtimeContext.mockImplementation(async (_userId, templateId) => ({
        template: templateId === target.id ? target : template,
        nodeId: 'node-1',
        workspaceId: templateId === target.id ? 'workspace-target' : 'workspace-source'
      }));
      fixture.nodeControl.requestHostedConversationNode.mockImplementation(
        async (_nodeId, operation, data, authorization) => {
          const handler = node.service.operations()[operation];
          if (handler === undefined) throw new Error('FIXTURE_NODE_OPERATION_NOT_FOUND');
          if (data === null || typeof data !== 'object' || Array.isArray(data))
            throw new Error('FIXTURE_NODE_INPUT_INVALID');
          const actor = authorization as { userId: number; sessionHash: string };
          return handler({
            ...(data as Record<string, unknown>),
            __requestUserId: actor.userId,
            __workspaceWatchSessionHash: actor.sessionHash
          });
        }
      );
      const app = Fastify();
      closeApp = () => app.close();
      registerHostedConversationRoutes({
        app,
        database: fixture.database,
        templates: fixture.templates,
        models: fixture.models,
        nodeControl: fixture.nodeControl,
        publicOrigin: undefined
      });

      const switched = await app.inject({
        method: 'POST',
        url: `/api/nodes/node-1/hosted-conversations/${original.id}/template`,
        headers,
        payload: { expectedTemplateId: original.templateId, templateId: target.id }
      });

      expect(switched.statusCode).toBe(200);
      expect(switched.json()).toMatchObject({
        conversation: {
          id: original.id,
          nodeId: original.nodeId,
          sessionId: original.sessionId,
          templateId: target.id,
          templateName: target.name,
          activeVersionId: 'office-v1',
          modelId: nodeModelTwo.id
        },
        template: { id: target.id, name: target.name, currentVersionId: 'office-v1' },
        models: [expect.objectContaining({ id: nodeModelTwo.id })]
      });
      expect(node.store.requireConversation(7, original.id)).toMatchObject({
        id: original.id,
        nodeId: original.nodeId,
        sessionId: original.sessionId,
        templateId: target.id,
        templateName: target.name,
        activeVersionId: 'office-v1',
        modelId: nodeModelTwo.id
      });

      const rebound = await app.inject({
        method: 'GET',
        url: `/api/nodes/node-1/hosted-conversations/${original.id}`,
        headers: { cookie: headers.cookie }
      });

      expect(rebound.statusCode).toBe(200);
      expect(rebound.json()).toMatchObject({
        conversation: {
          id: original.id,
          sessionId: original.sessionId,
          templateId: target.id,
          activeVersionId: 'office-v1',
          modelId: nodeModelTwo.id
        },
        template: { id: target.id, name: target.name, currentVersionId: 'office-v1' },
        models: [expect.objectContaining({ id: nodeModelTwo.id })]
      });
      expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
        5,
        'node-1',
        'conversation.hosted.get',
        {
          conversationId: original.id,
          __sourceTemplateId: target.id,
          __marAgentModels: [nodeModelOne, nodeModelTwo]
        },
        expect.objectContaining({ userId: 7 }),
        undefined
      );
    } finally {
      await closeApp?.();
      await node.service.dispose();
    }
  });

  it('rejects a target template hosted by another Node before relaying a switch', async () => {
    const fixture = routeFixture();
    fixture.templates.requireForCreate.mockResolvedValue({
      ...template,
      id: 'template-remote',
      nodeId: 'node-2'
    });
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1/template',
      headers,
      payload: { expectedTemplateId: 'template-1', templateId: 'template-remote' }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'CONVERSATION_TEMPLATE_NOT_AUTHORIZED' }
    });
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenCalledTimes(2);
    expect(fixture.nodeControl.requestHostedConversationNode).not.toHaveBeenCalledWith(
      'node-1',
      'conversation.hosted.template.switch',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it('rejects browser-supplied internal fields on the template-switch request', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1/template',
      headers,
      payload: {
        expectedTemplateId: 'template-1',
        templateId: 'template-2',
        __template: template,
        __marAgentModels: [model]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(fixture.nodeControl.requestHostedConversationNode).not.toHaveBeenCalled();
    expect(fixture.templates.requireForCreate).not.toHaveBeenCalled();
  });

  it('rejects a switch result that changes the existing Session identity', async () => {
    const fixture = routeFixture();
    const target = { ...template, id: 'template-2', name: 'Office', currentVersionId: 'version-2' };
    fixture.templates.requireForCreate.mockResolvedValue(target);
    fixture.nodeControl.requestHostedConversationNode
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce(hostedTemplateSwitchResult(target, { sessionId: 'session-forged' }));
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1/template',
      headers,
      payload: { expectedTemplateId: 'template-1', templateId: target.id }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: 'NODE_RESPONSE_INVALID' } });
  });

  it('maps an invalid Node template-switch response to an upstream failure', async () => {
    const fixture = routeFixture();
    const target = { ...template, id: 'template-2', name: 'Office', currentVersionId: 'version-2' };
    fixture.templates.requireForCreate.mockResolvedValue(target);
    fixture.nodeControl.requestHostedConversationNode
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce({ conversation: { id: 'conversation-1' } });
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1/template',
      headers,
      payload: { expectedTemplateId: 'template-1', templateId: target.id }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: 'NODE_RESPONSE_INVALID' } });
  });

  it('rejects an incomplete Node result instead of returning a successful create response', async () => {
    const fixture = routeFixture();
    fixture.nodeControl.requestHostedConversationNode.mockResolvedValueOnce({
      conversation: { id: 'conversation-1' }
    });
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations',
      headers,
      payload: {
        templateId: 'template-1',
        clientRequestId: 'create-1'
      }
    });

    expect(response.statusCode).toBe(500);
    const body = response.json() as {
      error: {
        code: string;
        message: string;
        details?: string;
        requestId: string;
      };
    };
    expect(body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred.',
        details: expect.stringContaining('"conversation"'),
        requestId: expect.any(String)
      }
    });
    expect(body.error.details).toContain('"nodeId"');
    expect(body.error.details?.length).toBeLessThanOrEqual(1_000);
  });

  it('returns Node diagnostics and both request IDs for precise troubleshooting', async () => {
    const fixture = routeFixture();
    fixture.nodeControl.requestHostedConversationNode.mockRejectedValueOnce(
      Object.assign(new Error('INTERNAL_ERROR'), {
        publicMessage: 'An internal error occurred.',
        publicDetails: 'Git exited with status 128 while reading repository references.',
        upstreamRequestId: 'node-request-1'
      })
    );
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations',
      headers,
      payload: {
        templateId: 'template-1',
        clientRequestId: 'create-1'
      }
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred.',
        details: 'Git exited with status 128 while reading repository references.',
        requestId: expect.any(String),
        upstreamRequestId: 'node-request-1'
      }
    });
  });

  it('rechecks the owner snapshot, template and requested model before sending a message', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1/messages',
      headers,
      payload: {
        clientMessageId: 'message-1',
        prompt: 'Continue.',
        attachmentIds: [],
        modelId: 'model-1',
        deliveryIntent: 'REPLACE_CURRENT'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      1,
      'node-1',
      'conversation.hosted.get',
      { conversationId: 'conversation-1', __marAgentModels: [] },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
    expect(fixture.templates.assertCanUse).toHaveBeenCalledWith(7, 'template-1');
    expect(fixture.models.runtimeForUser).toHaveBeenCalledWith(7, 'model-1');
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      2,
      'node-1',
      'conversation.hosted.get',
      {
        conversationId: 'conversation-1',
        __sourceTemplateId: 'template-1',
        __marAgentModels: [model]
      },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      3,
      'node-1',
      'conversation.hosted.message',
      {
        conversationId: 'conversation-1',
        clientMessageId: 'message-1',
        prompt: 'Continue.',
        attachmentIds: [],
        modelId: 'model-1',
        deliveryIntent: 'REPLACE_CURRENT',
        __sourceTemplateId: 'template-1',
        __marAgentModel: model,
        __marAgentModels: [model]
      },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
  });

  it('rejects unsupported hosted message delivery intents before contacting the Node', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1/messages',
      headers,
      payload: {
        clientMessageId: 'message-queue',
        prompt: 'This hosted conversation cannot queue.',
        attachmentIds: [],
        deliveryIntent: 'QUEUE'
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'HOSTED_CONVERSATION_INPUT_INVALID' }
    });
    expect(fixture.nodeControl.requestHostedConversationNode).not.toHaveBeenCalled();
  });

  it('authorizes and forwards hosted rollback through its dedicated route with a strict public body', async () => {
    const fixture = routeFixture();
    const rolledBack = hostedSnapshot({
      turns: [],
      snapshotSequence: 2,
      nodeAppVersion: '0.9.55'
    });
    fixture.nodeControl.requestHostedConversationNode
      .mockResolvedValueOnce(hostedSnapshot({ nodeAppVersion: '0.9.55' }))
      .mockResolvedValueOnce(hostedSnapshot({ nodeAppVersion: '0.9.55' }))
      .mockResolvedValueOnce(rolledBack);
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1/rollback',
      headers,
      payload: {
        turnId: 'turn-2',
        boundary: 'turn-1',
        itemId: 'steered-user-item'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(rolledBack);
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      1,
      'node-1',
      'conversation.hosted.get',
      { conversationId: 'conversation-1', __marAgentModels: [] },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
    expect(fixture.templates.assertCanUse).toHaveBeenCalledWith(7, 'template-1');
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      2,
      'node-1',
      'conversation.hosted.get',
      {
        conversationId: 'conversation-1',
        __sourceTemplateId: 'template-1',
        __marAgentModels: [model]
      },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      3,
      'node-1',
      'conversation.hosted.rollback',
      {
        conversationId: 'conversation-1',
        turnId: 'turn-2',
        boundary: 'turn-1',
        itemId: 'steered-user-item',
        __sourceTemplateId: 'template-1',
        __marAgentModels: [model]
      },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
    expect(fixture.nodeControl.requestNode).not.toHaveBeenCalled();

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1/rollback',
      headers,
      payload: {
        turnId: 'turn-2',
        boundary: 'turn-1',
        conversationId: 'conversation-forged'
      }
    });
    expect(invalid.statusCode).toBe(400);
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenCalledTimes(3);

    for (const itemId of ['', 'x'.repeat(129)]) {
      const invalidItemId = await app.inject({
        method: 'POST',
        url: '/api/nodes/node-1/hosted-conversations/conversation-1/rollback',
        headers,
        payload: { turnId: 'turn-2', boundary: 'turn-1', itemId }
      });
      expect(invalidItemId.statusCode).toBe(400);
    }
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenCalledTimes(3);

    fixture.nodeControl.requestHostedConversationNode
      .mockResolvedValueOnce(hostedSnapshot({ nodeAppVersion: '0.9.55' }))
      .mockResolvedValueOnce(hostedSnapshot({ nodeAppVersion: '0.9.55' }))
      .mockRejectedValueOnce(new Error('HOSTED_CONVERSATION_ROLLBACK_TARGET_INVALID'));
    const staleBoundary = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1/rollback',
      headers,
      payload: {
        turnId: 'turn-2',
        boundary: 'turn-1'
      }
    });
    expect(staleBoundary.statusCode).toBe(409);
    expect(staleBoundary.json()).toMatchObject({
      error: { code: 'HOSTED_CONVERSATION_ROLLBACK_TARGET_INVALID' }
    });
  });

  it('rejects a hosted rollback response whose Node, template, or Session identity changes', async () => {
    const fixture = routeFixture();
    fixture.nodeControl.requestHostedConversationNode
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce(
        hostedSnapshot({
          conversation: { templateId: 'template-forged' },
          template: { id: 'template-forged' }
        })
      );
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1/rollback',
      headers,
      payload: { turnId: 'turn-2', boundary: null }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'HOSTED_CONVERSATION_NOT_AUTHORIZED' }
    });

    fixture.nodeControl.requestHostedConversationNode
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce(hostedSnapshot({ conversation: { sessionId: 'session-forged' } }));
    const changedSession = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1/rollback',
      headers,
      payload: { turnId: 'turn-2', boundary: null }
    });
    expect(changedSession.statusCode).toBe(403);
    expect(changedSession.json()).toMatchObject({
      error: { code: 'HOSTED_CONVERSATION_NOT_AUTHORIZED' }
    });
  });

  it('lets Node converge a stale concrete model preference to an authorized upstream alternative', async () => {
    const fixture = routeFixture();
    const alternative = { ...model, id: 'model-alternative' };
    fixture.models.runtimeConfigurationsForUser.mockResolvedValue([alternative]);
    fixture.models.runtimeForUser.mockRejectedValue(new Error('MAR_AGENT_MODEL_FORBIDDEN'));
    fixture.nodeControl.requestHostedConversationNode
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce(
        hostedSnapshot({
          conversation: {
            status: 'ACTIVE',
            modelId: 'model-old'
          }
        })
      )
      .mockResolvedValueOnce({ run: { id: 'run-fallback' } });
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1/messages',
      headers,
      payload: {
        clientMessageId: 'message-fallback',
        prompt: 'Continue with the available upstream configuration.',
        attachmentIds: [],
        modelId: 'model-old'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.models.runtimeForUser).not.toHaveBeenCalled();
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      2,
      'node-1',
      'conversation.hosted.get',
      {
        conversationId: 'conversation-1',
        __sourceTemplateId: 'template-1',
        __marAgentModels: [alternative]
      },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      3,
      'node-1',
      'conversation.hosted.message',
      {
        conversationId: 'conversation-1',
        clientMessageId: 'message-fallback',
        prompt: 'Continue with the available upstream configuration.',
        attachmentIds: [],
        modelId: 'model-old',
        __sourceTemplateId: 'template-1',
        __marAgentModels: [alternative]
      },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
  });

  it('rejects browser-supplied title and internal payload fields before contacting Node', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const browserTitle = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations',
      headers,
      payload: {
        templateId: 'template-1',
        clientRequestId: 'create-browser-title',
        title: 'New conversation'
      }
    });
    expect(browserTitle.statusCode).toBe(400);

    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations',
      headers,
      payload: {
        templateId: 'template-1',
        clientRequestId: 'create-1',
        __template: template
      }
    });

    expect(response.statusCode).toBe(400);
    expect(fixture.nodeControl.requestHostedConversationNode).not.toHaveBeenCalled();
  });

  it('validates and forwards hosted conversation title and pin metadata', async () => {
    const fixture = routeFixture();
    fixture.nodeControl.requestHostedConversationNode
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce({
        conversation: {
          ...hostedSnapshot().conversation,
          title: 'Renamed conversation',
          pinnedAt: 3_000,
          updatedAt: 3_000
        }
      });
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1',
      headers,
      payload: { title: '  Renamed conversation  ', pinned: true }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      conversation: { title: 'Renamed conversation', pinnedAt: 3_000 }
    });
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      3,
      'node-1',
      'conversation.hosted.metadata.update',
      {
        conversationId: 'conversation-1',
        title: 'Renamed conversation',
        pinned: true
      },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
  });

  it('authorizes hosted image reads without requiring ordinary Node access', async () => {
    const fixture = routeFixture();
    const runId = 'native-history:hosted:conversation-1';
    const imageRef = 'file:session%3Agenerated.png';
    const image = {
      name: 'generated.png',
      mime: 'image/png',
      dataBase64: Buffer.from('hosted-image').toString('base64')
    };
    fixture.nodeControl.requestHostedConversationNode
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce({ image });
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/nodes/node-1/hosted-conversations/conversation-1/runs/${encodeURIComponent(runId)}/images/${encodeURIComponent(imageRef)}`,
      headers: { cookie: headers.cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.rawPayload).toEqual(Buffer.from('hosted-image'));
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers.etag).toBeUndefined();
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      3,
      'node-1',
      'conversation.hosted.image.read',
      {
        conversationId: 'conversation-1',
        runId,
        imageRef
      },
      expect.objectContaining({ userId: 7, sessionHash: 'session-hash' }),
      undefined
    );
    expect(fixture.nodeControl.requestNode).not.toHaveBeenCalled();

    fixture.nodeControl.requestHostedConversationNode.mockClear();
    fixture.nodeControl.requestHostedConversationNode
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce({ image });
    const cached = await app.inject({
      method: 'GET',
      url: `/api/nodes/node-1/hosted-conversations/conversation-1/runs/${encodeURIComponent(runId)}/images/${encodeURIComponent(imageRef)}`,
      headers: {
        cookie: headers.cookie,
        'if-none-match': '"old-index-etag"'
      }
    });
    expect(cached.statusCode).toBe(200);
    expect(cached.headers['cache-control']).toBe('private, no-store');
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenCalledTimes(3);
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      1,
      'node-1',
      'conversation.hosted.get',
      { conversationId: 'conversation-1', __marAgentModels: [] },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      2,
      'node-1',
      'conversation.hosted.get',
      {
        conversationId: 'conversation-1',
        __sourceTemplateId: 'template-1',
        __marAgentModels: [model]
      },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
    fixture.nodeControl.requestHostedConversationNode.mockClear();
    const legacy = await app.inject({
      url: `/api/nodes/node-1/hosted-conversations/conversation-1/runs/${encodeURIComponent(runId)}/images/0`,
      headers: { cookie: headers.cookie, 'if-none-match': '"old-index-etag"' }
    });
    expect(legacy.statusCode).toBe(400);
    expect(fixture.nodeControl.requestHostedConversationNode).not.toHaveBeenCalled();
    await app.close();
  });

  it('forwards Hosted preview dimensions only after conversation authorization', async () => {
    const fixture = routeFixture();
    const runId = 'native-history:hosted:conversation-1';
    const imageRef = 'file:session%3Agenerated.png';
    const url = `/api/nodes/node-1/hosted-conversations/conversation-1/runs/${encodeURIComponent(runId)}/images/${encodeURIComponent(imageRef)}`;
    fixture.nodeControl.requestHostedConversationNode
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce({
        image: {
          mime: 'image/png',
          dataBase64: Buffer.from('original').toString('base64')
        }
      })
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce({
        image: {
          mime: 'image/webp',
          dataBase64: Buffer.from('preview').toString('base64'),
          resized: true
        }
      });
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const original = await app.inject({
      url,
      headers: { cookie: headers.cookie }
    });
    expect(original.statusCode).toBe(200);
    expect(original.headers['content-type']).toContain('image/png');
    expect(original.headers['x-mar-image-resized']).toBeUndefined();
    expect(original.rawPayload).toEqual(Buffer.from('original'));
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      3,
      'node-1',
      'conversation.hosted.image.read',
      { conversationId: 'conversation-1', runId, imageRef },
      expect.objectContaining({ userId: 7, sessionHash: 'session-hash' }),
      undefined
    );

    const preview = await app.inject({
      url: `${url}?maxWidth=320&maxHeight=240`,
      headers: { cookie: headers.cookie }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toContain('image/webp');
    expect(preview.headers['x-mar-image-resized']).toBe('1');
    expect(preview.rawPayload).toEqual(Buffer.from('preview'));
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      6,
      'node-1',
      'conversation.hosted.image.read',
      {
        conversationId: 'conversation-1',
        runId,
        imageRef,
        preview: { maxWidth: 320, maxHeight: 240 }
      },
      expect.objectContaining({ userId: 7, sessionHash: 'session-hash' }),
      undefined
    );
    expect(fixture.nodeControl.requestNode).not.toHaveBeenCalled();

    fixture.nodeControl.requestHostedConversationNode.mockClear();
    for (const query of ['maxWidth=320', 'maxWidth=0&maxHeight=240']) {
      const invalid = await app.inject({
        url: `${url}?${query}`,
        headers: { cookie: headers.cookie }
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe('RUN_IMAGE_INVALID');
    }
    expect(fixture.nodeControl.requestHostedConversationNode).not.toHaveBeenCalled();
    await app.close();
  });

  it('previews Hosted file content while preserving original HTTP byte ranges', async () => {
    const fixture = routeFixture();
    const fileId = 'file-1';
    const url = `/api/nodes/node-1/hosted-conversations/conversation-1/files/${fileId}/content`;
    const file = {
      id: fileId,
      conversationId: 'conversation-1',
      category: 'OUTPUT',
      relativePath: 'output/data.txt',
      displayName: 'data.txt',
      mimeType: 'text/plain',
      size: 6,
      source: 'AGENT',
      createdAt: 1_000,
      updatedAt: 2_000
    };
    fixture.nodeControl.requestHostedConversationNode
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce({
        image: {
          mime: 'image/webp',
          dataBase64: Buffer.from('preview').toString('base64'),
          resized: false
        }
      });
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const preview = await app.inject({
      url: `${url}?maxWidth=320&maxHeight=240`,
      headers: { cookie: headers.cookie }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toContain('image/webp');
    expect(preview.headers['x-mar-image-resized']).toBe('0');
    expect(preview.headers['cache-control']).toBe('private, no-store');
    expect(preview.rawPayload).toEqual(Buffer.from('preview'));
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      3,
      'node-1',
      'conversation.hosted.file.read',
      { conversationId: 'conversation-1', fileId, preview: { maxWidth: 320, maxHeight: 240 } },
      expect.objectContaining({ userId: 7, sessionHash: 'session-hash' }),
      undefined
    );

    fixture.nodeControl.requestHostedConversationNode.mockClear();
    fixture.nodeControl.requestHostedConversationNode
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce({
        file,
        encoding: 'base64',
        content: Buffer.from('a').toString('base64'),
        offset: 0,
        nextOffset: 1,
        eof: false
      })
      .mockResolvedValueOnce({
        file,
        encoding: 'base64',
        content: Buffer.from('cde').toString('base64'),
        offset: 2,
        nextOffset: 5,
        eof: false
      });
    const originalRange = await app.inject({
      url,
      headers: { cookie: headers.cookie, range: 'bytes=2-4' }
    });
    expect(originalRange.statusCode).toBe(206);
    expect(originalRange.headers['content-range']).toBe('bytes 2-4/6');
    expect(originalRange.headers['x-mar-image-resized']).toBeUndefined();
    expect(originalRange.rawPayload).toEqual(Buffer.from('cde'));
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      3,
      'node-1',
      'conversation.hosted.file.read',
      { conversationId: 'conversation-1', fileId, offset: 0, limit: 1 },
      expect.objectContaining({ userId: 7, sessionHash: 'session-hash' }),
      undefined
    );
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      4,
      'node-1',
      'conversation.hosted.file.read',
      { conversationId: 'conversation-1', fileId, offset: 2, limit: 3 },
      expect.objectContaining({ userId: 7, sessionHash: 'session-hash' }),
      undefined
    );
    await app.close();
  });
});

const template: ConversationTemplateSummary = {
  id: 'template-1',
  nodeId: 'node-1',
  name: 'Research',
  description: 'Research template',
  status: 'ACTIVE',
  currentVersionId: 'version-1',
  available: true,
  createdAt: 1_000,
  updatedAt: 2_000
};

const model: MarAgentRuntimeModelConfiguration = {
  id: 'model-1',
  name: 'Model One',
  protocol: 'OPENAI_RESPONSES',
  baseUrl: 'https://models.example.test/v1',
  apiKey: 'secret',
  modelId: 'model-one',
  contextWindowTokens: 100_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: ['high'],
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true
};

function hostedSnapshot(
  overrides: {
    readonly nodeAppVersion?: string;
    readonly conversation?: {
      readonly status?: 'ACTIVE';
      readonly modelId?: string;
      readonly templateId?: string;
      readonly sessionId?: string;
    };
    readonly template?: {
      readonly id?: string;
      readonly status?: 'ACTIVE' | 'DELETED';
      readonly available?: boolean;
    };
    readonly turns?: readonly unknown[];
    readonly snapshotSequence?: number;
  } = {}
) {
  return {
    ...(overrides.nodeAppVersion === undefined ? {} : { nodeAppVersion: overrides.nodeAppVersion }),
    conversation: {
      id: 'conversation-1',
      nodeId: 'node-1',
      sessionId: 'session-1',
      templateId: 'template-1',
      templateName: 'Research',
      activeVersionId: 'version-1',
      title: 'Research',
      titleSource: 'CUSTOM',
      pinnedAt: null,
      status: 'ACTIVE',
      modelId: 'model-1',
      createdAt: 1_000,
      updatedAt: 2_000,
      lastActivityAt: 2_000,
      activity: { status: 'IDLE', version: 0, updatedAt: 0 },
      ...overrides.conversation
    },
    template: {
      ...template,
      ...overrides.template
    },
    run: null,
    turns: overrides.turns ?? [],
    historyNextCursor: null,
    files: [],
    models: [],
    error: null,
    snapshotSequence: overrides.snapshotSequence ?? 0
  };
}

function hostedTemplateSwitchResult(
  target: ConversationTemplateSummary,
  conversationOverrides: Partial<HostedConversationSummary> = {}
) {
  if (target.currentVersionId === null)
    throw new Error('Target template requires a published version');
  return {
    conversation: hostedSummary('node-1', 'conversation-1', {
      sessionId: 'session-1',
      templateId: target.id,
      templateName: target.name,
      activeVersionId: target.currentVersionId,
      ...conversationOverrides
    }),
    template: target,
    models: [
      {
        id: 'model-1',
        name: 'Model One',
        protocol: 'OPENAI_RESPONSES',
        baseUrl: 'https://models.example.test/v1',
        modelId: 'model-one',
        contextWindowTokens: 100_000,
        maxOutputTokens: 4096,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: ['high'],
        hostedWebSearch: false,
        responsesPreviousResponseId: false,
        titleGeneration: false,
        enabled: true,
        sortOrder: 0
      }
    ]
  };
}

function hostedSummary(
  nodeId: string,
  id: string,
  overrides: Partial<HostedConversationSummary> = {}
): HostedConversationSummary {
  return {
    id,
    nodeId,
    sessionId: `session-${id}`,
    templateId: `template-${nodeId}`,
    templateName: 'Research',
    activeVersionId: 'version-1',
    title: id,
    titleSource: 'CUSTOM',
    pinnedAt: null,
    status: 'ACTIVE',
    modelId: 'model-1',
    createdAt: 1_000,
    updatedAt: 2_000,
    lastActivityAt: 2_000,
    activity: { status: 'IDLE', version: 0, updatedAt: 0 },
    ...overrides
  };
}

function storedNode(
  id: string,
  overrides: {
    readonly metadata?: string;
    readonly version?: string;
    readonly connected?: boolean;
    readonly disabled?: boolean;
  } = {}
): StoredNodePresence {
  return {
    id,
    ownerUserId: 1,
    displayName: id,
    registeredAddress: '127.0.0.1',
    metadata:
      overrides.metadata ??
      JSON.stringify({
        platform: 'linux',
        architecture: 'x64',
        nodeAppVersion: overrides.version ?? '0.9.27',
        nodeVersion: '22.0.0',
        metadata: {},
        codex: { available: false },
        claudeCode: { available: false },
        marAgent: { available: true, version: '0.9.27' },
        conversationHosting: {
          state: 'AVAILABLE',
          apiVersion: 1,
          sandboxBackend: 'BUBBLEWRAP',
          sandboxPolicyVersion: 1,
          acceptsNewConversations: true,
          supportsExistingConversations: true,
          capacity: 'AVAILABLE'
        }
      }),
    connected: overrides.connected ?? true,
    disabled: overrides.disabled ?? false,
    lastHeartbeatAt: 2_000
  };
}

function routeFixture() {
  const findCurrentUserSession = vi.fn(() => ({
    userId: 7,
    username: 'member',
    isAdmin: false,
    sessionHash: 'session-hash',
    mustChangePassword: false,
    csrfTokenHash: hashOpaque(csrfToken)
  }));
  const database = {
    findCurrentUserSession,
    audit: vi.fn(async () => undefined)
  } as unknown as MysqlServerDatabase;
  const nodeControl = {
    requestHostedConversationNode: vi.fn(
      async (
        _nodeId: string,
        operation: string,
        _data?: unknown,
        _user?: unknown
      ): Promise<unknown> => {
        if (operation === 'conversation.hosted.get') return hostedSnapshot();
        if (operation === 'conversation.hosted.create') return hostedSnapshot();
        return { run: { id: 'run-1' } };
      }
    ),
    requestNode: vi.fn(async () => {
      throw new Error('NODE_ACCESS_DENIED');
    }),
    listNodes: vi.fn(async () => []),
    ownsWorkbenchConnection: vi.fn(() => true)
  } as unknown as NodeControl & {
    requestHostedConversationNode: ReturnType<typeof vi.fn>;
    requestNode: ReturnType<typeof vi.fn>;
    listNodes: ReturnType<typeof vi.fn>;
    ownsWorkbenchConnection: ReturnType<typeof vi.fn>;
  };
  const templates = {
    requireForCreate: vi.fn(async () => template),
    assertCanUse: vi.fn(async (_userId: number, templateId: string) => ({
      ...template,
      id: templateId,
      nodeId: templateId.startsWith('template-node-')
        ? templateId.slice('template-'.length)
        : 'node-1'
    })),
    runtimeContext: vi.fn(async () => ({
      template,
      nodeId: 'node-1',
      workspaceId: 'workspace-source'
    }))
  } as unknown as ConversationTemplateService & {
    requireForCreate: ReturnType<typeof vi.fn>;
    assertCanUse: ReturnType<typeof vi.fn>;
    runtimeContext: ReturnType<typeof vi.fn>;
  };
  const models = {
    runtimeForUser: vi.fn(async () => model),
    runtimeConfigurationsForUser: vi.fn(async () => [model])
  } as unknown as MarAgentModelService & {
    runtimeForUser: ReturnType<typeof vi.fn>;
    runtimeConfigurationsForUser: ReturnType<typeof vi.fn>;
  };
  return { database, findCurrentUserSession, nodeControl, templates, models };
}
