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
      model_id: model.modelId,
      name: model.name,
      normalized_name: model.name.normalize('NFKC').toLowerCase()
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
  return { service, execute, listForUser };
}

describe('Node-scoped conversation template model options', () => {
  it.each(scopes)(
    'keeps the first candidate per upstream model ID for a $scope Node and satisfies the Web client',
    async ({ ownership }) => {
      const { service, execute, listForUser } = fixture(ownership, [
        { modelId: 'coding', name: 'Coding' },
        { modelId: 'review', name: 'Review' },
        { modelId: 'coding', name: 'Coding Fast' },
        { modelId: 'coding', name: 'Coding API' }
      ]);
      const options = await service.listTemplateOptionsForNode('node-1');
      expect(options).toEqual([
        { modelId: 'coding', name: 'Coding' },
        { modelId: 'review', name: 'Review' }
      ]);
      const client = createConversationTemplateService(async () => ({ models: options }) as never);
      await expect(client.listModelOptions('node-1')).resolves.toEqual(options);
      if (ownership.ownerType === 'PERSONAL') {
        expect(listForUser).toHaveBeenCalledWith(ownership.ownerUserId);
        expect(execute).not.toHaveBeenCalled();
      } else {
        expect(listForUser).not.toHaveBeenCalled();
      }
    }
  );

  it.each(scopes)('preserves an empty candidate list for a $scope Node', async ({ ownership }) => {
    const { service } = fixture(ownership, []);
    await expect(service.listTemplateOptionsForNode('node-1')).resolves.toEqual([]);
  });
});
