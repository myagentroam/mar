import { describe, expect, it, vi } from 'vitest';
import { createCatalogOwnershipService } from '../../ee/web/src/service/CatalogOwnershipService.js';

describe('Enterprise catalog ownership extension', () => {
  it.each([
    { edition: 'COMMUNITY' as const, role: 'ADMIN' as const },
    { edition: 'ENTERPRISE' as const, role: 'MEMBER' as const },
    { edition: 'ENTERPRISE' as const, role: null }
  ])(
    'does not query organizations or offer enterprise writes for $edition/$role',
    async (context) => {
      const request = vi.fn();
      const service = createCatalogOwnershipService(request as never, () => context);
      await service.load();
      expect(request).not.toHaveBeenCalled();
      expect(service.canUseOrganizationScope.value).toBe(false);
      expect(service.sourceTarget()).toEqual({ scope: 'PERSONAL' });
    }
  );
  it('keeps source and catalog ownership separate and omits stale organization IDs outside that scope', async () => {
    const request = vi.fn(async () => ({
      organizations: [{ id: 3, name: 'Platform', parentOrganizationId: null }]
    }));
    const service = createCatalogOwnershipService(request as never, () => ({
      edition: 'ENTERPRISE',
      role: 'ADMIN'
    }));
    await service.load();
    expect(service.canUseOrganizationScope.value).toBe(true);
    service.sourceDraft.scope = 'ORGANIZATION';
    service.sourceDraft.organizationId = 3;
    expect(service.sourceTarget()).toEqual({ scope: 'ORGANIZATION', organizationId: 3 });
    expect(service.catalogTarget()).toEqual({ scope: 'PERSONAL' });
    service.sourceDraft.scope = 'PERSONAL';
    expect(service.sourceTarget()).toEqual({ scope: 'PERSONAL' });
    service.resetSource();
    expect(service.sourceDraft.organizationId).toBeUndefined();
    service.catalogDraft.scope = 'ORGANIZATION';
    service.catalogDraft.organizationId = 3;
    expect(service.catalogTarget()).toEqual({ scope: 'ORGANIZATION', organizationId: 3 });
    service.resetCatalog();
    expect(service.catalogTarget()).toEqual({ scope: 'PERSONAL' });
  });
  it('lets organization administrators use only the returned organization directory', async () => {
    const service = createCatalogOwnershipService(
      vi.fn(async () => ({
        organizations: [{ id: 3, name: 'Platform', parentOrganizationId: null }]
      })) as never,
      () => ({ edition: 'ENTERPRISE', role: 'ORG_ADMIN' })
    );
    await service.load();
    expect(service.canUseOrganizationScope.value).toBe(true);
    expect(service.organizationOptions.value).toEqual([
      { value: 3, label: 'Platform', children: [] }
    ]);
  });
  it('preserves the directory failure for the shared page error boundary', async () => {
    const failure = new Error('FORBIDDEN');
    const service = createCatalogOwnershipService(
      vi.fn(async () => {
        throw failure;
      }) as never,
      () => ({ edition: 'ENTERPRISE', role: 'ADMIN' })
    );
    await expect(service.load()).rejects.toBe(failure);
    expect(service.organizationOptions.value).toEqual([]);
    expect(service.canUseOrganizationScope.value).toBe(false);
  });
});
