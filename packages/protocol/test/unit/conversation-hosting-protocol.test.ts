import { describe, expect, it } from 'vitest';
import {
  conversationFileProjectionSchema,
  conversationHostingCleanupExecuteInputSchema,
  conversationHostingDisableInputSchema,
  conversationHostingEnableInputSchema,
  conversationHostingEnableResultSchema,
  conversationHostingCleanupPreviewInputSchema,
  conversationHostingCleanupPreviewSchema,
  conversationHostingCleanupResultSchema,
  conversationHostingCapabilitySchema,
  conversationHostingStorageCapacitySchema,
  conversationTemplateDraftSchema,
  conversationTemplateNetworkModeSchema,
  conversationTemplatePublishInputSchema,
  conversationTemplatePublishJobSchema,
  conversationTemplateSourceInspectionSchema,
  conversationTemplateSummarySchema,
  conversationTemplateVersionSchema,
  hostedConversationConfigUpdateInputSchema,
  hostedConversationCreateInputSchema,
  hostedConversationDeleteResultSchema,
  hostedConversationDirectoryPageSchema,
  hostedConversationFileDeleteInputSchema,
  hostedConversationFileDeleteResultSchema,
  hostedConversationFileReadInputSchema,
  hostedConversationFileReadResultSchema,
  hostedConversationFilesSchema,
  hostedConversationHistoryInputSchema,
  hostedConversationHistoryPageSchema,
  hostedConversationIdInputSchema,
  hostedConversationListInputSchema,
  hostedConversationListPageSchema,
  hostedConversationManifestSchema,
  hostedConversationMessageInputSchema,
  hostedConversationMetadataUpdateInputSchema,
  hostedConversationRollbackInputSchema,
  hostedConversationActivityMessageSchema,
  hostedConversationActivityProjectionSchema,
  hostedConversationActivitySchema,
  hostedConversationSnapshotSchema,
  hostedConversationSummarySchema,
  hostedConversationUnwatchInputSchema,
  hostedConversationUploadChunkInputSchema,
  hostedConversationUploadControlInputSchema,
  hostedConversationUploadCreateInputSchema,
  hostedConversationUploadPreflightInputSchema,
  hostedConversationUploadPreflightResultSchema,
  hostedConversationUploadSchema,
  hostedConversationWatchInputSchema,
  nodeCapabilitiesSchema,
  nodeErrorSchema,
  watchEventSchema,
  workbenchNodeOperationSchema
} from '../../src/index.js';
import { resourceGrantSchema } from '../../src/enterprise.js';

const model = {
  id: 'model-1',
  name: 'Model 1',
  protocol: 'OPENAI_RESPONSES',
  baseUrl: 'https://models.example.test',
  modelId: 'model-1',
  contextWindowTokens: 200_000,
  maxOutputTokens: 16_384,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: ['low', 'high'],
  hostedWebSearch: false,
  enabled: true,
  sortOrder: 0,
  apiKeyConfigured: true
} as const;

const templateSummary = {
  id: 'template-1',
  nodeId: 'node-1',
  name: 'Research',
  description: 'Research with a fixed corpus.',
  icon: 'search',
  status: 'ACTIVE',
  currentVersionId: 'version-2',
  available: true,
  createdAt: 1,
  updatedAt: 2
} as const;

const conversationSummary = {
  id: 'conversation-1',
  nodeId: 'node-1',
  sessionId: 'session-1',
  templateId: 'template-1',
  templateName: 'Research',
  activeVersionId: 'version-2',
  title: 'Quarterly research',
  pinnedAt: null,
  status: 'ACTIVE',
  modelId: 'model-1',
  createdAt: 1,
  updatedAt: 2,
  lastActivityAt: 2
} as const;

describe('conversation hosting protocol', () => {
  it('models hosted directory activity independently from Watch and recent tasks', () => {
    expect(hostedConversationSummarySchema.parse(conversationSummary).activity).toEqual({
      status: 'IDLE',
      version: 0,
      updatedAt: 0
    });
    expect(
      hostedConversationActivitySchema.parse({
        status: 'RUNNING',
        version: 2,
        updatedAt: 3
      })
    ).toEqual({ status: 'RUNNING', version: 2, updatedAt: 3 });
    expect(
      hostedConversationActivityProjectionSchema.parse({
        userId: 7,
        templateId: 'template-1',
        conversationId: 'conversation-1',
        activity: {
          status: 'CANCELLING',
          version: 3,
          updatedAt: 4
        }
      })
    ).toMatchObject({ conversationId: 'conversation-1' });
    expect(
      hostedConversationActivityMessageSchema.parse({
        type: 'hosted-conversation.activity',
        nodeId: 'node-1',
        conversationId: 'conversation-1',
        activity: {
          status: 'IDLE',
          version: 4,
          updatedAt: 5
        }
      })
    ).toMatchObject({ nodeId: 'node-1' });
    expect(
      hostedConversationActivitySchema.safeParse({
        status: 'SUCCEEDED',
        version: 2,
        updatedAt: 3
      }).success
    ).toBe(false);
  });

  it('expresses Linux Bubblewrap hosting without introducing a Node type', () => {
    expect(
      conversationHostingCapabilitySchema.parse({
        state: 'AVAILABLE',
        apiVersion: 1,
        sandboxBackend: 'BUBBLEWRAP',
        sandboxPolicyVersion: 1,
        acceptsNewConversations: true,
        supportsExistingConversations: true,
        capacity: 'AVAILABLE'
      })
    ).toMatchObject({ sandboxBackend: 'BUBBLEWRAP' });
    expect(
      nodeCapabilitiesSchema.safeParse({
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: 'v24.0.0',
        codex: { available: false },
        claudeCode: { available: false },
        marAgent: { available: true, version: '0.9.26' },
        conversationHosting: {
          state: 'AVAILABLE',
          apiVersion: 1,
          sandboxBackend: 'BUBBLEWRAP',
          sandboxPolicyVersion: 1,
          acceptsNewConversations: true,
          supportsExistingConversations: true,
          capacity: 'AVAILABLE'
        }
      }).success
    ).toBe(true);
    expect(
      nodeCapabilitiesSchema.safeParse({
        platform: 'windows',
        architecture: 'x64',
        nodeVersion: 'v24.0.0',
        codex: { available: false },
        claudeCode: { available: false },
        marAgent: { available: true, version: '0.9.26' },
        conversationHosting: {
          state: 'AVAILABLE',
          apiVersion: 1,
          sandboxBackend: 'BUBBLEWRAP',
          sandboxPolicyVersion: 1,
          acceptsNewConversations: true,
          supportsExistingConversations: true,
          capacity: 'AVAILABLE'
        }
      }).success
    ).toBe(false);
    expect(
      nodeCapabilitiesSchema.safeParse({
        platform: 'macos',
        architecture: 'arm64',
        nodeVersion: 'v24.0.0',
        codex: { available: false },
        claudeCode: { available: false },
        marAgent: { available: true, version: '0.9.26' },
        conversationHosting: {
          state: 'AVAILABLE',
          apiVersion: 1,
          sandboxBackend: 'BUBBLEWRAP',
          sandboxPolicyVersion: 1,
          acceptsNewConversations: true,
          supportsExistingConversations: true,
          capacity: 'AVAILABLE'
        }
      }).success
    ).toBe(false);
    expect(
      conversationHostingCapabilitySchema.safeParse({
        state: 'AVAILABLE',
        apiVersion: 1,
        sandboxBackend: 'BUBBLEWRAP',
        sandboxPolicyVersion: 1,
        acceptsNewConversations: false,
        supportsExistingConversations: true,
        capacity: 'FULL'
      }).success
    ).toBe(true);
    expect(
      conversationHostingCapabilitySchema.safeParse({
        state: 'AVAILABLE',
        apiVersion: 1,
        sandboxBackend: 'BUBBLEWRAP',
        sandboxPolicyVersion: 1,
        acceptsNewConversations: false,
        supportsExistingConversations: true,
        capacity: 'HIGH'
      }).success
    ).toBe(false);
    expect(
      conversationHostingCapabilitySchema.safeParse({
        state: 'DISABLED',
        apiVersion: 1,
        sandboxBackend: 'BUBBLEWRAP',
        acceptsNewConversations: false,
        supportsExistingConversations: false,
        capacity: 'AVAILABLE'
      }).success
    ).toBe(false);
  });

  it('defines strict aggregate capacity and inactive cleanup contracts', () => {
    expect(conversationHostingEnableInputSchema.parse({ enabled: true })).toEqual({
      enabled: true
    });
    expect(conversationHostingEnableInputSchema.safeParse({ enabled: false }).success).toBe(false);
    expect(
      conversationHostingEnableInputSchema.safeParse({ enabled: true, storeDirectory: 'custom' })
        .success
    ).toBe(false);
    expect(conversationHostingDisableInputSchema.parse({})).toEqual({});
    expect(conversationHostingDisableInputSchema.safeParse({ enabled: false }).success).toBe(false);
    expect(
      conversationHostingEnableResultSchema.parse({
        capability: {
          state: 'AVAILABLE',
          apiVersion: 1,
          sandboxBackend: 'BUBBLEWRAP',
          sandboxPolicyVersion: 1,
          acceptsNewConversations: true,
          supportsExistingConversations: true,
          capacity: 'AVAILABLE'
        }
      })
    ).toMatchObject({ capability: { state: 'AVAILABLE' } });
    expect(
      conversationHostingStorageCapacitySchema.parse({
        hostedStorageUsedBytes: 4_096,
        filesystemTotalBytes: 100_000,
        filesystemAvailableBytes: 5_000,
        filesystemUsageBasisPoints: 9_500,
        capacity: 'FULL',
        acceptsNewConversations: false,
        automaticCleanupInactiveDays: 60,
        measuredAt: 1_000
      })
    ).toMatchObject({ capacity: 'FULL', automaticCleanupInactiveDays: 60 });
    expect(
      conversationHostingStorageCapacitySchema.safeParse({
        hostedStorageUsedBytes: 4_096,
        filesystemTotalBytes: 100_000,
        filesystemAvailableBytes: 5_000,
        filesystemUsageBasisPoints: 9_500,
        capacity: 'AVAILABLE',
        acceptsNewConversations: true,
        automaticCleanupInactiveDays: 60,
        measuredAt: 1_000
      }).success
    ).toBe(false);
    expect(
      conversationHostingStorageCapacitySchema.safeParse({
        hostedStorageUsedBytes: 4_096,
        filesystemTotalBytes: 100_000,
        filesystemAvailableBytes: 5_000,
        filesystemUsageBasisPoints: 9_000,
        capacity: 'HIGH',
        acceptsNewConversations: true,
        automaticCleanupInactiveDays: 60,
        measuredAt: 1_000
      }).success
    ).toBe(false);
    expect(
      conversationHostingStorageCapacitySchema.safeParse({
        hostedStorageUsedBytes: Number.MAX_SAFE_INTEGER + 1,
        filesystemTotalBytes: 100_000,
        filesystemAvailableBytes: 5_000,
        filesystemUsageBasisPoints: 9_500,
        capacity: 'FULL',
        acceptsNewConversations: false,
        automaticCleanupInactiveDays: 60,
        measuredAt: 1_000
      }).success
    ).toBe(false);
    expect(conversationHostingCleanupPreviewInputSchema.parse({ inactiveDays: 60 })).toEqual({
      inactiveDays: 60
    });
    expect(
      conversationHostingCleanupPreviewInputSchema.safeParse({ inactiveDays: 0 }).success
    ).toBe(false);
    expect(
      conversationHostingCleanupExecuteInputSchema.safeParse({
        inactiveDays: 366,
        conversationIds: ['conversation-1']
      }).success
    ).toBe(false);
    expect(
      conversationHostingCleanupPreviewSchema.parse({
        inactiveDays: 60,
        cutoffAt: 1_000,
        candidateConversationCount: 2,
        reclaimableBytes: 8_192,
        measuredAt: 2_000
      })
    ).toMatchObject({ candidateConversationCount: 2, reclaimableBytes: 8_192 });
    expect(
      conversationHostingCleanupPreviewSchema.safeParse({
        inactiveDays: 60,
        cutoffAt: 1_000,
        candidateConversationCount: 2,
        reclaimableBytes: Number.MAX_SAFE_INTEGER + 1,
        measuredAt: 2_000
      }).success
    ).toBe(false);
    expect(
      conversationHostingCleanupResultSchema.parse({
        inactiveDays: 60,
        cutoffAt: 1_000,
        deletedConversationCount: 1,
        releasedBytes: 4_096,
        skippedConversationCount: 1,
        completedAt: 2_000
      })
    ).toMatchObject({ deletedConversationCount: 1, skippedConversationCount: 1 });
    expect(
      conversationHostingCleanupResultSchema.safeParse({
        inactiveDays: 60,
        cutoffAt: 1_000,
        deletedConversationCount: 1,
        releasedBytes: Number.MAX_SAFE_INTEGER + 1,
        skippedConversationCount: 1,
        completedAt: 2_000
      }).success
    ).toBe(false);
    expect(workbenchNodeOperationSchema.parse('conversation.hosting.storage.inspect')).toBe(
      'conversation.hosting.storage.inspect'
    );
    expect(workbenchNodeOperationSchema.parse('conversation.hosting.enable')).toBe(
      'conversation.hosting.enable'
    );
    expect(workbenchNodeOperationSchema.parse('conversation.hosting.disable')).toBe(
      'conversation.hosting.disable'
    );
    expect(workbenchNodeOperationSchema.parse('conversation.hosting.cleanup.preview')).toBe(
      'conversation.hosting.cleanup.preview'
    );
    expect(workbenchNodeOperationSchema.parse('conversation.hosting.cleanup.execute')).toBe(
      'conversation.hosting.cleanup.execute'
    );
    expect(nodeErrorSchema.parse({ code: 'CONVERSATION_HOSTING_STORAGE_FULL' })).toEqual({
      code: 'CONVERSATION_HOSTING_STORAGE_FULL'
    });
  });

  it('keeps hosted template network modes closed to NONE and UNRESTRICTED', () => {
    expect(conversationTemplateNetworkModeSchema.options).toEqual(['NONE', 'UNRESTRICTED']);
    expect(conversationTemplateNetworkModeSchema.safeParse('HOSTED_ONLY').success).toBe(false);
  });

  it('keeps the minimal draft, MCP options, immutable version and publish inputs strict', () => {
    expect(
      conversationTemplateDraftSchema.parse({
        templateId: 'template-1',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        revision: 3,
        name: 'Research',
        description: 'Research with a fixed corpus.',
        icon: 'search',
        allowedModels: [
          { modelId: 'coding', name: 'Coding' },
          { modelId: 'review', name: 'Review' }
        ],
        defaultModelId: 'coding',
        mcpIds: ['mcp-local', 'mcp-remote'],
        networkMode: 'UNRESTRICTED',
        quotas: {
          maxStorageBytes: 100_000_000,
          maxUploadBytes: 10_000_000
        },
        updatedAt: 3
      })
    ).toMatchObject({ revision: 3, networkMode: 'UNRESTRICTED' });
    expect(
      conversationTemplateDraftSchema.safeParse({
        templateId: 'template-1',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        revision: 3,
        name: 'Research',
        description: '',
        includePaths: ['knowledge'],
        allowedModels: [{ modelId: 'coding', name: 'Coding' }],
        defaultModelId: 'coding',
        mcpIds: [],
        networkMode: 'NONE',
        quotas: {
          maxStorageBytes: 1,
          maxUploadBytes: 1
        },
        updatedAt: 3
      }).success
    ).toBe(false);
    expect(
      conversationTemplateDraftSchema.safeParse({
        templateId: 'template-1',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        revision: 3,
        name: 'Research',
        description: '',
        allowedModels: [{ modelId: 'coding', name: 'Coding' }],
        defaultModelId: 'coding',
        mcpIds: ['mcp-local', 'mcp-local'],
        networkMode: 'NONE',
        quotas: {
          maxStorageBytes: 1,
          maxUploadBytes: 2
        },
        updatedAt: 3
      }).success
    ).toBe(false);
    expect(
      conversationTemplateDraftSchema.safeParse({
        templateId: 'template-1',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        revision: 3,
        name: 'Research',
        description: '',
        allowedModels: [
          { modelId: 'coding', name: 'Coding A' },
          { modelId: 'coding', name: 'Coding B' }
        ],
        defaultModelId: 'coding',
        mcpIds: [],
        networkMode: 'NONE',
        quotas: {
          maxStorageBytes: 2,
          maxUploadBytes: 1
        },
        updatedAt: 3
      }).success
    ).toBe(false);
    expect(
      conversationTemplateDraftSchema.safeParse({
        templateId: 'template-1',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        revision: 3,
        name: 'Research',
        description: '',
        allowedModels: [{ modelId: 'coding', name: 'Coding' }],
        defaultModelId: 'review',
        mcpIds: [],
        networkMode: 'NONE',
        quotas: {
          maxStorageBytes: 2,
          maxUploadBytes: 1
        },
        updatedAt: 3
      }).success
    ).toBe(false);
    expect(
      conversationTemplateDraftSchema.safeParse({
        templateId: 'template-1',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        revision: 3,
        name: 'Research',
        description: '',
        allowedModelIds: ['model-1'],
        defaultModelId: 'model-1',
        mcpIds: [],
        networkMode: 'NONE',
        quotas: {
          maxStorageBytes: 2,
          maxUploadBytes: 1
        },
        updatedAt: 3
      }).success
    ).toBe(false);
    expect(
      conversationTemplateSourceInspectionSchema.parse({
        valid: true,
        code: null,
        message: 'The draft source is valid.',
        checkedAt: 3,
        mcpServers: [
          {
            id: 'mcp-local',
            serverName: 'local-tools',
            displayName: 'Local tools',
            transport: 'STDIO',
            origin: 'WORKSPACE'
          },
          {
            id: 'mcp-remote',
            serverName: 'remote-docs',
            displayName: 'Remote docs',
            transport: 'HTTP',
            origin: 'NODE'
          }
        ]
      })
    ).toMatchObject({ mcpServers: [{ id: 'mcp-local' }, { id: 'mcp-remote' }] });
    expect(
      conversationTemplateVersionSchema.parse({
        id: 'version-2',
        templateId: 'template-1',
        version: 2,
        status: 'AVAILABLE',
        contentHash: 'a'.repeat(64),
        manifestHash: 'b'.repeat(64),
        mcpConfigHash: 'c'.repeat(64),
        fileCount: 12,
        totalBytes: 4096,
        hostPolicyVersion: 1,
        publishedByUserId: 1,
        publishedAt: 5
      })
    ).toMatchObject({ version: 2, status: 'AVAILABLE' });
    expect(
      conversationTemplatePublishInputSchema.safeParse({
        templateId: 'template-1',
        draftRevision: 3,
        requestId: 'request-1',
        sourcePath: '/host/path'
      }).success
    ).toBe(false);
    expect(
      conversationTemplatePublishJobSchema.parse({
        id: 'job-1',
        templateId: 'template-1',
        draftRevision: 3,
        stage: 'REGISTERED',
        status: 'SUCCEEDED',
        versionId: 'version-2',
        errorCode: null,
        createdAt: 4,
        updatedAt: 5
      })
    ).toMatchObject({ status: 'SUCCEEDED' });
    expect(
      conversationTemplatePublishJobSchema.safeParse({
        id: 'job-1',
        templateId: 'template-1',
        draftRevision: 3,
        stage: 'SEALED',
        status: 'SUCCEEDED',
        versionId: 'version-2',
        errorCode: null,
        createdAt: 4,
        updatedAt: 5
      }).success
    ).toBe(false);
    expect(
      conversationTemplatePublishJobSchema.safeParse({
        id: 'job-1',
        templateId: 'template-1',
        draftRevision: 3,
        stage: 'VALIDATING',
        status: 'RUNNING',
        errorCode: 'TEMPLATE_PUBLISH_FAILED',
        createdAt: 4,
        updatedAt: 5
      }).success
    ).toBe(false);
  });

  it('keeps template grants independent from Node, Workspace and model grants', () => {
    expect(
      resourceGrantSchema.parse({
        id: 'grant-template',
        resourceType: 'TEMPLATE',
        templateId: 'template-1',
        targetType: 'ORGANIZATION',
        targetOrganizationId: 2,
        grantScopeOrganizationId: 1,
        createdByUserId: 1,
        createdAt: 2
      })
    ).toMatchObject({ resourceType: 'TEMPLATE', templateId: 'template-1' });
    expect(
      resourceGrantSchema.safeParse({
        id: 'grant-template-invalid',
        resourceType: 'TEMPLATE',
        templateId: 'template-1',
        nodeId: 'node-1',
        targetType: 'ORGANIZATION',
        targetOrganizationId: 2,
        grantScopeOrganizationId: 1,
        createdByUserId: 1,
        createdAt: 2
      }).success
    ).toBe(false);
  });

  it('models hosted manifests and related files without physical paths', () => {
    expect(conversationTemplateSummarySchema.parse(templateSummary)).toMatchObject({
      currentVersionId: 'version-2'
    });
    expect(
      conversationTemplateSummarySchema.safeParse({
        ...templateSummary,
        status: 'ARCHIVED'
      }).success
    ).toBe(false);
    expect(
      conversationTemplateSummarySchema.safeParse({
        ...templateSummary,
        currentVersionId: null
      }).success
    ).toBe(false);
    expect(hostedConversationSummarySchema.parse(conversationSummary)).toMatchObject({
      sessionId: 'session-1'
    });
    expect(
      hostedConversationSummarySchema.safeParse({
        ...conversationSummary,
        pendingVersionId: null
      }).success
    ).toBe(false);
    for (const status of ['UPGRADE_PENDING', 'UPGRADE_FAILED', 'RECOVERABLE_DELETED', 'DELETING'])
      expect(
        hostedConversationSummarySchema.safeParse({
          ...conversationSummary,
          status
        }).success
      ).toBe(false);
    expect(
      hostedConversationManifestSchema.parse({
        ...conversationSummary,
        userStorageKey: 'user_XY12abc',
        conversationStorageKey: 'conversation_ZZ34def',
        titleSource: 'DEFAULT',
        templateDeleted: false,
        quota: {
          usedBytes: 1024,
          maxBytes: 100_000_000
        }
      })
    ).toMatchObject({ userStorageKey: 'user_XY12abc', titleSource: 'DEFAULT' });
    expect(
      hostedConversationSummarySchema.parse({
        ...conversationSummary,
        titleSource: 'DEFAULT'
      })
    ).toMatchObject({ title: conversationSummary.title, titleSource: 'DEFAULT' });
    expect(
      hostedConversationManifestSchema.safeParse({
        ...conversationSummary,
        status: 'UPGRADE_PENDING',
        pendingVersionId: 'version-3',
        userStorageKey: 'user_XY12abc',
        conversationStorageKey: 'conversation_ZZ34def',
        titleSource: 'AUTO',
        templateDeleted: true,
        quota: {
          usedBytes: 1024,
          maxBytes: 100_000_000
        }
      }).success
    ).toBe(false);
    expect(
      hostedConversationManifestSchema.safeParse({
        ...conversationSummary,
        userStorageKey: 'user_XY12abc',
        conversationStorageKey: 'conversation_ZZ34def',
        titleSource: 'AUTO',
        templateDeleted: false,
        recoverableUntil: 30,
        quota: {
          usedBytes: 1024,
          maxBytes: 100_000_000
        }
      }).success
    ).toBe(false);
    expect(
      conversationFileProjectionSchema.parse({
        id: 'file-1',
        conversationId: 'conversation-1',
        category: 'OUTPUT',
        relativePath: 'reports/final.pdf',
        displayName: 'final.pdf',
        mimeType: 'application/pdf',
        size: 2048,
        source: 'AGENT',
        turnId: 'turn-1',
        itemId: 'item-1',
        createdAt: 2,
        updatedAt: 3
      })
    ).toMatchObject({ relativePath: 'reports/final.pdf' });
    expect(
      conversationFileProjectionSchema.safeParse({
        id: 'file-1',
        conversationId: 'conversation-1',
        category: 'OUTPUT',
        relativePath: '/srv/private/final.pdf',
        displayName: 'final.pdf',
        mimeType: 'application/pdf',
        size: 2048,
        source: 'AGENT',
        createdAt: 2,
        updatedAt: 3
      }).success
    ).toBe(false);
    expect(
      conversationFileProjectionSchema.safeParse({
        id: 'file-2',
        conversationId: 'conversation-1',
        category: 'WORK',
        relativePath: 'scratch.txt',
        displayName: 'scratch.txt',
        mimeType: 'text/plain',
        size: 1,
        source: 'AGENT',
        createdAt: 2,
        updatedAt: 3
      }).success
    ).toBe(false);
    expect(
      hostedConversationSnapshotSchema.parse({
        nodeAppVersion: '0.9.55',
        conversation: conversationSummary,
        template: templateSummary,
        run: null,
        turns: [],
        historyNextCursor: null,
        files: [],
        models: [model],
        error: null,
        snapshotSequence: 3
      })
    ).toMatchObject({ nodeAppVersion: '0.9.55', snapshotSequence: 3 });
    expect(
      hostedConversationSnapshotSchema.safeParse({
        conversation: conversationSummary,
        template: templateSummary,
        run: null,
        turns: [],
        historyNextCursor: null,
        files: [],
        models: [model, model],
        error: null,
        snapshotSequence: 3
      }).success
    ).toBe(false);
  });

  it('accepts only fixed hosted inputs, operations and the shared Session Watch slot', () => {
    const createInput = {
      templateId: 'template-1',
      clientRequestId: 'client-request-1'
    };
    expect(hostedConversationCreateInputSchema.parse(createInput)).toEqual(createInput);
    expect(
      hostedConversationHistoryInputSchema.parse({
        conversationId: 'conversation-1',
        cursor: 'opaque-history-cursor'
      })
    ).toEqual({
      conversationId: 'conversation-1',
      limit: 10,
      cursor: 'opaque-history-cursor'
    });
    expect(
      hostedConversationHistoryPageSchema.parse({
        turns: [],
        nextCursor: null
      })
    ).toEqual({ turns: [], nextCursor: null });
    expect(
      hostedConversationMessageInputSchema.parse({
        conversationId: 'conversation-1',
        clientMessageId: 'replacement-message-1',
        prompt: 'Replace the active Run.',
        attachmentIds: [],
        deliveryIntent: 'REPLACE_CURRENT'
      })
    ).toMatchObject({ deliveryIntent: 'REPLACE_CURRENT' });
    expect(
      hostedConversationMessageInputSchema.safeParse({
        conversationId: 'conversation-1',
        clientMessageId: 'queued-message-1',
        prompt: 'Queue this message.',
        attachmentIds: [],
        deliveryIntent: 'QUEUE'
      }).success
    ).toBe(false);
    expect(
      hostedConversationCreateInputSchema.safeParse({
        ...createInput,
        title: 'New conversation'
      }).success
    ).toBe(false);
    expect(
      hostedConversationMessageInputSchema.safeParse({
        conversationId: 'conversation-1',
        clientMessageId: 'message-1',
        prompt: 'Create the report.',
        attachmentIds: ['attachment-1'],
        modelId: 'model-1',
        reasoningEffort: 'high',
        runner: 'codex',
        access: 'on-request',
        skillFilePath: '/tmp/skill.md'
      }).success
    ).toBe(false);
    expect(
      hostedConversationConfigUpdateInputSchema.parse({
        conversationId: 'conversation-1',
        modelId: 'model-1'
      })
    ).toMatchObject({ modelId: 'model-1' });
    expect(
      hostedConversationConfigUpdateInputSchema.safeParse({
        conversationId: 'conversation-1',
        reasoningEffort: 'low'
      }).success
    ).toBe(false);
    expect(
      hostedConversationRollbackInputSchema.parse({
        conversationId: 'conversation-1',
        turnId: 'turn-2',
        boundary: 'turn-1'
      })
    ).toEqual({
      conversationId: 'conversation-1',
      turnId: 'turn-2',
      boundary: 'turn-1'
    });
    expect(
      hostedConversationRollbackInputSchema.safeParse({
        conversationId: 'conversation-1',
        turnId: 'turn-2',
        boundary: 'turn-1',
        sessionId: 'session-1'
      }).success
    ).toBe(false);
    expect(
      hostedConversationMetadataUpdateInputSchema.parse({
        conversationId: 'conversation-1',
        title: '  Renamed conversation  ',
        pinned: true
      })
    ).toEqual({
      conversationId: 'conversation-1',
      title: 'Renamed conversation',
      pinned: true
    });
    expect(
      hostedConversationMetadataUpdateInputSchema.safeParse({
        conversationId: 'conversation-1'
      }).success
    ).toBe(false);
    expect(
      hostedConversationMetadataUpdateInputSchema.safeParse({
        conversationId: 'conversation-1',
        title: '   '
      }).success
    ).toBe(false);
    expect(
      hostedConversationWatchInputSchema.parse({
        conversationId: 'conversation-1',
        mode: 'initial',
        workbenchConnectionId: 'connection-1',
        watchId: 'watch-id-1'
      })
    ).toMatchObject({ mode: 'initial' });
    expect(workbenchNodeOperationSchema.parse('conversation.hosted.create')).toBe(
      'conversation.hosted.create'
    );
    expect(workbenchNodeOperationSchema.parse('conversation.hosted.history')).toBe(
      'conversation.hosted.history'
    );
    expect(workbenchNodeOperationSchema.parse('conversation.hosted.metadata.update')).toBe(
      'conversation.hosted.metadata.update'
    );
    expect(workbenchNodeOperationSchema.parse('conversation.hosted.rollback')).toBe(
      'conversation.hosted.rollback'
    );
    expect(workbenchNodeOperationSchema.parse('conversation.hosted.file.delete')).toBe(
      'conversation.hosted.file.delete'
    );
    expect(workbenchNodeOperationSchema.safeParse('conversation.hosted.restore').success).toBe(
      false
    );
    expect(
      hostedConversationDeleteResultSchema.parse({
        deletedConversationId: 'conversation-1'
      })
    ).toEqual({ deletedConversationId: 'conversation-1' });
    expect(
      hostedConversationDeleteResultSchema.safeParse({
        deletedConversationId: 'conversation-1',
        recoverableUntil: 30
      }).success
    ).toBe(false);
    expect(workbenchNodeOperationSchema.parse('conversation.template.publish')).toBe(
      'conversation.template.publish'
    );
    expect(
      watchEventSchema.safeParse({
        type: 'watch.hosted-conversation.snapshot',
        workbenchConnectionId: 'connection-1',
        watchId: 'watch-id-1',
        nodeGeneration: 'generation-1',
        nodeId: 'node-1',
        templateId: 'template-1',
        conversationId: 'conversation-1',
        revision: 1,
        snapshotSequence: 3,
        expiresAt: 10,
        payload: {}
      }).success
    ).toBe(true);
    expect(
      watchEventSchema.safeParse({
        type: 'watch.hosted-conversation.event',
        workbenchConnectionId: 'connection-1',
        watchId: 'watch-id-1',
        nodeGeneration: 'generation-1',
        nodeId: 'node-1',
        templateId: 'template-1',
        conversationId: 'conversation-1',
        expiresAt: 10,
        event: {
          sequence: 1,
          category: 'hosted-conversation',
          payload: { conversationId: 'conversation-1', kind: 'run' }
        }
      }).success
    ).toBe(true);
    expect(
      watchEventSchema.safeParse({
        type: 'watch.hosted-conversation.snapshot',
        workbenchConnectionId: 'connection-1',
        watchId: 'watch-id-1',
        nodeGeneration: 'generation-1',
        nodeId: 'node-1',
        conversationId: 'conversation-1',
        revision: 1,
        snapshotSequence: 3,
        expiresAt: 10,
        payload: {}
      }).success
    ).toBe(false);
    expect(
      watchEventSchema.safeParse({
        type: 'watch.failed',
        workbenchConnectionId: 'connection-1',
        watchId: 'watch-id-1',
        nodeGeneration: 'generation-1',
        nodeId: 'node-1',
        templateId: 'template-1',
        conversationId: 'conversation-1',
        watchType: 'hosted-conversation',
        code: 'SANDBOX_UNAVAILABLE',
        message: 'Sandbox is unavailable.'
      }).success
    ).toBe(true);
    expect(
      watchEventSchema.safeParse({
        type: 'watch.failed',
        workbenchConnectionId: 'connection-1',
        watchId: 'watch-id-1',
        nodeGeneration: 'generation-1',
        nodeId: 'node-1',
        templateId: 'template-1',
        workspaceId: 'workspace-1',
        conversationId: 'conversation-1',
        watchType: 'hosted-conversation',
        code: 'SANDBOX_UNAVAILABLE',
        message: 'Sandbox is unavailable.'
      }).success
    ).toBe(false);
  });

  it('defines closed list, file and chunked upload contracts without physical paths', () => {
    expect(hostedConversationListInputSchema.parse({ limit: 20, cursor: 'opaque_cursor' })).toEqual(
      {
        limit: 20,
        cursor: 'opaque_cursor'
      }
    );
    expect(hostedConversationListInputSchema.safeParse({ limit: 20, userId: 7 }).success).toBe(
      false
    );
    expect(hostedConversationIdInputSchema.parse({ conversationId: 'conversation-1' })).toEqual({
      conversationId: 'conversation-1'
    });
    expect(
      hostedConversationUnwatchInputSchema.parse({
        conversationId: 'conversation-1',
        workbenchConnectionId: 'connection_1234',
        watchId: 'watch_1234'
      })
    ).toMatchObject({ conversationId: 'conversation-1' });
    expect(
      hostedConversationFileReadInputSchema.safeParse({
        conversationId: 'conversation-1',
        fileId: 'file-1',
        path: '/host/output.txt'
      }).success
    ).toBe(false);
    expect(
      hostedConversationFileDeleteInputSchema.parse({
        conversationId: 'conversation-1',
        fileId: 'file-1'
      })
    ).toEqual({
      conversationId: 'conversation-1',
      fileId: 'file-1'
    });
    expect(
      hostedConversationFileDeleteInputSchema.safeParse({
        conversationId: 'conversation-1',
        fileId: 'file-1',
        relativePath: 'output.txt'
      }).success
    ).toBe(false);
    expect(
      hostedConversationUploadPreflightInputSchema.parse({
        conversationId: 'conversation-1',
        files: [
          { name: 'input.csv', size: 1024, mimeType: 'text/csv' },
          { name: 'input.csv', size: 1024, mimeType: 'text/csv' }
        ]
      })
    ).toMatchObject({
      files: [{ name: 'input.csv' }, { name: 'input.csv' }]
    });
    expect(
      hostedConversationUploadCreateInputSchema.safeParse({
        conversationId: 'conversation-1',
        clientRequestId: 'upload-request-1',
        name: 'input.csv',
        size: 1024,
        mimeType: 'text/csv',
        directory: '../outside'
      }).success
    ).toBe(false);
    expect(
      hostedConversationUploadChunkInputSchema.safeParse({
        conversationId: 'conversation-1',
        uploadId: 'upload-1',
        offset: 0,
        dataBase64: Buffer.alloc(512 * 1024 + 1).toString('base64')
      }).success
    ).toBe(false);
    expect(
      hostedConversationUploadControlInputSchema.parse({
        conversationId: 'conversation-1',
        uploadId: 'upload-1'
      })
    ).toMatchObject({ uploadId: 'upload-1' });

    expect(
      hostedConversationListPageSchema.parse({
        items: [conversationSummary],
        nextCursor: null
      })
    ).toMatchObject({ items: [{ id: 'conversation-1' }] });
    const aggregateItems = Array.from({ length: 101 }, (_, index) => ({
      ...conversationSummary,
      id: `conversation-${index}`,
      sessionId: `session-${index}`
    }));
    expect(
      hostedConversationListPageSchema.safeParse({
        items: aggregateItems,
        nextCursor: null
      }).success
    ).toBe(false);
    const aggregatePage = hostedConversationDirectoryPageSchema.parse({
      items: aggregateItems,
      nextCursor: 'server_cursor'
    });
    expect(aggregatePage.items).toHaveLength(101);
    expect(aggregatePage.items.at(-1)).toMatchObject({ id: 'conversation-100' });
    expect(
      hostedConversationDirectoryPageSchema.safeParse({
        items: [],
        nextCursor: null,
        failedNodeIds: ['node-1']
      }).success
    ).toBe(false);
    const file = {
      id: 'file-1',
      conversationId: 'conversation-1',
      category: 'UPLOAD',
      relativePath: 'input.csv',
      displayName: 'input.csv',
      mimeType: 'text/csv',
      size: 1024,
      source: 'USER',
      createdAt: 2,
      updatedAt: 2
    } as const;
    expect(hostedConversationFilesSchema.parse({ files: [file] })).toEqual({ files: [file] });
    expect(
      hostedConversationFileDeleteResultSchema.parse({
        deletedFileId: 'file-1',
        files: []
      })
    ).toEqual({
      deletedFileId: 'file-1',
      files: []
    });
    expect(
      hostedConversationFileReadResultSchema.parse({
        file,
        encoding: 'base64',
        content: Buffer.from('part').toString('base64'),
        offset: 0,
        nextOffset: 4,
        eof: false
      })
    ).toMatchObject({ file: { id: 'file-1' }, eof: false });
    expect(
      hostedConversationUploadPreflightResultSchema.parse({
        files: [{ name: 'input.csv', status: 'READY' }]
      })
    ).toEqual({ files: [{ name: 'input.csv', status: 'READY' }] });
    expect(
      hostedConversationUploadSchema.parse({
        uploadId: 'upload-1',
        conversationId: 'conversation-1',
        name: 'input.csv',
        mimeType: 'text/csv',
        receivedBytes: 512,
        size: 1024,
        status: 'UPLOADING'
      })
    ).toMatchObject({ status: 'UPLOADING' });
    expect(nodeErrorSchema.parse({ code: 'HOSTED_CONVERSATION_FILE_NOT_FOUND' })).toEqual({
      code: 'HOSTED_CONVERSATION_FILE_NOT_FOUND'
    });
    expect(nodeErrorSchema.parse({ code: 'HOSTED_CONVERSATION_FILE_CONFLICT' })).toEqual({
      code: 'HOSTED_CONVERSATION_FILE_CONFLICT'
    });
  });

  it('validates hosted file Base64 in browser runtimes without Node Buffer', () => {
    const file = {
      id: 'file-1',
      conversationId: 'conversation-1',
      category: 'OUTPUT',
      relativePath: 'result.txt',
      displayName: 'result.txt',
      mimeType: 'text/plain',
      size: 6,
      source: 'AGENT',
      createdAt: 2,
      updatedAt: 2
    } as const;
    const bufferDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Buffer');
    let fileReadAccepted = false;
    let emptyFileReadAccepted = false;
    let uploadChunkAccepted = false;
    try {
      Object.defineProperty(globalThis, 'Buffer', {
        configurable: true,
        writable: true,
        value: undefined
      });
      fileReadAccepted = hostedConversationFileReadResultSchema.safeParse({
        file,
        encoding: 'base64',
        content: 'cmVzdWx0',
        offset: 0,
        nextOffset: null,
        eof: true
      }).success;
      emptyFileReadAccepted = hostedConversationFileReadResultSchema.safeParse({
        file: { ...file, size: 0 },
        encoding: 'base64',
        content: '',
        offset: 0,
        nextOffset: null,
        eof: true
      }).success;
      uploadChunkAccepted = hostedConversationUploadChunkInputSchema.safeParse({
        conversationId: 'conversation-1',
        uploadId: 'upload-1',
        offset: 0,
        dataBase64: 'cGFydA=='
      }).success;
    } finally {
      if (bufferDescriptor === undefined) delete (globalThis as { Buffer?: unknown }).Buffer;
      else Object.defineProperty(globalThis, 'Buffer', bufferDescriptor);
    }

    expect(fileReadAccepted).toBe(true);
    expect(emptyFileReadAccepted).toBe(true);
    expect(uploadChunkAccepted).toBe(true);
    expect(
      hostedConversationFileReadResultSchema.safeParse({
        file: { ...file, size: 1 },
        encoding: 'base64',
        content: 'AB==',
        offset: 0,
        nextOffset: null,
        eof: true
      }).success
    ).toBe(false);
  });
});
