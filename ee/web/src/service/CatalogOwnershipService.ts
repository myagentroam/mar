import { computed, reactive, ref } from 'vue';
import {
  organizationCascaderOptions,
  type OrganizationSummary
} from './EnterpriseManagementService.js';

type Scope = 'PERSONAL' | 'ORGANIZATION';
interface OwnershipDraft {
  scope: Scope;
  organizationId: number | undefined;
}

export function createCatalogOwnershipService(
  request: <T>(path: string, init?: RequestInit) => Promise<T>,
  context: () => {
    readonly edition: 'COMMUNITY' | 'ENTERPRISE';
    readonly role: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER' | null;
  }
) {
  const organizations = ref<readonly OrganizationSummary[]>([]);
  const sourceDraft = reactive<OwnershipDraft>({ scope: 'PERSONAL', organizationId: undefined });
  const catalogDraft = reactive<OwnershipDraft>({ scope: 'PERSONAL', organizationId: undefined });
  const canManageOrganizations = computed(() => {
    const current = context();
    return (
      current.edition === 'ENTERPRISE' && (current.role === 'ADMIN' || current.role === 'ORG_ADMIN')
    );
  });
  const canUseOrganizationScope = computed(
    () => canManageOrganizations.value && organizations.value.length > 0
  );
  async function load(): Promise<void> {
    if (!canManageOrganizations.value) {
      organizations.value = [];
      return;
    }
    const result = await request<{ organizations: readonly OrganizationSummary[] }>(
      '/api/organizations'
    );
    organizations.value = result.organizations;
  }
  function target(draft: OwnershipDraft) {
    return {
      scope: draft.scope,
      ...(draft.scope === 'ORGANIZATION' && draft.organizationId !== undefined
        ? { organizationId: draft.organizationId }
        : {})
    };
  }
  return {
    sourceDraft,
    catalogDraft,
    canUseOrganizationScope,
    organizationOptions: computed(() => organizationCascaderOptions(organizations.value)),
    load,
    sourceTarget: () => target(sourceDraft),
    catalogTarget: () => target(catalogDraft),
    resetSource: () => Object.assign(sourceDraft, { scope: 'PERSONAL', organizationId: undefined }),
    resetCatalog: () =>
      Object.assign(catalogDraft, { scope: 'PERSONAL', organizationId: undefined })
  };
}
