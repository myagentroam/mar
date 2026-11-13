import { describe, expect, it, vi } from 'vitest';
import type {
  ConversationTemplateModelReference,
  ResourceOwnership
} from '../../packages/protocol/src/index.js';
import { createConversationTemplateService } from '../../packages/web-core/src/service/conversation-template-service.js';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { MarAgentModelService } from '../../ee/server/src/service/mar-agent-model-service.js';

const scopes: readonly { scope: string; ownership: ResourceOwnership }[] = [
  { scope: 'organization', ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 4 } },
  { scope: 'community personal', ownership: { ownerType: 'PERSONAL', ownerUserId: 8 } }
];

function fixture(
  ownership: ResourceOwnership,
  models: readonly ConversationTemplateModelReference[]
) {
  const execute = vi.fn(async () => [
    models.map((model) => ({
      id: model.modelId,
      name: model.name
    })),
    []
  ]);
  const service = new MarAgentModelService(
    { raw: { execute } } as unknown as MysqlServerDatabase,
    Date.now,
    undefined,
    {
      canUseModel: vi.fn(async () => true),
      canManageModel: vi.fn(async () => true),
      assertOwnershipSelection: vi.fn(async () => undefined),
      nodeOwnership: vi.fn(async () => ownership)
    },
    undefined,
    async () => ownership.ownerType === 'PERSONAL'
  );
  const listForUser = vi
    .spyOn(service, 'listForUser')
    .mockResolvedValue(models as Awaited<ReturnType<MarAgentModelService['listForUser']>>);
  const listAuthorizedConversationModels = vi.spyOn(
    service as unknown as {
      listAuthorizedConversationModels: (userId: number) => Promise<unknown[]>;
    },
    'listAuthorizedConversationModels'
  );
  listAuthorizedConversationModels.mockResolvedValue(
    models.map(({ modelId, name }) => ({ id: modelId, name }))
  );
  return { service, execute, listForUser, listAuthorizedConversationModels };
}

describe('Node-scoped conversation template model options', () => {
  it.each(scopes)(
    'returns every independent configuration for a $scope Node and satisfies the Web client',
    async ({ ownership }) => {
      const { service, execute, listForUser, listAuthorizedConversationModels } = fixture(
        ownership,
        [
          { modelId: 'coding-config-primary', name: 'Coding' },
          { modelId: 'review-config', name: 'Review' },
          { modelId: 'coding-config-secondary', name: 'Coding' }
        ]
      );
      const options = await service.listTemplateOptionsForNode('node-1');
      expect(options).toEqual([
        { modelId: 'coding-config-primary', name: 'Coding' },
        { modelId: 'review-config', name: 'Review' },
        { modelId: 'coding-config-secondary', name: 'Coding' }
      ]);
      const client = createConversationTemplateService(async () => ({ models: options }) as never);
      await expect(client.listModelOptions('node-1')).resolves.toEqual(options);
      if (ownership.ownerType === 'PERSONAL') {
        expect(listAuthorizedConversationModels).toHaveBeenCalledWith(ownership.ownerUserId);
        expect(listForUser).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
      } else {
        expect(listForUser).not.toHaveBeenCalled();
        expect(listAuthorizedConversationModels).not.toHaveBeenCalled();
      }
    }
  );

  it.each(scopes)('preserves an empty candidate list for a $scope Node', async ({ ownership }) => {
    const { service } = fixture(ownership, []);
    await expect(service.listTemplateOptionsForNode('node-1')).resolves.toEqual([]);
  });
});
