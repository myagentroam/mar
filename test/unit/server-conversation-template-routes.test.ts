import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationTemplateDraft } from '../../packages/protocol/src/index.js';
import { hashOpaque } from '../../ee/server/src/database.js';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import type { NodeControl } from '../../ee/server/src/node-control.js';
import type { NodeUpgradeService } from '../../packages/server-core/src/node-upgrade-service.js';
import { registerConversationTemplateRoutes } from '../../ee/server/src/route/conversation-template-routes.js';
import { registerResourceGrantRoutes } from '../../ee/server/src/route/resource-grant-routes.js';
import type { ResourceAccessService } from '../../ee/server/src/rbac/resource-access-service.js';
import type {
  ConversationTemplateService,
  InspectConversationTemplateDraft
} from '../../ee/server/src/service/conversation-template-service.js';
import type {
  PublishConversationTemplateDraft,
  RefreshConversationTemplatePublish
} from '../../packages/server-core/src/conversation-template-publisher.js';

const csrfToken = 'csrf-token';
const headers = {
  cookie: 'mar_user_session=session-id',
  'x-csrf-token': csrfToken
};

const draftInput: Omit<ConversationTemplateDraft, 'templateId' | 'revision' | 'updatedAt'> = {
  nodeId: 'node-1',
  workspaceId: 'workspace-1',
  name: 'Research',
  description: '',
  allowedModels: [{ modelId: 'coding-config-id', name: 'Coding' }],
  defaultModelId: 'coding-config-id',
  mcpIds: ['mcp-local'],
  networkMode: 'NONE',
  quotas: {
    maxStorageBytes: 1000,
    maxUploadBytes: 100
  }
};

const draft: ConversationTemplateDraft = {
  templateId: 'template-1',
  revision: 1,
  updatedAt: 2_000,
  ...draftInput
};

describe('Server conversation template routes', () => {
  it('returns strict Node-scoped template model options to management admins', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerConversationTemplateRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/conversation-templates/model-options?nodeId=node-1',
      headers: { cookie: headers.cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      models: [{ modelId: 'coding-config-id', name: 'Coding' }]
    });
    expect(fixture.templates.listModelOptions).toHaveBeenCalledWith('node-1');

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/admin/conversation-templates/model-options?nodeId=node-1&extra=value',
      headers: { cookie: headers.cookie }
    });
    expect(invalid.statusCode).toBe(400);
    expect(fixture.templates.listModelOptions).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('routes create, draft test and publish through fixed Node operations with user authorization', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerConversationTemplateRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/conversation-templates',
      headers,
      payload: draftInput
    });
    expect(created.statusCode).toBe(201);
    expect(fixture.nodeControl.requestNode).toHaveBeenNthCalledWith(
      1,
      'node-1',
      'conversation.template.source.inspect',
      { mode: 'VALIDATE', draft },
      expect.objectContaining({
        userId: 1,
        sessionHash: 'session-hash',
        workspaceId: 'workspace-1'
      }),
      undefined
    );

    const tested = await app.inject({
      method: 'POST',
      url: '/api/admin/conversation-templates/template-1/test',
      headers,
      payload: { ...draftInput, draftRevision: 1 }
    });
    expect(tested.statusCode).toBe(200);
    expect(fixture.nodeControl.requestNode).toHaveBeenNthCalledWith(
      2,
      'node-1',
      'conversation.template.source.inspect',
      { mode: 'DRAFT_TEST', draft: { ...draft, revision: 2 } },
      expect.objectContaining({ workspaceId: 'workspace-1' }),
      undefined
    );

    const published = await app.inject({
      method: 'POST',
      url: '/api/admin/conversation-templates/template-1/publish',
      headers,
      payload: { templateId: 'template-1', draftRevision: 1, requestId: 'request-1' }
    });
    expect(published.statusCode).toBe(202);
    expect(fixture.nodeControl.requestNode).toHaveBeenNthCalledWith(
      3,
      'node-1',
      'conversation.template.publish',
      { templateId: 'template-1', jobId: 'request-1', draft, requestedByUserId: 1 },
      expect.objectContaining({ workspaceId: 'workspace-1' }),
      undefined
    );

    const status = await app.inject({
      method: 'GET',
      url: '/api/admin/conversation-templates/template-1/publish-jobs/request-1',
      headers: { cookie: headers.cookie }
    });
    expect(status.statusCode).toBe(200);
    expect(fixture.nodeControl.requestNode).toHaveBeenNthCalledWith(
      4,
      'node-1',
      'conversation.template.publish.status',
      { templateId: 'template-1', jobId: 'request-1' },
      expect.objectContaining({ userId: 1, sessionHash: 'session-hash' }),
      undefined
    );
    expect(fixture.nodeControl.requestNode.mock.calls[3]?.[3]).not.toHaveProperty('workspaceId');
    await app.close();
  });

  it('returns a client error when a template model is no longer available', async () => {
    const fixture = routeFixture();
    const create = fixture.templates.create as ReturnType<typeof vi.fn>;
    create.mockRejectedValueOnce(new Error('CONVERSATION_TEMPLATE_MODEL_INVALID'));
    const app = Fastify();
    registerConversationTemplateRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/conversation-templates',
      headers,
      payload: draftInput
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'CONVERSATION_TEMPLATE_MODEL_INVALID',
        message: 'Conversation template model is invalid.',
        requestId: expect.any(String)
      }
    });
    await app.close();
  });

  it('returns a conflict when an existing template source is changed', async () => {
    const fixture = routeFixture();
    const update = fixture.templates.update as ReturnType<typeof vi.fn>;
    update.mockRejectedValueOnce(new Error('CONVERSATION_TEMPLATE_SOURCE_IMMUTABLE'));
    const app = Fastify();
    registerConversationTemplateRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/admin/conversation-templates/template-1',
      headers,
      payload: { ...draftInput, nodeId: 'node-2', workspaceId: 'workspace-2', draftRevision: 1 }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'CONVERSATION_TEMPLATE_SOURCE_IMMUTABLE',
        message: 'Conversation template source is immutable.',
        requestId: expect.any(String)
      }
    });
    await app.close();
  });

  it('accepts TEMPLATE grants and does not revalidate Terminal authorization when one is removed', async () => {
    const fixture = routeFixture();
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
      grants: fixture.resources as never,
      nodeControl: fixture.nodeControl,
      nodeUpgrades: {} as NodeUpgradeService,
      publicOrigin: undefined
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/resource-grants?resourceType=TEMPLATE&templateId=template-1',
      headers: { cookie: headers.cookie }
    });
    expect(listed.statusCode).toBe(200);
    expect(fixture.resources.listGrants).toHaveBeenCalledWith(1, 'TEMPLATE', 'template-1', null);

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/resource-grants?resourceType=TEMPLATE&templateId=template-1&modelId=model-1',
      headers: { cookie: headers.cookie }
    });
    expect(invalid.statusCode).toBe(400);
    expect(fixture.resources.listGrants).toHaveBeenCalledTimes(1);

    const created = await app.inject({
      method: 'POST',
      url: '/api/resource-grants',
      headers,
      payload: {
        resourceType: 'TEMPLATE',
        templateId: 'template-1',
        targetType: 'ORGANIZATION',
        targetOrganizationId: 2
      }
    });
    expect(created.statusCode).toBe(201);
    expect(fixture.resources.createGrant).toHaveBeenCalledWith(1, 'TEMPLATE', 'template-1', null, {
      targetType: 'ORGANIZATION',
      targetOrganizationId: 2
    });
    for (const target of [{ targetType: 'ENTERPRISE' }, { targetType: 'USER', targetUserId: 8 }]) {
      const rejected = await app.inject({
        method: 'POST',
        url: '/api/resource-grants',
        headers,
        payload: {
          resourceType: 'TEMPLATE',
          templateId: 'template-1',
          ...target
        }
      });
      expect(rejected.statusCode).toBe(400);
    }
    for (const code of [
      'CONVERSATION_TEMPLATE_HOST_NODE_INVALID',
      'CONVERSATION_TEMPLATE_GRANT_SCOPE_INVALID'
    ]) {
      fixture.resources.createGrant.mockRejectedValueOnce(new Error(code));
      const conflict = await app.inject({
        method: 'POST',
        url: '/api/resource-grants',
        headers,
        payload: {
          resourceType: 'TEMPLATE',
          templateId: 'template-1',
          targetType: 'ORGANIZATION',
          targetOrganizationId: 2
        }
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: { code } });
    }
    expect(fixture.resources.createGrant).toHaveBeenCalledTimes(3);

    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/resource-grants/grant-1',
      headers
    });
    expect(removed.statusCode).toBe(204);
    expect(fixture.nodeControl.revalidateTerminalAuthorizations).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns only the service-filtered user catalog and rejects non-admin management writes', async () => {
    const fixture = routeFixture();
    fixture.database.findCurrentUserSession = vi.fn(() => ({
      userId: 8,
      username: 'member',
      isAdmin: false,
      sessionHash: 'member-session',
      mustChangePassword: false,
      csrfTokenHash: hashOpaque(csrfToken)
    }));
    const app = Fastify();
    registerConversationTemplateRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const catalog = await app.inject({
      method: 'GET',
      url: '/api/conversation-templates',
      headers: { cookie: headers.cookie }
    });
    expect(catalog.statusCode).toBe(200);
    expect(fixture.templates.listForUser).toHaveBeenCalledWith(8);

    const denied = await app.inject({
      method: 'POST',
      url: '/api/admin/conversation-templates',
      headers,
      payload: draftInput
    });
    expect(denied.statusCode).toBe(403);
    expect(fixture.templates.create).not.toHaveBeenCalled();
    await app.close();
  });
});

function routeFixture() {
  const database = {
    findCurrentUserSession: vi.fn(() => ({
      userId: 1,
      username: 'admin',
      isAdmin: true,
      sessionHash: 'session-hash',
      mustChangePassword: false,
      csrfTokenHash: hashOpaque(csrfToken)
    })),
    audit: vi.fn(async () => undefined)
  } as unknown as MysqlServerDatabase & {
    findCurrentUserSession: ReturnType<typeof vi.fn>;
  };
  const nodeControl = {
    requestNode: vi.fn(async (_nodeId: string, operation: string) =>
      operation === 'conversation.template.publish' ||
      operation === 'conversation.template.publish.status'
        ? {
            job: {
              id: 'request-1',
              templateId: 'template-1',
              draftRevision: 1,
              stage: 'REGISTERED',
              status: 'SUCCEEDED',
              versionId: 'version-1',
              errorCode: null,
              createdAt: 2_000,
              updatedAt: 2_100
            },
            version: {
              id: 'version-1',
              templateId: 'template-1',
              version: 1,
              status: 'AVAILABLE',
              contentHash: 'a'.repeat(64),
              manifestHash: 'b'.repeat(64),
              fileCount: 1,
              totalBytes: 10,
              hostPolicyVersion: 1,
              publishedByUserId: 1,
              publishedAt: 2_100
            }
          }
        : {
            valid: true,
            code: null,
            message: 'The draft source is valid.',
            checkedAt: 2_000
          }
    ),
    revalidateTerminalAuthorizations: vi.fn(async () => undefined)
  } as unknown as NodeControl & {
    requestNode: ReturnType<typeof vi.fn>;
    revalidateTerminalAuthorizations: ReturnType<typeof vi.fn>;
  };
  const templates = {
    listForUser: vi.fn(async () => []),
    listAdmin: vi.fn(async () => []),
    listModelOptions: vi.fn(async () => [{ modelId: 'coding-config-id', name: 'Coding' }]),
    detail: vi.fn(async () => ({})),
    create: vi.fn(
      async (_userId: number, _raw: unknown, inspect: InspectConversationTemplateDraft) => {
        await inspect(draft, 'VALIDATE');
        return { template: {}, draft };
      }
    ),
    update: vi.fn(async () => ({ template: {}, draft })),
    testDraft: vi.fn(
      async (
        _userId: number,
        _templateId: string,
        _raw: unknown,
        inspect: InspectConversationTemplateDraft
      ) => {
        const candidate = { ...draft, revision: 2 };
        return inspect(candidate, 'DRAFT_TEST');
      }
    ),
    publish: vi.fn(
      async (
        _userId: number,
        _templateId: string,
        _raw: unknown,
        publish: PublishConversationTemplateDraft
      ) => publish(draft, 'request-1', 1)
    ),
    publishStatus: vi.fn(
      async (
        _userId: number,
        _templateId: string,
        jobId: string,
        refresh: RefreshConversationTemplatePublish
      ) => refresh('node-1', 'workspace-1', 'template-1', jobId)
    ),
    disable: vi.fn(async () => undefined),
    archive: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined)
  } as unknown as ConversationTemplateService & Record<string, ReturnType<typeof vi.fn>>;
  const resources = {
    listGrants: vi.fn(async () => []),
    createGrant: vi.fn(async () => 'grant-1'),
    removeGrant: vi.fn(async () => 'TEMPLATE' as const)
  } as unknown as ResourceAccessService & {
    listGrants: ReturnType<typeof vi.fn>;
    createGrant: ReturnType<typeof vi.fn>;
    removeGrant: ReturnType<typeof vi.fn>;
  };
  return { database, nodeControl, templates, resources };
}
