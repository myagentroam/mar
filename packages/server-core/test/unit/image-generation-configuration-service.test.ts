import { describe, expect, it, vi } from 'vitest';
import type { PoolConnection } from 'mysql2/promise';
import type { CodexCredentialSummary, ResourceOwnership } from '@myagentroam/protocol';
import { ImageGenerationConfigurationService } from '../../src/image-generation-configuration-service.js';

function fixture(
  initial: unknown = [],
  options: {
    readonly grantedImageModelIds?: readonly string[];
    readonly manageAll?: boolean;
    readonly userIds?: readonly number[];
    readonly organizationIds?: readonly number[];
  } = {}
) {
  let models: unknown = Array.isArray(initial)
    ? initial.map((model, sortOrder) => ({
        ...(model as Record<string, unknown>),
        ownership: (model as Record<string, unknown>).ownership ?? {
          ownerType: 'PERSONAL',
          ownerUserId: 7
        },
        sortOrder
      }))
    : initial;
  const rows = () => {
    if (!Array.isArray(models)) return [models];
    return [...models]
      .sort(
        (left, right) =>
          Number((left as Record<string, unknown>).sortOrder ?? 0) -
          Number((right as Record<string, unknown>).sortOrder ?? 0)
      )
      .map((model) => {
        const value = model as Record<string, unknown>;
        const ownership = value.ownership as
          | { ownerType: 'PERSONAL'; ownerUserId: number }
          | { ownerType: 'ORGANIZATION'; ownerOrganizationId: number };
        return {
          id: value.id,
          name: value.name,
          owner_type: ownership.ownerType,
          owner_user_id: ownership.ownerType === 'PERSONAL' ? ownership.ownerUserId : null,
          owner_organization_id:
            ownership.ownerType === 'ORGANIZATION' ? ownership.ownerOrganizationId : null,
          provider: value.provider,
          config: JSON.stringify(value.config),
          enabled: value.enabled ? 1 : 0,
          sort_order: value.sortOrder ?? 0
        };
      });
  };
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
    execute: vi.fn(async (sql: string, args?: readonly unknown[]) => {
      if (sql.includes('SELECT id FROM users')) {
        const ids = (args ?? []).filter((value): value is number => typeof value === 'number');
        const userIds = options.userIds ?? [7];
        return [ids.filter((id) => userIds.includes(id)).map((id) => ({ id })), []];
      }
      if (sql.includes('SELECT id FROM organizations')) {
        const organizationIds = options.organizationIds;
        return [
          organizationIds === undefined || organizationIds.includes(Number(args?.[0]))
            ? [{ id: args?.[0] }]
            : [],
          []
        ];
      }
      if (sql.startsWith('SELECT id FROM mar_agent_image_models ORDER BY id FOR UPDATE'))
        return [rows(), []];
      if (sql.startsWith('DELETE FROM user_mar_agent_image_model_orders'))
        return [{ affectedRows: 1 }, []];
      if (sql.startsWith('DELETE FROM mar_agent_image_models')) {
        if (Array.isArray(models))
          models = models.filter((model) => (model as Record<string, unknown>).id !== args?.[0]);
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('INSERT INTO mar_agent_image_models')) {
        const [
          id,
          name,
          ,
          ownerType,
          ownerUserId,
          ownerOrganizationId,
          provider,
          config,
          enabled,
          sortOrder
        ] = args ?? [];
        if (Array.isArray(models)) {
          const next = {
            id,
            name,
            ownership:
              ownerType === 'PERSONAL'
                ? { ownerType, ownerUserId }
                : { ownerType, ownerOrganizationId },
            provider,
            config: JSON.parse(String(config)),
            enabled: Boolean(enabled),
            sortOrder
          };
          const index = models.findIndex((model) => (model as Record<string, unknown>).id === id);
          if (index === -1) models.push(next);
          else models[index] = { ...(models[index] as object), ...next };
        }
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected connection statement: ${sql}`);
    })
  };
  const execute = vi.fn(async (sql: string) => {
    if (sql.includes('FROM mar_agent_image_models')) return [rows(), []];
    throw new Error(`Unexpected statement: ${sql}`);
  });
  const details = vi.fn(async () => ({ credential: { status: 'ACTIVE' } }));
  const type = vi.fn(async (): Promise<CodexCredentialSummary['type']> => 'CODEX_OAUTH');
  const assertUserInScope = vi.fn(async () => undefined);
  const status = vi.fn(async () => 'ACTIVE');
  const canUseImageModel = vi.fn(async (userId: number, modelId: string) => {
    const model = Array.isArray(models)
      ? models.find((item) => (item as Record<string, unknown>).id === modelId)
      : undefined;
    const ownership = (model as Record<string, unknown> | undefined)?.ownership as
      | { ownerType: 'PERSONAL'; ownerUserId: number }
      | { ownerType: 'ORGANIZATION'; ownerOrganizationId: number }
      | undefined;
    return ownership?.ownerType === 'PERSONAL'
      ? ownership.ownerUserId === userId
      : options.grantedImageModelIds?.includes(modelId) === true;
  });
  const canManageImageModel = vi.fn(async (userId: number, modelId: string) => {
    if (options.manageAll) return true;
    const model = Array.isArray(models)
      ? models.find((item) => (item as Record<string, unknown>).id === modelId)
      : undefined;
    const ownership = (model as Record<string, unknown> | undefined)?.ownership as
      { ownerType: 'PERSONAL'; ownerUserId: number } | undefined;
    return ownership?.ownerType === 'PERSONAL' && ownership.ownerUserId === userId;
  });
  const assertOwnershipSelection = vi.fn(
    async (
      userId: number,
      ownership:
        | { ownerType: 'PERSONAL'; ownerUserId: number }
        | { ownerType: 'ORGANIZATION'; ownerOrganizationId: number }
    ) => {
      if (ownership.ownerType === 'PERSONAL' && ownership.ownerUserId !== userId)
        throw new Error('PERSONAL_RESOURCE_FORBIDDEN');
      if (ownership.ownerType === 'ORGANIZATION' && !options.manageAll)
        throw new Error('RESOURCE_OWNERSHIP_MANAGE_REQUIRED');
    }
  );
  const lockOwnership = vi.fn(async (connection: PoolConnection, ownership: ResourceOwnership) => {
    if (ownership.ownerType !== 'ORGANIZATION') return;
    const [rows] = (await connection.execute('SELECT id FROM organizations WHERE id=? FOR SHARE', [
      ownership.ownerOrganizationId
    ])) as [{ length: number }, unknown];
    if (rows.length !== 1) throw new Error('ORGANIZATION_NOT_FOUND');
  });
  const service = new ImageGenerationConfigurationService(
    { raw: { execute, getConnection: vi.fn(async () => connection) } } as never,
    { type, details, assertUserInScope, status } as never,
    Date.now,
    { canUseImageModel, canManageImageModel, assertOwnershipSelection, lockOwnership }
  );
  return {
    service,
    execute,
    details,
    type,
    assertUserInScope,
    status,
    canUseImageModel,
    canManageImageModel,
    lockOwnership,
    connection,
    document: () => models
  };
}
const codex = {
  id: 'codex',
  name: 'Codex',
  enabled: true,
  provider: 'CODEX' as const,
  config: { credentialId: 'credential-1', modelId: 'gpt-image-2' }
};
const ark = {
  id: 'ark',
  name: 'Ark',
  enabled: true,
  provider: 'BYTED_ARK' as const,
  config: {
    url: 'https://images.example.test/custom/generate',
    apiKey: 'test-ark-key',
    modelId: 'doubao-seedream-5.0-lite'
  }
};

describe('Ordered image generation catalog', () => {
  it.each(['CHATGPT_OAUTH', 'XAI_OAUTH'] as const)(
    'rejects %s bindings and skips them in stored image configurations',
    async (type) => {
      const f = fixture([codex, ark]);
      f.type.mockResolvedValue(type);
      await expect(f.service.update(7, [codex])).rejects.toThrow('IMAGE_MODEL_CONFIG_INVALID');
      expect(f.connection.beginTransaction).not.toHaveBeenCalled();
      expect((await f.service.forUser(7))?.provider).toBe('BYTED_ARK');
      expect(f.assertUserInScope).not.toHaveBeenCalled();
    }
  );

  it('requires an explicit safe URL on writes and skips stored entries without it', async () => {
    const missing = { ...ark, config: { apiKey: ark.config.apiKey, modelId: ark.config.modelId } };
    const f = fixture([missing, codex]);
    expect(await f.service.get()).toHaveLength(2);
    expect((await f.service.forUser(7))?.provider).toBe('CODEX');
    const unchanged = await f.service.get();
    await expect(f.service.update(7, unchanged.reverse())).resolves.toHaveLength(2);
    for (const url of [
      undefined,
      '',
      'invalid',
      'http://remote.test/images',
      'https://user:pass@host.test/images',
      'https://host.test/images?key=x',
      'https://host.test/images#x'
    ]) {
      await expect(
        f.service.update(7, [{ ...ark, config: { ...ark.config, url } }])
      ).rejects.toThrow();
    }
    await f.service.update(7, [ark]);
    expect((await f.service.forUser(7))?.config).toMatchObject({ url: ark.config.url });
  });
  it('persists order and returns only the first usable provider', async () => {
    const f = fixture();
    await f.service.update(7, [ark, codex]);
    expect(f.details).toHaveBeenCalledWith(7, 'credential-1');
    expect((await f.service.forUser(7))?.provider).toBe('BYTED_ARK');
    await f.service.update(7, [codex, ark]);
    expect((await f.service.forUser(7))?.provider).toBe('CODEX');
  });
  it('skips disabled and out-of-scope entries', async () => {
    const f = fixture(
      [
        {
          ...ark,
          enabled: false,
          ownership: { ownerType: 'ORGANIZATION' as const, ownerOrganizationId: 4 }
        },
        codex
      ],
      { grantedImageModelIds: ['ark'], manageAll: true }
    );
    f.assertUserInScope.mockRejectedValue(new Error('CODEX_CREDENTIAL_SCOPE_FORBIDDEN'));
    expect(await f.service.forUser(9)).toBeNull();
    await f.service.update(7, [
      codex,
      {
        ...ark,
        ownership: { ownerType: 'ORGANIZATION' as const, ownerOrganizationId: 4 }
      }
    ]);
    expect((await f.service.forUser(9))?.provider).toBe('BYTED_ARK');
  });
  it('never returns API keys and preserves an omitted key only for the same ID/provider', async () => {
    const f = fixture();
    const result = await f.service.update(7, [ark]);
    expect(JSON.stringify(result)).not.toContain('test-ark-key');
    expect(result[0]?.config).toEqual({
      url: ark.config.url,
      modelId: ark.config.modelId,
      hasApiKey: true
    });
    await f.service.update(7, result);
    expect((await f.service.forUser(7))?.config).toMatchObject({ apiKey: 'test-ark-key' });
    await expect(f.service.update(7, [{ ...result[0], id: 'new' }])).rejects.toThrow();
  });
  it('skips reauthentication and missing credentials but does not hide storage failures', async () => {
    const f = fixture([codex, ark]);
    f.status.mockResolvedValue('REAUTH_REQUIRED');
    expect((await f.service.forUser(7))?.provider).toBe('BYTED_ARK');
    f.assertUserInScope.mockRejectedValue(new Error('CODEX_CREDENTIAL_NOT_FOUND'));
    expect((await f.service.forUser(7))?.provider).toBe('BYTED_ARK');
    f.assertUserInScope.mockRejectedValue(new Error('DB_UNAVAILABLE'));
    await expect(f.service.forUser(7)).rejects.toThrow('DB_UNAVAILABLE');
    expect(
      await fixture([{ ...ark, config: { modelId: ark.config.modelId } }]).service.forUser(7)
    ).toBeNull();
  });
  it('rejects duplicates, unknown providers and legacy singleton documents', async () => {
    const f = fixture();
    await expect(f.service.update(7, [codex, codex])).rejects.toThrow();
    await expect(f.service.update(7, [{ ...codex, provider: 'UNKNOWN' }])).rejects.toThrow();
    await expect(fixture(codex).service.get()).rejects.toThrow(
      'MAR_AGENT_IMAGE_GENERATION_CONFIG_INVALID'
    );
  });

  it('uses standard ownership for management and stores image models in their own table', async () => {
    const f = fixture(
      [
        {
          ...ark,
          ownership: { ownerType: 'ORGANIZATION' as const, ownerOrganizationId: 4 }
        }
      ],
      { manageAll: true, grantedImageModelIds: ['ark'] }
    );

    await expect(f.service.get(7)).resolves.toEqual([
      expect.objectContaining({
        id: 'ark',
        ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 4 }
      })
    ]);
    await f.service.update(7, [
      {
        ...ark,
        ownership: { ownerType: 'ORGANIZATION' as const, ownerOrganizationId: 4 }
      }
    ]);
    expect(
      f.execute.mock.calls.some(([sql]) => String(sql).includes('mar_agent_image_models'))
    ).toBe(true);
    expect(f.connection.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO mar_agent_image_models'),
      expect.arrayContaining(['ark', 'ORGANIZATION', null, 4])
    );
    await expect(f.service.forUser(7)).resolves.toEqual(expect.objectContaining({ id: 'ark' }));
  });
  it('allows reordering an unchanged unavailable credential but validates new bindings', async () => {
    const f = fixture([codex, ark]);
    f.details.mockRejectedValue(new Error('CODEX_CREDENTIAL_NOT_FOUND'));
    await expect(f.service.update(7, [ark, codex])).resolves.toHaveLength(2);
    await expect(f.service.update(7, [{ ...codex, id: 'new-binding' }, ark])).rejects.toThrow(
      'CODEX_CREDENTIAL_NOT_FOUND'
    );
  });

  it('rejects a missing actor before changing the image catalog and rolls back', async () => {
    const f = fixture([], { userIds: [] });

    await expect(f.service.update(7, [ark])).rejects.toThrow('USER_NOT_FOUND');
    expect(f.connection.commit).not.toHaveBeenCalled();
    expect(f.connection.rollback).toHaveBeenCalledOnce();
    expect(f.connection.release).toHaveBeenCalledOnce();
    expect(f.connection.rollback.mock.invocationCallOrder[0]!).toBeLessThan(
      f.connection.release.mock.invocationCallOrder[0]!
    );
    expect(f.document()).toEqual([]);
  });

  it('rejects a missing organization before changing the image catalog and rolls back', async () => {
    const model = {
      ...ark,
      ownership: { ownerType: 'ORGANIZATION' as const, ownerOrganizationId: 9 }
    };
    const f = fixture([model], { manageAll: true, organizationIds: [] });

    await expect(f.service.update(7, [model])).rejects.toThrow('ORGANIZATION_NOT_FOUND');
    expect(f.connection.commit).not.toHaveBeenCalled();
    expect(f.connection.rollback).toHaveBeenCalledOnce();
    expect(f.connection.release).toHaveBeenCalledOnce();
    expect(f.connection.rollback.mock.invocationCallOrder[0]!).toBeLessThan(
      f.connection.release.mock.invocationCallOrder[0]!
    );
    expect(f.document()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'ark' })]));
  });
});
