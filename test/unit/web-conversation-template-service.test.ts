import { describe, expect, it } from 'vitest';
import { ApiError } from '../../ee/web/src/util/api-error.js';
import {
  conversationTemplateBytesToMiB,
  conversationTemplateModelSelectionIsAvailable,
  conversationTemplateModelReferences,
  createConversationTemplateService,
  conversationTemplateErrorMessageKey,
  conversationTemplateMiBToBytes,
  reconcileConversationTemplateModelSelection,
  sameConversationTemplateRequestContext
} from '../../ee/web/src/service/conversation-template-service.js';

const summary = {
  id: 'template-1',
  nodeId: 'node-1',
  name: 'Code Review',
  description: 'Review changes.',
  status: 'ACTIVE',
  currentVersionId: 'version-1',
  available: true,
  createdAt: 1,
  updatedAt: 2
} as const;

const storedDraft = {
  templateId: summary.id,
  nodeId: 'node-1',
  workspaceId: 'workspace-1',
  revision: 1,
  name: summary.name,
  description: summary.description,
  allowedModels: [{ modelId: 'coding', name: 'Coding snapshot' }],
  defaultModelId: 'coding',
  mcpIds: [],
  networkMode: 'NONE',
  quotas: {
    maxStorageBytes: 1024,
    maxUploadBytes: 512
  },
  updatedAt: 2
} as const;

describe('Web conversation template service', () => {
  it('Reads templates through public and management routes and rejects unknown response fields', async () => {
    const requests: string[] = [];
    const unpublished = {
      ...summary,
      id: 'template-2',
      currentVersionId: null,
      available: false
    } as const;
    const service = createConversationTemplateService(async (path) => {
      requests.push(path);
      if (path === '/api/conversation-templates') return { templates: [summary] } as never;
      return {
        templates: [
          { ...summary, draftRevision: 3, publishedVersion: 5 },
          { ...unpublished, draftRevision: 4, publishedVersion: null }
        ]
      } as never;
    });

    await expect(service.listAvailable()).resolves.toEqual([summary]);
    await expect(service.listAdmin()).resolves.toEqual([
      { ...summary, draftRevision: 3, publishedVersion: 5 },
      { ...unpublished, draftRevision: 4, publishedVersion: null }
    ]);
    expect(requests).toEqual(['/api/conversation-templates', '/api/admin/conversation-templates']);

    const invalid = createConversationTemplateService(
      async () =>
        ({
          templates: [{ ...summary, leakedInternalPath: '/srv/private' }]
        }) as never
    );
    await expect(invalid.listAvailable()).rejects.toThrow('CONVERSATION_TEMPLATE_RESPONSE_INVALID');

    const inconsistentAdmin = createConversationTemplateService(
      async () =>
        ({
          templates: [{ ...summary, draftRevision: 3, publishedVersion: null }]
        }) as never
    );
    await expect(inconsistentAdmin.listAdmin()).rejects.toThrow(
      'CONVERSATION_TEMPLATE_RESPONSE_INVALID'
    );
  });

  it('Creation and publication send only protocol fields and preserve structured API error codes', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const service = createConversationTemplateService(async (path, init) => {
      recordRequest(requests, path, init);
      if (path.endsWith('/publish'))
        throw new ApiError(
          'CONVERSATION_TEMPLATE_REVISION_CONFLICT',
          'The template draft revision is stale.'
        );
      return { template: summary, draft: storedDraft } as never;
    });
    const draft = {
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      name: ' Code Review ',
      description: 'Review changes.',
      allowedModels: [{ modelId: 'coding', name: 'Current Coding' }],
      defaultModelId: 'coding',
      mcpIds: [],
      networkMode: 'NONE',
      quotas: {
        maxStorageBytes: 1024,
        maxUploadBytes: 512
      },
      ignored: 'must-not-be-sent'
    } as const;

    await service.create(draft);
    expect(requests[0]).toEqual({
      path: '/api/admin/conversation-templates',
      init: {
        method: 'POST',
        body: JSON.stringify({
          nodeId: 'node-1',
          workspaceId: 'workspace-1',
          name: 'Code Review',
          description: 'Review changes.',
          allowedModels: [{ modelId: 'coding', name: 'Current Coding' }],
          defaultModelId: 'coding',
          mcpIds: [],
          networkMode: 'NONE',
          quotas: {
            maxStorageBytes: 1024,
            maxUploadBytes: 512
          }
        })
      }
    });

    await expect(service.publish(summary.id, 3, 'request-1')).rejects.toMatchObject({
      code: 'CONVERSATION_TEMPLATE_REVISION_CONFLICT'
    });
    expect(
      conversationTemplateErrorMessageKey(
        requests.length === 2 ? 'CONVERSATION_TEMPLATE_REVISION_CONFLICT' : ''
      )
    ).toBe('conversationTemplates.errorRevisionConflict');
    expect(conversationTemplateErrorMessageKey('CONVERSATION_TEMPLATE_PUBLISH_FAILED')).toBe(
      'conversationTemplates.errorPublishFailed'
    );
    expect(conversationTemplateErrorMessageKey('TEMPLATE_RESOURCE_ADMIN_REQUIRED')).toBe(
      'conversationTemplates.errorAdminRequired'
    );
    expect(conversationTemplateErrorMessageKey('CONVERSATION_TEMPLATE_SOURCE_EXCLUDED')).toBe(
      'conversationTemplates.errorSourceExcluded'
    );
    expect(conversationTemplateErrorMessageKey('CONVERSATION_TEMPLATE_SOURCE_LINK_INVALID')).toBe(
      'conversationTemplates.errorSourceLinkInvalid'
    );
    expect(conversationTemplateErrorMessageKey('CONVERSATION_TEMPLATE_SOURCE_MISSING')).toBe(
      'conversationTemplates.errorSourceMissing'
    );
    expect(conversationTemplateErrorMessageKey('CONVERSATION_TEMPLATE_SOURCE_TOO_LARGE')).toBe(
      'conversationTemplates.errorSourceTooLarge'
    );
    expect(conversationTemplateErrorMessageKey('CONVERSATION_TEMPLATE_SOURCE_TYPE_INVALID')).toBe(
      'conversationTemplates.errorSourceTypeInvalid'
    );
    expect(conversationTemplateErrorMessageKey('CONVERSATION_TEMPLATE_SOURCE_CHANGED')).toBe(
      'conversationTemplates.errorSourceChanged'
    );
    expect(conversationTemplateErrorMessageKey('CONVERSATION_TEMPLATE_SOURCE_IMMUTABLE')).toBe(
      'conversationTemplates.errorSourceImmutable'
    );
    expect(conversationTemplateErrorMessageKey('CONVERSATION_TEMPLATE_RESERVED_PATH')).toBe(
      'conversationTemplates.errorReservedPath'
    );
    expect(conversationTemplateErrorMessageKey('CONVERSATION_TEMPLATE_MCP_INVALID')).toBe(
      'conversationTemplates.errorMcpInvalid'
    );
    expect(conversationTemplateErrorMessageKey('CONVERSATION_TEMPLATE_MODEL_INVALID')).toBe(
      'conversationTemplates.errorModelInvalid'
    );
    expect(conversationTemplateErrorMessageKey('CONVERSATION_TEMPLATE_PUBLISH_INTERRUPTED')).toBe(
      'conversationTemplates.errorPublishInterrupted'
    );
    expect(conversationTemplateErrorMessageKey('CONVERSATION_TEMPLATE_VERSION_CORRUPTED')).toBe(
      'conversationTemplates.errorVersionCorrupted'
    );
    expect(conversationTemplateErrorMessageKey('WORKSPACE_NOT_FOUND')).toBe(
      'conversationTemplates.errorWorkspaceNotFound'
    );
  });

  it('Rejects invalid template summaries instead of projecting malformed Server data', async () => {
    const service = createConversationTemplateService(
      async () =>
        ({
          templates: [
            {
              ...summary,
              available: true,
              currentVersionId: null
            }
          ]
        }) as never
    );

    await expect(service.listAvailable()).rejects.toThrow('CONVERSATION_TEMPLATE_RESPONSE_INVALID');
  });

  it('Template details read published versions without internal publication task records', async () => {
    const publishedVersion = {
      id: 'version-5',
      templateId: summary.id,
      version: 5,
      status: 'AVAILABLE',
      contentHash: 'a'.repeat(64),
      manifestHash: 'b'.repeat(64),
      mcpConfigHash: 'c'.repeat(64),
      fileCount: 9_495,
      totalBytes: 14_451,
      hostPolicyVersion: 1,
      publishedByUserId: 1,
      publishedAt: 3
    } as const;
    const service = createConversationTemplateService(
      async () =>
        ({
          template: { ...summary, draftRevision: 1, publishedVersion: 5 },
          draft: storedDraft,
          versions: [publishedVersion]
        }) as never
    );

    await expect(service.detail(summary.id)).resolves.toEqual({
      template: { ...summary, draftRevision: 1, publishedVersion: 5 },
      draft: storedDraft,
      versions: [publishedVersion]
    });

    const invalid = createConversationTemplateService(
      async () =>
        ({
          template: { ...summary, draftRevision: 1, publishedVersion: 5 },
          draft: storedDraft,
          versions: [publishedVersion],
          publishJobs: []
        }) as never
    );
    await expect(invalid.detail(summary.id)).rejects.toThrow(
      'CONVERSATION_TEMPLATE_RESPONSE_INVALID'
    );
  });

  it('Strictly reads effective MCP candidates from source Workspaces and converts MiB quotas', async () => {
    const requests: string[] = [];
    const service = createConversationTemplateService(async (path) => {
      requests.push(path);
      return {
        targetKind: 'WORKSPACE',
        installations: [
          {
            catalogEntryId: 'mcp-1',
            serverName: 'local-tools',
            displayName: 'Local tools',
            version: '1.0.0',
            origin: 'WORKSPACE',
            enabled: true,
            status: 'CURRENT',
            installedAt: 1
          },
          {
            catalogEntryId: 'mcp-disabled',
            serverName: 'disabled-tools',
            displayName: 'Disabled tools',
            version: '1.0.0',
            origin: 'NODE',
            enabled: false,
            status: 'CURRENT',
            installedAt: 1
          }
        ]
      } as never;
    });

    await expect(service.listMcpOptions('node-1', 'workspace-1')).resolves.toEqual([
      expect.objectContaining({ catalogEntryId: 'mcp-1', displayName: 'Local tools' })
    ]);
    expect(requests).toEqual(['/api/workspaces/workspace-1/mcps?nodeId=node-1']);
    expect(conversationTemplateBytesToMiB(512 * 1024 * 1024)).toBe(512);
    expect(conversationTemplateMiBToBytes(128)).toBe(128 * 1024 * 1024);
    const invalid = createConversationTemplateService(
      async () =>
        ({
          targetKind: 'WORKSPACE',
          installations: [],
          leakedPath: '/srv/private'
        }) as never
    );
    await expect(invalid.listMcpOptions('node-1', 'workspace-1')).rejects.toThrow(
      'CONVERSATION_TEMPLATE_RESPONSE_INVALID'
    );
  });

  it('Strictly reads source Node model candidates and falls back within currently visible options', async () => {
    const requests: string[] = [];
    const service = createConversationTemplateService(async (path) => {
      requests.push(path);
      return {
        models: [
          { modelId: 'coding', name: 'Current Coding' },
          { modelId: 'review', name: 'Current Review' }
        ]
      } as never;
    });

    const options = await service.listModelOptions('node-1');
    expect(options).toEqual([
      { modelId: 'coding', name: 'Current Coding' },
      { modelId: 'review', name: 'Current Review' }
    ]);
    expect(requests).toEqual(['/api/admin/conversation-templates/model-options?nodeId=node-1']);
    expect(
      reconcileConversationTemplateModelSelection(
        ['missing', 'review', 'coding'],
        'missing',
        options
      )
    ).toEqual({
      allowedModels: ['review', 'coding'],
      defaultModelId: 'review'
    });
    expect(reconcileConversationTemplateModelSelection(['missing'], 'missing', options)).toEqual({
      allowedModels: [],
      defaultModelId: ''
    });
    expect(conversationTemplateModelReferences(['coding'], options)).toEqual([
      { modelId: 'coding', name: 'Current Coding' }
    ]);
    expect(
      conversationTemplateModelSelectionIsAvailable(['review', 'coding'], 'review', options)
    ).toBe(true);
    expect(
      conversationTemplateModelSelectionIsAvailable(['missing', 'coding'], 'coding', options)
    ).toBe(false);
    expect(conversationTemplateModelSelectionIsAvailable(['coding'], 'missing', options)).toBe(
      false
    );

    const invalid = createConversationTemplateService(
      async () =>
        ({
          models: [
            { modelId: 'coding', name: 'Coding' },
            { modelId: 'coding', name: 'Duplicate' }
          ]
        }) as never
    );
    await expect(invalid.listModelOptions('node-1')).rejects.toThrow(
      'CONVERSATION_TEMPLATE_RESPONSE_INVALID'
    );
  });

  it('Template authorization reuses TEMPLATE resource-grant routes', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const service = createConversationTemplateService(async (path, init) => {
      recordRequest(requests, path, init);
      if (init?.method === 'POST') return { id: 'grant-2' } as never;
      return {
        grants: [
          {
            id: 'grant-1',
            resourceType: 'TEMPLATE',
            templateId: summary.id,
            targetType: 'ORGANIZATION',
            targetOrganizationId: 1,
            grantScopeOrganizationId: 1,
            createdByUserId: 1,
            createdAt: 1
          }
        ]
      } as never;
    });

    await expect(service.listGrants(summary.id)).resolves.toHaveLength(1);
    await expect(
      service.createGrant(summary.id, {
        targetType: 'ORGANIZATION',
        targetOrganizationId: 1
      })
    ).resolves.toBe('grant-2');
    await service.removeGrant('grant-1');

    expect(requests).toEqual([
      {
        path: '/api/resource-grants?resourceType=TEMPLATE&templateId=template-1'
      },
      {
        path: '/api/resource-grants',
        init: {
          method: 'POST',
          body: JSON.stringify({
            resourceType: 'TEMPLATE',
            templateId: summary.id,
            targetType: 'ORGANIZATION',
            targetOrganizationId: 1
          })
        }
      },
      {
        path: '/api/resource-grants/grant-1',
        init: { method: 'DELETE' }
      }
    ]);
  });
});

it.each([
  [{ sequence: 3, resourceId: 'template-1' }, true],
  [{ sequence: 4, resourceId: 'template-1' }, false],
  [{ sequence: 3, resourceId: 'template-2' }, false]
] as const)(
  'matches response context %j only when sequence and resource agree',
  (context, expected) => {
    expect(
      sameConversationTemplateRequestContext(context, { sequence: 3, resourceId: 'template-1' })
    ).toBe(expected);
  }
);

function recordRequest(
  requests: Array<{ path: string; init?: RequestInit }>,
  path: string,
  init?: RequestInit
): void {
  requests.push(init === undefined ? { path } : { path, init });
}
