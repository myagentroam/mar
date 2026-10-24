import { describe, expect, it, vi } from 'vitest';
import type { CodexCredentialSummary } from '../../packages/protocol/src/index.js';
import { createModelCredentialOwnershipService } from '../../ee/web/src/service/model-credential-ownership-service.js';
import {
  localePreferenceService,
  translate
} from '../../ee/web/src/service/locale-preference-service.js';

const entry = (ownership: CodexCredentialSummary['ownership']) =>
  ({ ownership }) as CodexCredentialSummary;
describe('Enterprise model credential ownership', () => {
  it('keeps personal resource ownership distinct from the Community edition label', () => {
    const preference = localePreferenceService();
    const previous = preference.locale.value;
    preference.setLocale('en-US');
    try {
      expect(translate('generated.licenseManagementPage.personal')).toBe('Community');
      expect(translate('marAgentModels.modelOwnershipHint')).toMatch(/^Personal models/u);
    } finally {
      preference.setLocale(previous);
    }
  });
  it('shares an in-flight directory request between initial loading and form preparation', async () => {
    let resolveDirectory!: (value: {
      organizations: { id: number; name: string; parentOrganizationId: null }[];
    }) => void;
    const directory = new Promise((resolve) => {
      resolveDirectory = resolve;
    });
    const request = vi.fn(() => directory);
    const service = createModelCredentialOwnershipService(request as never, () => ({
      edition: 'ENTERPRISE',
      role: 'ADMIN',
      organizationId: 1
    }));
    const initial = service.loadOrganizations();
    const editing = service.prepare(entry({ ownerType: 'ORGANIZATION', ownerOrganizationId: 7 }));
    const requestCount = request.mock.calls.length;
    resolveDirectory({ organizations: [{ id: 7, name: 'Platform', parentOrganizationId: null }] });
    await Promise.all([initial, editing]);
    expect(requestCount).toBe(1);
    expect(service.label({ ownerType: 'ORGANIZATION', ownerOrganizationId: 7 })).toContain(
      'Platform'
    );
    expect(service.serialize()).toEqual({ ownerType: 'ORGANIZATION', ownerOrganizationId: 7 });
  });
  it.each(['zh-CN', 'en-US'] as const)(
    'resolves model detail organization names after initial preparation in %s',
    async (locale) => {
      const preference = localePreferenceService();
      const previousLocale = preference.locale.value;
      preference.setLocale(locale);
      try {
        const request = vi.fn(async () => ({
          organizations: [
            { id: 1, name: 'Platform', parentOrganizationId: null },
            { id: 7, name: 'Research', parentOrganizationId: 1 }
          ]
        }));
        const service = createModelCredentialOwnershipService(request as never, () => ({
          edition: 'ENTERPRISE',
          role: 'ADMIN',
          organizationId: 1
        }));
        await service.prepare();
        expect(request).toHaveBeenCalledWith('/api/organizations');
        for (const [id, name] of [
          [1, 'Platform'],
          [7, 'Platform / Research'],
          [99, '99']
        ] as const) {
          expect(service.label({ ownerType: 'ORGANIZATION', ownerOrganizationId: id })).toBe(
            translate('marAgentModels.codexCredentialScopeOrganization', { value0: name })
          );
        }
        expect(service.label({ ownerType: 'PERSONAL', ownerUserId: 3 })).toBe(
          translate('marAgentModels.codexCredentialScopePersonal')
        );
      } finally {
        preference.setLocale(previousLocale);
      }
    }
  );
  it('retries failed directory loading without resetting the ownership draft', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('Directory unavailable'))
      .mockResolvedValue({
        organizations: [{ id: 7, name: 'Platform', parentOrganizationId: null }]
      });
    const service = createModelCredentialOwnershipService(request as never, () => ({
      edition: 'ENTERPRISE',
      role: 'ORG_ADMIN',
      organizationId: 7
    }));
    service.draft.ownerType = 'PERSONAL';
    service.draft.ownerUserId = 3;
    await service.loadOrganizations();
    expect(service.label({ ownerType: 'ORGANIZATION', ownerOrganizationId: 7 })).toContain('7');
    await service.loadOrganizations();
    expect(service.label({ ownerType: 'ORGANIZATION', ownerOrganizationId: 7 })).toContain(
      'Platform'
    );
    expect(service.serialize()).toEqual({ ownerType: 'PERSONAL', ownerUserId: 3 });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('separates model ownership from credential scope and preserves it when editing', async () => {
    const request = vi.fn(async () => ({
      organizations: [{ id: 7, name: 'Platform', parentOrganizationId: null }]
    }));
    const service = createModelCredentialOwnershipService(
      request as never,
      () => ({
        edition: 'ENTERPRISE',
        role: 'ADMIN',
        organizationId: 1
      }),
      'MODEL'
    );
    await service.prepare();
    expect(service.draft.ownerType).toBe('PERSONAL');
    expect(service.serializeModel()).toBeUndefined();
    service.draft.ownerType = 'ORGANIZATION';
    expect(() => service.serializeModel()).toThrow('MAR_AGENT_MODEL_CONFIG_INVALID');
    service.draft.ownerOrganizationId = 7;
    expect(service.serializeModel()).toEqual({ ownerType: 'ORGANIZATION', ownerOrganizationId: 7 });
    await service.prepare(entry({ ownerType: 'PERSONAL', ownerUserId: 3 }));
    expect(service.serializeModel()).toEqual({ ownerType: 'PERSONAL', ownerUserId: 3 });
    service.draft.ownerType = 'INVALID' as never;
    expect(() => service.serializeModel()).toThrow('MAR_AGENT_MODEL_CONFIG_INVALID');
    await service.prepare();
    expect(service.draft.ownerOrganizationId).toBeUndefined();
  });
  it.each([
    { edition: 'COMMUNITY' as const, role: 'ADMIN' as const },
    { edition: 'ENTERPRISE' as const, role: 'MEMBER' as const }
  ])(
    'defaults to personal ownership without enterprise directory requests for $edition/$role',
    async (context) => {
      const request = vi.fn();
      const service = createModelCredentialOwnershipService(request as never, () => ({
        ...context,
        organizationId: 1
      }));
      await service.loadOrganizations();
      await service.prepare();
      expect(request).not.toHaveBeenCalled();
      expect(service.serialize()).toEqual({ ownerType: 'PERSONAL' });
    }
  );
  it('preserves default administrator scopes and scalar organization IDs', async () => {
    const context = {
      edition: 'ENTERPRISE' as const,
      role: 'ORG_ADMIN' as 'ORG_ADMIN' | 'ADMIN',
      organizationId: 7
    };
    const request = vi.fn(async () => ({
      organizations: [{ id: 7, name: 'Platform', parentOrganizationId: null }]
    }));
    const service = createModelCredentialOwnershipService(request as never, () => context);
    await service.prepare();
    expect(service.serialize()).toEqual({ ownerType: 'ORGANIZATION', ownerOrganizationId: 7 });
    expect(service.organizationOptions.value).toEqual([
      { value: 7, label: 'Platform', children: [] }
    ]);
    context.role = 'ADMIN';
    await service.prepare();
    expect(service.serialize()).toEqual({ ownerType: 'ORGANIZATION', ownerOrganizationId: 7 });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('restores all supported ownership kinds and resets stale owner IDs between edits', async () => {
    const service = createModelCredentialOwnershipService(vi.fn() as never, () => ({
      edition: 'COMMUNITY',
      role: 'ADMIN',
      organizationId: 1
    }));
    for (const ownership of [
      { ownerType: 'PERSONAL', ownerUserId: 3 },
      { ownerType: 'ORGANIZATION', ownerOrganizationId: 7 }
    ] as const) {
      await service.prepare(entry(ownership));
      expect(service.serialize()).toEqual(ownership);
    }
    await service.prepare();
    expect(service.serialize()).toEqual({ ownerType: 'PERSONAL' });
    expect(service.draft.ownerOrganizationId).toBeUndefined();
    expect(service.draft.ownerUserId).toBeUndefined();
  });
  it('rejects a missing organization instead of silently creating a personal credential', async () => {
    const service = createModelCredentialOwnershipService(vi.fn() as never, () => ({
      edition: 'COMMUNITY',
      role: 'ADMIN',
      organizationId: 1
    }));
    service.draft.ownerType = 'ORGANIZATION';
    expect(() => service.serialize()).toThrow('CODEX_CREDENTIAL_INPUT_INVALID');
  });
  it('does not let a late preparation overwrite a newer credential selection', async () => {
    let resolveFirst!: (value: { organizations: never[] }) => void;
    const request = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValue({ organizations: [] });
    const service = createModelCredentialOwnershipService(request as never, () => ({
      edition: 'ENTERPRISE',
      role: 'ADMIN',
      organizationId: 1
    }));
    const first = service.prepare(entry({ ownerType: 'ORGANIZATION', ownerOrganizationId: 7 }));
    const second = service.prepare(entry({ ownerType: 'PERSONAL', ownerUserId: 3 }));
    resolveFirst({ organizations: [] });
    await Promise.all([first, second]);
    expect(service.serialize()).toEqual({ ownerType: 'PERSONAL', ownerUserId: 3 });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
