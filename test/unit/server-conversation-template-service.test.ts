import { describe, expect, it, vi } from 'vitest';
import {
  conversationTemplatePublishResultSchema,
  conversationTemplateSourceInspectionSchema,
  type ConversationTemplateDraft
} from '../../packages/protocol/src/index.js';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import type { ResourceAccessService } from '../../ee/server/src/rbac/resource-access-service.js';
import { ConversationTemplateService } from '../../ee/server/src/service/conversation-template-service.js';
import type { MarAgentModelService } from '../../ee/server/src/service/mar-agent-model-service.js';

const draftInput: Omit<ConversationTemplateDraft, 'templateId' | 'revision' | 'updatedAt'> = {
  nodeId: 'node-1',
  workspaceId: 'workspace-1',
  name: 'Research',
  description: 'Research with a fixed corpus.',
  icon: 'search',
  allowedModels: [{ modelId: 'coding-config-id', name: 'Client supplied name' }],
  defaultModelId: 'coding-config-id',
  mcpIds: ['mcp-local'],
  networkMode: 'NONE',
  quotas: {
    maxStorageBytes: 100_000_000,
    maxUploadBytes: 10_000_000
  }
};

const inspection = {
  valid: true,
  code: null,
  message: 'The draft source is valid.',
  checkedAt: 2_000,
  mcpServers: [
    {
      id: 'mcp-local',
      serverName: 'local-tools',
      displayName: 'Local tools',
      transport: 'STDIO',
      origin: 'WORKSPACE'
    }
  ]
} as const;

const version = {
  id: 'version-1',
  templateId: 'template-1',
  version: 1,
  status: 'AVAILABLE',
  contentHash: 'a'.repeat(64),
  manifestHash: 'b'.repeat(64),
  mcpConfigHash: 'c'.repeat(64),
  fileCount: 2,
  totalBytes: 1024,
  hostPolicyVersion: 1,
  publishedByUserId: 1,
  publishedAt: 2_100
} as const;

const succeededJob = {
  id: 'request-1',
  templateId: 'template-1',
  draftRevision: 1,
  stage: 'REGISTERED',
  status: 'SUCCEEDED',
  versionId: 'version-1',
  errorCode: null,
  createdAt: 2_000,
  updatedAt: 2_100
} as const;

describe('Server conversation template service', () => {
  it('defines strict source inspection and publish result contracts', () => {
    expect(conversationTemplateSourceInspectionSchema.parse(inspection)).toEqual(inspection);
    expect(
      conversationTemplateSourceInspectionSchema.safeParse({
        ...inspection,
        physicalPath: '/srv/private/workspace'
      }).success
    ).toBe(false);
    expect(
      conversationTemplatePublishResultSchema.parse({ job: succeededJob, version })
    ).toMatchObject({ version: { id: 'version-1' } });
    expect(conversationTemplatePublishResultSchema.safeParse({ job: succeededJob }).success).toBe(
      false
    );
    expect(
      conversationTemplatePublishResultSchema.safeParse({
        job: succeededJob,
        version: { ...version, status: 'DISABLED' }
      }).success
    ).toBe(false);
  });

  it('exposes the source workspace only through the authorized internal runtime context', async () => {
    const fixture = serviceFixture();
    fixture.database.raw.execute.mockResolvedValueOnce([
      [
        templateRow({
          current_version_id: 'version-1',
          current_version_status: 'AVAILABLE'
        })
      ],
      []
    ]);
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models
    );

    const context = await service.runtimeContext(7, 'template-1');

    expect(fixture.resources.canUseTemplate).toHaveBeenCalledWith(7, 'template-1');
    expect(context).toEqual({
      template: expect.objectContaining({
        id: 'template-1',
        nodeId: 'node-1',
        available: true
      }),
      nodeId: 'node-1',
      workspaceId: 'workspace-1'
    });
    expect(context.template).not.toHaveProperty('workspaceId');
  });

  it('rejects template model options for a personal Node', async () => {
    const fixture = serviceFixture();
    fixture.resources.assertCanHostConversationTemplate.mockRejectedValueOnce(
      new Error('CONVERSATION_TEMPLATE_HOST_NODE_INVALID')
    );
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models
    );

    await expect(service.listModelOptions('node-personal')).rejects.toThrow(
      'CONVERSATION_TEMPLATE_HOST_NODE_INVALID'
    );
    expect(fixture.models.listTemplateOptionsForNode).not.toHaveBeenCalled();
  });

  it.each(['create', 'update'] as const)(
    'rejects %s when authorization is revoked during Node inspection',
    async (operation) => {
      const fixture = serviceFixture();
      fixture.database.raw.execute.mockResolvedValueOnce([[templateRow()], []]);
      let finishInspection!: () => void;
      const gate = new Promise<void>((resolve) => {
        finishInspection = resolve;
      });
      const inspect = vi.fn(async () => {
        await gate;
        return inspection;
      });
      const service = new ConversationTemplateService(
        fixture.database,
        fixture.resources,
        fixture.models,
        () => 2_000,
        () => 'template-1'
      );
      const pending =
        operation === 'create'
          ? service.create(1, draftInput, inspect)
          : service.update(1, 'template-1', { ...draftInput, draftRevision: 1 }, inspect);
      await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
      fixture.resources.assertCanManageConversationTemplate.mockRejectedValue(
        new Error('ADMIN_REQUIRED')
      );
      const rejected = expect(pending).rejects.toThrow('ADMIN_REQUIRED');
      finishInspection();
      await rejected;
      expect(fixture.resources.assertCanManageConversationTemplate).toHaveBeenCalledWith(
        1,
        'node-1',
        'workspace-1',
        fixture.connection
      );
      expect(
        fixture.connection.execute.mock.calls.some(([sql]) =>
          /^(INSERT|UPDATE) /u.test(String(sql))
        )
      ).toBe(false);
      expect(fixture.connection.rollback).toHaveBeenCalledOnce();
      expect(fixture.connection.commit).not.toHaveBeenCalled();
      expect(fixture.database.audit).not.toHaveBeenCalled();
    }
  );

  it('rejects a new publish job when authorization is revoked after preparation', async () => {
    const fixture = serviceFixture();
    let finishLookup!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishLookup = resolve;
    });
    const lookup = vi.fn(async (): Promise<[unknown, unknown]> => {
      await gate;
      return [[], []];
    });
    fixture.database.raw.execute
      .mockResolvedValueOnce([[templateRow()], []])
      .mockImplementationOnce(lookup);
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models,
      () => 2_000
    );
    const dispatch = vi.fn();
    const pending = service.publish(
      1,
      'template-1',
      { templateId: 'template-1', draftRevision: 1, requestId: 'request-1' },
      dispatch
    );
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
    fixture.resources.assertCanManageConversationTemplate.mockRejectedValue(
      new Error('ADMIN_REQUIRED')
    );
    const rejected = expect(pending).rejects.toThrow('ADMIN_REQUIRED');
    finishLookup();
    await rejected;
    expect(fixture.resources.assertCanManageConversationTemplate).toHaveBeenCalledWith(
      1,
      'node-1',
      'workspace-1',
      fixture.connection
    );
    expect(
      fixture.connection.execute.mock.calls.some(([sql]) => String(sql).startsWith('INSERT'))
    ).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(fixture.connection.rollback).toHaveBeenCalledOnce();
  });

  it('validates and inspects a new draft before persisting revision 1 without auditing its configuration', async () => {
    const fixture = serviceFixture();
    const inspect = vi.fn(async () => inspection);
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models,
      () => 2_000,
      () => 'template-1'
    );

    const created = await service.create(1, draftInput, inspect);

    expect(fixture.resources.assertCanUseWorkspace).toHaveBeenCalledWith(
      1,
      'node-1',
      'workspace-1'
    );
    expect(fixture.resources.assertCanHostConversationTemplate).toHaveBeenCalledWith('node-1');
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: 'template-1',
        revision: 1,
        updatedAt: 2_000,
        allowedModels: [{ modelId: 'coding-config-id', name: 'Coding' }]
      }),
      'VALIDATE'
    );
    expect(fixture.connection.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO conversation_templates'),
      expect.arrayContaining(['template-1', 'node-1', 'workspace-1', 1])
    );
    expect(created.draft).toMatchObject({
      templateId: 'template-1',
      revision: 1,
      allowedModels: [{ modelId: 'coding-config-id', name: 'Coding' }]
    });
    expect(fixture.database.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'conversation_template.created',
        targetName: 'Research',
        organizationId: 7,
        actorUserId: 1,
        targetType: 'TEMPLATE',
        targetId: 'template-1',
        nodeId: 'node-1',
        workspaceId: 'workspace-1'
      })
    );
    expect(JSON.stringify(fixture.database.audit.mock.calls)).not.toContain('mcp-local');
  });

  it('rejects a new template before inspection when the source Node is personal', async () => {
    const fixture = serviceFixture();
    fixture.resources.assertCanHostConversationTemplate.mockRejectedValueOnce(
      new Error('CONVERSATION_TEMPLATE_HOST_NODE_INVALID')
    );
    const inspect = vi.fn(async () => inspection);
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models,
      () => 2_000,
      () => 'template-1'
    );

    await expect(service.create(1, draftInput, inspect)).rejects.toThrow(
      'CONVERSATION_TEMPLATE_HOST_NODE_INVALID'
    );
    expect(inspect).not.toHaveBeenCalled();
    expect(fixture.database.raw.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO conversation_templates'),
      expect.any(Array)
    );
  });

  it('rechecks organization hosting before saving, testing, or publishing a draft', async () => {
    const fixture = serviceFixture();
    fixture.database.raw.execute.mockResolvedValue([[templateRow()], []]);
    fixture.resources.assertCanHostConversationTemplate.mockRejectedValue(
      new Error('CONVERSATION_TEMPLATE_HOST_NODE_INVALID')
    );
    const inspect = vi.fn(async () => inspection);
    const publish = vi.fn();
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models,
      () => 2_000
    );

    await expect(
      service.update(1, 'template-1', { ...draftInput, draftRevision: 1 }, inspect)
    ).rejects.toThrow('CONVERSATION_TEMPLATE_HOST_NODE_INVALID');
    await expect(
      service.testDraft(1, 'template-1', { ...draftInput, draftRevision: 1 }, inspect)
    ).rejects.toThrow('CONVERSATION_TEMPLATE_HOST_NODE_INVALID');
    await expect(
      service.publish(
        1,
        'template-1',
        { templateId: 'template-1', draftRevision: 1, requestId: 'request-1' },
        publish
      )
    ).rejects.toThrow('CONVERSATION_TEMPLATE_HOST_NODE_INVALID');

    expect(inspect).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    { operation: 'save', source: 'Node' },
    { operation: 'save', source: 'Workspace' },
    { operation: 'test', source: 'Node' },
    { operation: 'test', source: 'Workspace' }
  ])(
    'rejects changing the template source $source during draft $operation',
    async ({ operation, source }) => {
      const fixture = serviceFixture();
      fixture.database.raw.execute.mockResolvedValue([[templateRow()], []]);
      const inspect = vi.fn(async () => inspection);
      const service = new ConversationTemplateService(
        fixture.database,
        fixture.resources,
        fixture.models,
        () => 2_000
      );
      const changed =
        source === 'Node'
          ? { nodeId: 'node-2', workspaceId: 'workspace-2' }
          : { nodeId: 'node-1', workspaceId: 'workspace-2' };
      const input = { ...draftInput, ...changed, draftRevision: 1 };

      const result =
        operation === 'save'
          ? service.update(1, 'template-1', input, inspect)
          : service.testDraft(1, 'template-1', input, inspect);
      await expect(result).rejects.toThrow('CONVERSATION_TEMPLATE_SOURCE_IMMUTABLE');
      expect(inspect).not.toHaveBeenCalled();
      expect(fixture.resources.assertCanUseWorkspace).not.toHaveBeenCalled();
      expect(fixture.resources.assertCanHostConversationTemplate).not.toHaveBeenCalled();
    }
  );

  it('rejects stale draft saves before inspection and does not persist unknown fields', async () => {
    const fixture = serviceFixture();
    fixture.database.raw.execute.mockResolvedValueOnce([[templateRow({ draft_revision: 3 })], []]);
    const inspect = vi.fn(async () => inspection);
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models,
      () => 2_000
    );

    await expect(
      service.update(1, 'template-1', { ...draftInput, draftRevision: 2 }, inspect)
    ).rejects.toThrow('CONVERSATION_TEMPLATE_REVISION_CONFLICT');
    expect(inspect).not.toHaveBeenCalled();

    await expect(
      service.create(1, { ...draftInput, sourcePath: '/srv/private' }, inspect)
    ).rejects.toThrow('CONVERSATION_TEMPLATE_INPUT_INVALID');
    await expect(
      service.create(1, { ...draftInput, reasoningEfforts: ['high'] }, inspect)
    ).rejects.toThrow('CONVERSATION_TEMPLATE_INPUT_INVALID');
  });

  it('rejects MCP ids that are absent from the effective source inspection', async () => {
    const fixture = serviceFixture();
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models,
      () => 2_000,
      () => 'template-1'
    );

    await expect(
      service.create(1, { ...draftInput, mcpIds: ['mcp-unknown'] }, async () => inspection)
    ).rejects.toThrow('CONVERSATION_TEMPLATE_MCP_INVALID');
    expect(fixture.database.raw.execute).not.toHaveBeenCalled();
  });

  it('rejects a legacy upstream model ID before source inspection', async () => {
    const fixture = serviceFixture();
    const inspect = vi.fn(async () => inspection);
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models,
      () => 2_000,
      () => 'template-1'
    );

    await expect(
      service.create(
        1,
        {
          ...draftInput,
          allowedModels: [{ modelId: 'coding-upstream-id', name: 'Forged name' }],
          defaultModelId: 'coding-upstream-id'
        },
        inspect
      )
    ).rejects.toThrow('CONVERSATION_TEMPLATE_MODEL_INVALID');
    expect(inspect).not.toHaveBeenCalled();
    expect(fixture.database.raw.execute).not.toHaveBeenCalled();
  });

  it('normalizes a draft test against current Node model options without persisting it', async () => {
    const fixture = serviceFixture();
    fixture.database.raw.execute.mockResolvedValueOnce([[templateRow()], []]);
    const inspect = vi.fn(async () => inspection);
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models,
      () => 2_000
    );

    await expect(
      service.testDraft(1, 'template-1', { ...draftInput, draftRevision: 1 }, inspect)
    ).resolves.toEqual(inspection);
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 2,
        allowedModels: [{ modelId: 'coding-config-id', name: 'Coding' }]
      }),
      'DRAFT_TEST'
    );
    expect(
      fixture.database.raw.execute.mock.calls.some(([sql]) =>
        String(sql).includes('UPDATE conversation_templates')
      )
    ).toBe(false);
  });

  it('lists only active published templates authorized for the current user', async () => {
    const fixture = serviceFixture();
    fixture.database.raw.execute.mockResolvedValueOnce([
      [
        templateRow({
          id: 'template-1',
          current_version_id: 'version-1',
          current_version_status: 'AVAILABLE'
        }),
        templateRow({
          id: 'template-2',
          current_version_id: 'version-2',
          current_version_status: 'AVAILABLE'
        })
      ],
      []
    ]);
    fixture.resources.canUseTemplate.mockImplementation(
      async (_userId, templateId) => templateId === 'template-2'
    );
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models
    );

    await expect(service.listForUser(8)).resolves.toEqual([
      expect.objectContaining({ id: 'template-2', available: true })
    ]);
    expect(fixture.resources.canUseTemplate).toHaveBeenCalledTimes(2);
  });

  it('projects the current published version number for admins without exposing publish jobs in detail', async () => {
    const fixture = serviceFixture();
    const fifthVersion = { ...version, id: 'version-5', version: 5 } as const;
    fixture.database.raw.execute
      .mockResolvedValueOnce([
        [
          templateRow({
            current_version_id: 'version-5',
            current_version_number: 5,
            current_version_status: 'AVAILABLE'
          }),
          templateRow({ id: 'template-2' })
        ],
        []
      ])
      .mockResolvedValueOnce([
        [
          templateRow({
            current_version_id: 'version-5',
            current_version_number: 5,
            current_version_status: 'AVAILABLE'
          })
        ],
        []
      ])
      .mockResolvedValueOnce([
        [
          templateVersionRow({
            id: fifthVersion.id,
            version_number: fifthVersion.version
          })
        ],
        []
      ]);
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models
    );

    await expect(service.listAdmin()).resolves.toEqual([
      expect.objectContaining({
        id: 'template-1',
        draftRevision: 1,
        publishedVersion: 5
      }),
      expect.objectContaining({
        id: 'template-2',
        draftRevision: 1,
        publishedVersion: null
      })
    ]);
    await expect(service.detail('template-1')).resolves.toEqual({
      template: expect.objectContaining({
        id: 'template-1',
        draftRevision: 1,
        publishedVersion: 5
      }),
      draft: expect.objectContaining({ templateId: 'template-1', revision: 1 }),
      versions: [fifthVersion]
    });
    expect(
      fixture.database.raw.execute.mock.calls.some(([sql]) =>
        String(sql).includes('FROM conversation_template_publish_jobs')
      )
    ).toBe(false);
  });

  it('publishes a fixed revision idempotently and switches the current version only after registration', async () => {
    const fixture = serviceFixture();
    fixture.database.raw.execute
      .mockResolvedValueOnce([[templateRow()], []])
      .mockResolvedValueOnce([[], []]);
    const publish = vi.fn(async (draft: ConversationTemplateDraft, jobId: string) => ({
      job: { ...succeededJob, id: jobId, draftRevision: draft.revision },
      version
    }));
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models,
      () => 2_000
    );

    await expect(
      service.publish(
        1,
        'template-1',
        { templateId: 'template-1', draftRevision: 1, requestId: 'request-1' },
        publish
      )
    ).resolves.toMatchObject({ status: 'SUCCEEDED', versionId: 'version-1' });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: 'template-1',
        revision: 1,
        allowedModels: [{ modelId: 'coding-config-id', name: 'Coding' }]
      }),
      'request-1',
      1
    );
    expect(fixture.connection.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT IGNORE INTO conversation_template_publish_jobs'),
      ['request-1', 'template-1', 'node-1', 'workspace-1', 1, 1, 2_000, 2_000]
    );
    expect(fixture.connection.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO conversation_template_versions'),
      expect.arrayContaining(['version-1', 'template-1'])
    );
    expect(fixture.connection.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE conversation_templates'),
      expect.arrayContaining(['version-1', 'template-1', 1])
    );
    expect(fixture.connection.commit).toHaveBeenCalledTimes(2);

    fixture.database.raw.execute.mockReset();
    fixture.database.raw.execute
      .mockResolvedValueOnce([[templateRow()], []])
      .mockResolvedValueOnce([[publishJobRow()], []]);
    publish.mockClear();
    await expect(
      service.publish(
        1,
        'template-1',
        { templateId: 'template-1', draftRevision: 1, requestId: 'request-1' },
        publish
      )
    ).resolves.toMatchObject({ status: 'SUCCEEDED' });
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(['RUNNING', 'SUCCEEDED'] as const)(
    'returns the committed failure when a delayed %s refresh arrives',
    async (lateStatus) => {
      const fixture = serviceFixture();
      fixture.database.raw.execute.mockImplementation(async (sql) =>
        String(sql).includes('FROM conversation_template_publish_jobs')
          ? [[{ ...fixture.transactionState.jobRow }], []]
          : [[templateRow()], []]
      );
      const service = new ConversationTemplateService(
        fixture.database,
        fixture.resources,
        fixture.models
      );
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const late = service.publishStatus(2, 'template-1', 'request-1', async () => {
        entered.resolve();
        await release.promise;
        return lateStatus === 'SUCCEEDED'
          ? { job: succeededJob, version }
          : { job: { ...succeededJob, status: 'RUNNING', stage: 'COPYING', versionId: undefined } };
      });
      await entered.promise;
      expect(fixture.connection.beginTransaction).not.toHaveBeenCalled();
      const failed = await service.publishStatus(2, 'template-1', 'request-1', async () => ({
        job: {
          ...succeededJob,
          status: 'FAILED',
          stage: 'COPYING',
          versionId: undefined,
          errorCode: 'PUBLISH_FAILED',
          errorSummary: 'Publishing failed.'
        }
      }));
      release.resolve();
      expect(await late).toEqual(failed);
      expect(fixture.transactionState.jobRow.status).toBe('FAILED');
      expect(fixture.database.audit).not.toHaveBeenCalled();
      expect(
        fixture.connection.execute.mock.calls.some(([sql]) =>
          String(sql).includes('INSERT INTO conversation_template_versions')
        )
      ).toBe(false);
    }
  );

  it('does not regress RUNNING to QUEUED or repeat success registration for an in-flight refresh', async () => {
    const fixture = serviceFixture();
    fixture.database.raw.execute.mockImplementation(async (sql) =>
      String(sql).includes('FROM conversation_template_publish_jobs')
        ? [[{ ...fixture.transactionState.jobRow }], []]
        : [[templateRow()], []]
    );
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const duplicate = service.publishStatus(2, 'template-1', 'request-1', async () => {
      entered.resolve();
      await release.promise;
      return { job: succeededJob, version };
    });
    await entered.promise;
    const running = { ...succeededJob, status: 'RUNNING', stage: 'COPYING', versionId: undefined };
    await expect(
      service.publishStatus(2, 'template-1', 'request-1', async () => ({ job: running }))
    ).resolves.toMatchObject({ status: 'RUNNING' });
    await expect(
      service.publishStatus(2, 'template-1', 'request-1', async () => ({
        job: { ...running, status: 'QUEUED', stage: 'VALIDATING' }
      }))
    ).resolves.toMatchObject({ status: 'RUNNING', stage: 'COPYING' });
    const success = await service.publishStatus(2, 'template-1', 'request-1', async () => ({
      job: succeededJob,
      version
    }));
    release.resolve();
    expect(await duplicate).toEqual(success);
    expect(
      fixture.connection.execute.mock.calls.filter(([sql]) =>
        String(sql).includes('INSERT INTO conversation_template_versions')
      )
    ).toHaveLength(1);
    expect(fixture.database.audit).toHaveBeenCalledOnce();
  });

  it('keeps a committed success when an in-flight publish dispatch subsequently fails', async () => {
    const fixture = serviceFixture();
    fixture.database.raw.execute.mockImplementation(async (sql) =>
      String(sql).includes('FROM conversation_template_publish_jobs')
        ? [[{ ...fixture.transactionState.jobRow }], []]
        : [[templateRow()], []]
    );
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const dispatch = service.publish(
      1,
      'template-1',
      { templateId: 'template-1', draftRevision: 1, requestId: 'request-1' },
      async () => {
        entered.resolve();
        await release.promise;
        throw new Error('TRANSPORT_FAILED');
      }
    );
    try {
      await entered.promise;
      const success = await service.publishStatus(2, 'template-1', 'request-1', async () => ({
        job: succeededJob,
        version
      }));
      release.resolve();
      expect(await dispatch).toEqual(success);
      expect(fixture.transactionState.jobRow.status).toBe('SUCCEEDED');
      expect(fixture.database.audit).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.allSettled([dispatch]);
    }
  });

  it('does not recreate a publish job removed while refresh is in flight', async () => {
    const fixture = serviceFixture();
    fixture.database.raw.execute
      .mockResolvedValueOnce([[templateRow()], []])
      .mockResolvedValueOnce([[fixture.transactionState.jobRow], []]);
    const execute = fixture.connection.execute.getMockImplementation()!;
    fixture.connection.execute.mockImplementation(async (...args) =>
      String(args[0]).includes('FROM conversation_template_publish_jobs')
        ? [[], []]
        : execute(...args)
    );
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models
    );
    await expect(
      service.publishStatus(2, 'template-1', 'request-1', async () => ({
        job: succeededJob,
        version
      }))
    ).rejects.toThrow('CONVERSATION_TEMPLATE_PUBLISH_JOB_NOT_FOUND');
    expect(fixture.connection.rollback).toHaveBeenCalledOnce();
    expect(fixture.database.audit).not.toHaveBeenCalled();
    expect(
      fixture.connection.execute.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO conversation_template_versions')
      )
    ).toBe(false);
  });

  it('re-dispatches an existing queued publish job with its original requester', async () => {
    const fixture = serviceFixture();
    fixture.database.raw.execute
      .mockResolvedValueOnce([[templateRow()], []])
      .mockResolvedValueOnce([
        [
          publishJobRow({
            stage: 'VALIDATING',
            status: 'QUEUED',
            version_id: null,
            error_code: null,
            updated_at: 2_000,
            requested_by_user_id: 7
          })
        ],
        []
      ]);
    const publish = vi.fn(async (draft: ConversationTemplateDraft, jobId: string) => ({
      job: { ...succeededJob, id: jobId, draftRevision: draft.revision },
      version: { ...version, publishedByUserId: 7 }
    }));
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models,
      () => 2_100
    );

    await expect(
      service.publish(
        2,
        'template-1',
        { templateId: 'template-1', draftRevision: 1, requestId: 'request-1' },
        publish
      )
    ).resolves.toMatchObject({ status: 'SUCCEEDED', createdAt: 2_000 });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'template-1', revision: 1 }),
      'request-1',
      7
    );
  });

  it('returns a concurrently inserted publish job without dispatching the same request twice', async () => {
    const fixture = serviceFixture();
    fixture.database.raw.execute
      .mockResolvedValueOnce([[templateRow()], []])
      .mockResolvedValueOnce([[], []]);
    fixture.transactionState.publishInsert.affectedRows = 0;
    fixture.database.raw.execute.mockResolvedValueOnce([[publishJobRow()], []]);
    const publish = vi.fn();
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models,
      () => 2_000
    );

    await expect(
      service.publish(
        1,
        'template-1',
        { templateId: 'template-1', draftRevision: 1, requestId: 'request-1' },
        publish
      )
    ).resolves.toMatchObject({ status: 'SUCCEEDED' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects a successful Node result attributed to another publisher', async () => {
    const fixture = serviceFixture();
    fixture.database.raw.execute
      .mockResolvedValueOnce([[templateRow()], []])
      .mockResolvedValueOnce([[], []]);
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models,
      () => 2_000
    );

    await expect(
      service.publish(
        1,
        'template-1',
        { templateId: 'template-1', draftRevision: 1, requestId: 'request-1' },
        async () => ({
          job: succeededJob,
          version: { ...version, publishedByUserId: 2 }
        })
      )
    ).resolves.toMatchObject({
      status: 'FAILED',
      errorCode: 'CONVERSATION_TEMPLATE_PUBLISH_RESULT_INVALID'
    });
    expect(fixture.connection.beginTransaction).toHaveBeenCalledTimes(2);
    expect(fixture.connection.commit).toHaveBeenCalledTimes(2);
  });

  it('stores a safe failed job when successful registration cannot be committed', async () => {
    const fixture = serviceFixture();
    fixture.database.raw.execute
      .mockResolvedValueOnce([[templateRow()], []])
      .mockResolvedValueOnce([[], []]);
    fixture.transactionState.versionInsertError = new Error('write failed');
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models,
      () => 2_100
    );

    await expect(
      service.publish(
        1,
        'template-1',
        { templateId: 'template-1', draftRevision: 1, requestId: 'request-1' },
        async () => ({ job: succeededJob, version })
      )
    ).resolves.toMatchObject({
      status: 'FAILED',
      errorCode: 'CONVERSATION_TEMPLATE_PUBLISH_FAILED',
      createdAt: 2_100
    });
    expect(fixture.connection.rollback).toHaveBeenCalledOnce();
    expect(fixture.connection.commit).toHaveBeenCalledTimes(2);
    expect(fixture.connection.execute).toHaveBeenLastCalledWith(
      expect.stringContaining('UPDATE conversation_template_publish_jobs'),
      expect.arrayContaining(['FAILED', 'CONVERSATION_TEMPLATE_PUBLISH_FAILED'])
    );
  });

  it('logically deletes a template without clearing version history or requesting Node cleanup', async () => {
    const fixture = serviceFixture();
    fixture.database.raw.execute.mockResolvedValueOnce([[templateRow()], []]);
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models,
      () => 2_100
    );

    await expect(service.remove(1, 'template-1')).resolves.toBeUndefined();
    const statements = fixture.connection.execute.mock.calls.map(([sql]) => String(sql));
    expect(statements[0]).toContain("SET status='DELETED',deleted_at=?,updated_at=?");
    expect(statements[0]).not.toContain('current_version_id');
    expect(statements.join('\n')).not.toContain('DELETE FROM conversation_template_versions');
    expect(statements.join('\n')).not.toContain('DELETE FROM conversation_templates');
    expect(fixture.connection.commit).toHaveBeenCalledOnce();
  });

  it('accepts a successful publish result when another admin refreshes the original request', async () => {
    const fixture = serviceFixture();
    fixture.database.raw.execute
      .mockResolvedValueOnce([[templateRow()], []])
      .mockResolvedValueOnce([
        [
          publishJobRow({
            stage: 'COPYING',
            status: 'RUNNING',
            version_id: null,
            updated_at: 2_050,
            requested_by_user_id: 1
          })
        ],
        []
      ]);
    fixture.resources.assertCanUseWorkspace.mockRejectedValue(new Error('WORKSPACE_FORBIDDEN'));
    fixture.resources.assertCanHostConversationTemplate.mockRejectedValue(
      new Error('CONVERSATION_TEMPLATE_HOST_NODE_INVALID')
    );
    fixture.models.listTemplateOptionsForNode.mockRejectedValue(
      new Error('CONVERSATION_TEMPLATE_MODEL_INVALID')
    );
    const refresh = vi.fn(async () => ({ job: succeededJob, version }));
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models,
      () => 2_100
    );

    await expect(
      service.publishStatus(2, 'template-1', 'request-1', refresh)
    ).resolves.toMatchObject({
      status: 'SUCCEEDED',
      versionId: 'version-1',
      createdAt: 2_000
    });
    expect(refresh).toHaveBeenCalledWith('node-1', 'workspace-1', 'template-1', 'request-1');
    expect(fixture.database.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'conversation_template.published',
        targetName: 'Research',
        organizationId: 7,
        actorUserId: 2
      })
    );
    expect(fixture.resources.assertCanUseWorkspace).not.toHaveBeenCalled();
    expect(fixture.resources.assertCanHostConversationTemplate).not.toHaveBeenCalled();
    expect(fixture.models.listTemplateOptionsForNode).not.toHaveBeenCalled();
  });

  it('keeps the current published version monotonic when an older result is registered later', async () => {
    const fixture = serviceFixture();
    fixture.database.raw.execute
      .mockResolvedValueOnce([
        [
          templateRow({
            current_version_id: 'version-2',
            current_version_number: 2,
            current_version_status: 'AVAILABLE'
          })
        ],
        []
      ])
      .mockResolvedValueOnce([
        [
          publishJobRow({
            stage: 'COPYING',
            status: 'RUNNING',
            version_id: null,
            updated_at: 2_050
          })
        ],
        []
      ]);
    fixture.transactionState.publishTemplateRow = {
      status: 'ACTIVE',
      draft_revision: 1,
      current_version_id: 'version-2',
      current_version_number: 2
    };
    const refresh = vi.fn(async () => ({ job: succeededJob, version }));
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models,
      () => 2_100
    );

    await expect(
      service.publishStatus(2, 'template-1', 'request-1', refresh)
    ).resolves.toMatchObject({
      status: 'SUCCEEDED',
      versionId: 'version-1'
    });
    const statements = fixture.connection.execute.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes('FOR UPDATE'))).toBe(true);
    expect(statements.some((sql) => sql.includes('SET current_version_id='))).toBe(false);
    expect(fixture.connection.commit).toHaveBeenCalledOnce();
  });

  it('attributes a refreshed publish result to the fixed source and revision after the draft changes', async () => {
    const fixture = serviceFixture();
    const currentDraft: ConversationTemplateDraft = {
      ...draftInput,
      templateId: 'template-1',
      revision: 2,
      updatedAt: 2_050,
      nodeId: 'node-2',
      workspaceId: 'workspace-2'
    };
    fixture.database.raw.execute
      .mockResolvedValueOnce([
        [
          templateRow({
            source_node_id: currentDraft.nodeId,
            source_workspace_id: currentDraft.workspaceId,
            draft_revision: currentDraft.revision,
            draft_config: JSON.stringify(currentDraft),
            updated_at: currentDraft.updatedAt
          })
        ],
        []
      ])
      .mockResolvedValueOnce([
        [
          publishJobRow({
            source_node_id: 'node-1',
            source_workspace_id: 'workspace-1',
            stage: 'COPYING',
            status: 'RUNNING',
            version_id: null,
            updated_at: 2_050
          })
        ],
        []
      ]);
    const refresh = vi.fn(async () => ({ job: succeededJob, version }));
    const service = new ConversationTemplateService(
      fixture.database,
      fixture.resources,
      fixture.models,
      () => 2_100
    );

    await expect(
      service.publishStatus(2, 'template-1', 'request-1', refresh)
    ).resolves.toMatchObject({
      status: 'SUCCEEDED',
      draftRevision: 1,
      versionId: 'version-1'
    });
    expect(refresh).toHaveBeenCalledWith('node-1', 'workspace-1', 'template-1', 'request-1');
    expect(fixture.connection.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO conversation_template_versions'),
      [
        'version-1',
        'template-1',
        1,
        1,
        'AVAILABLE',
        version.contentHash,
        version.manifestHash,
        version.mcpConfigHash,
        version.fileCount,
        version.totalBytes,
        version.hostPolicyVersion,
        version.publishedByUserId,
        version.publishedAt
      ]
    );
    expect(fixture.database.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'conversation_template.published',
        targetName: 'Research',
        organizationId: 7,
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        metadata: JSON.stringify({
          nodeId: 'node-1',
          workspaceId: 'workspace-1',
          nodeName: 'Template host',
          revision: 1,
          jobId: 'request-1',
          versionId: 'version-1',
          ownerType: 'ORGANIZATION'
        })
      })
    );
  });
});

function serviceFixture() {
  const transactionState: {
    readonly publishInsert: { affectedRows: number };
    versionInsertError?: Error;
    publishTemplateRow?: Record<string, unknown>;
    jobRow: Record<string, unknown>;
  } = {
    publishInsert: { affectedRows: 1 },
    jobRow: publishJobRow({
      stage: 'VALIDATING',
      status: 'QUEUED',
      version_id: null
    })
  };
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    execute: vi.fn<(...args: unknown[]) => Promise<[unknown, unknown]>>(async (sql, values) => {
      const statement = String(sql);
      const parameters = Array.isArray(values) ? values : [];
      if (statement.includes('FROM conversation_template_publish_jobs'))
        return [[{ ...transactionState.jobRow }], []];
      if (
        statement.includes('UPDATE conversation_template_publish_jobs') &&
        statement.includes('SET stage=')
      ) {
        const [stage, status, version_id, error_code, error_summary, updated_at] = parameters;
        Object.assign(transactionState.jobRow, {
          stage,
          status,
          version_id,
          error_code,
          error_summary,
          updated_at
        });
      }
      if (statement.includes('SELECT id FROM users')) return [[{ id: parameters[0] }], []];
      if (statement.includes('FROM nodes WHERE id=?'))
        return [
          [
            {
              id: parameters[0],
              nodeName: 'Template host',
              owner_type: 'ORGANIZATION',
              owner_organization_id: 7
            }
          ],
          []
        ];
      if (statement.includes('SELECT workspace_id,node_id FROM workspaces'))
        return [[{ workspace_id: parameters[0], node_id: 'node-1' }], []];
      if (statement.includes('SELECT * FROM conversation_templates WHERE id=? FOR SHARE'))
        return [[templateRow()], []];
      if (statement.includes('SELECT id FROM conversation_template_versions'))
        return [[{ id: parameters[0] }], []];
      if (statement.includes('FROM conversation_templates template'))
        return [
          [
            {
              name: 'Research',
              nodeName: 'Template host',
              owner_type: 'ORGANIZATION',
              owner_organization_id: 7,
              current_version_id: null,
              draft_revision: 1,
              status: 'ACTIVE',
              ...transactionState.publishTemplateRow
            }
          ],
          []
        ];
      if (statement.includes('INSERT IGNORE INTO conversation_template_publish_jobs')) {
        transactionState.jobRow = publishJobRow({
          id: parameters[0],
          template_id: parameters[1],
          source_node_id: parameters[2],
          source_workspace_id: parameters[3],
          draft_revision: parameters[4],
          requested_by_user_id: parameters[5],
          created_at: parameters[6],
          updated_at: parameters[7],
          status: 'QUEUED',
          stage: 'VALIDATING',
          version_id: null
        });
        return [transactionState.publishInsert, []];
      }
      if (statement.includes('INSERT INTO conversation_template_versions')) {
        if (transactionState.versionInsertError !== undefined)
          throw transactionState.versionInsertError;
        return [{ affectedRows: 1 }, []];
      }
      return statement.includes('FOR UPDATE') ? [[templateRow()], []] : [{ affectedRows: 1 }, []];
    }),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn()
  };
  const raw = {
    execute: vi.fn<(...args: unknown[]) => Promise<[unknown, unknown]>>(async () => [
      { affectedRows: 1 },
      []
    ]),
    getConnection: vi.fn(async () => connection)
  };
  const database = {
    raw,
    audit: vi.fn(async () => undefined),
    auditWithConnection: vi.fn(async () => undefined)
  } as unknown as MysqlServerDatabase & {
    raw: typeof raw;
    audit: ReturnType<typeof vi.fn>;
    auditWithConnection: ReturnType<typeof vi.fn>;
  };
  const resources = {
    assertCanManageConversationTemplate: vi.fn(async () => undefined),
    assertCanUseWorkspace: vi.fn(async () => undefined),
    assertCanHostConversationTemplate: vi.fn(async () => undefined),
    canUseTemplate: vi.fn(async () => true)
  } as unknown as ResourceAccessService & {
    assertCanManageConversationTemplate: ReturnType<typeof vi.fn>;
    assertCanUseWorkspace: ReturnType<typeof vi.fn>;
    assertCanHostConversationTemplate: ReturnType<typeof vi.fn>;
    canUseTemplate: ReturnType<typeof vi.fn>;
  };
  const models = {
    listTemplateOptionsForNode: vi.fn(async () => [
      { modelId: 'coding-config-id', name: 'Coding' },
      { modelId: 'review', name: 'Review' }
    ])
  } as unknown as MarAgentModelService & {
    listTemplateOptionsForNode: ReturnType<typeof vi.fn>;
  };
  return { database, resources, models, connection, transactionState };
}

function templateRow(overrides: Record<string, unknown> = {}) {
  const draft: ConversationTemplateDraft = {
    templateId: 'template-1',
    revision: 1,
    updatedAt: 1_900,
    ...draftInput
  };
  return {
    id: 'template-1',
    source_node_id: 'node-1',
    source_workspace_id: 'workspace-1',
    name: 'Research',
    owner_type: 'ORGANIZATION',
    owner_organization_id: 7,
    description: 'Research with a fixed corpus.',
    icon: 'search',
    status: 'ACTIVE',
    current_version_id: null,
    current_version_number: null,
    current_version_status: null,
    draft_revision: 1,
    draft_config: JSON.stringify(draft),
    created_at: 1_000,
    updated_at: 1_900,
    ...overrides
  };
}

function publishJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'request-1',
    template_id: 'template-1',
    source_node_id: 'node-1',
    source_workspace_id: 'workspace-1',
    draft_revision: 1,
    stage: 'REGISTERED',
    status: 'SUCCEEDED',
    version_id: 'version-1',
    error_code: null,
    error_summary: null,
    requested_by_user_id: 1,
    created_at: 2_000,
    updated_at: 2_100,
    ...overrides
  };
}

function templateVersionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: version.id,
    template_id: version.templateId,
    version_number: version.version,
    status: version.status,
    content_hash: version.contentHash,
    manifest_hash: version.manifestHash,
    mcp_config_hash: version.mcpConfigHash,
    file_count: version.fileCount,
    total_bytes: version.totalBytes,
    host_policy_version: version.hostPolicyVersion,
    published_by_user_id: version.publishedByUserId,
    published_at: version.publishedAt,
    ...overrides
  };
}
