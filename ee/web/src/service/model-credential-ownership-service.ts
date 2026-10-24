import { computed, reactive, ref } from 'vue';
import type { ComputedRef } from 'vue';
import type { FormRules } from 'element-plus';
import type { CodexCredentialOwnership, ResourceOwnership } from '@myagentroam/protocol';
import {
  organizationCascaderOptions,
  organizationDisplayLabel,
  type OrganizationCascaderOption,
  type OrganizationSummary
} from './enterprise-management-service.js';
import { translate } from './locale-preference-service.js';
interface OwnershipDraft {
  [key: string]: unknown;
  ownerType: CodexCredentialOwnership['ownerType'];
  ownerUserId: number | undefined;
  ownerOrganizationId: number | undefined;
}

interface ModelCredentialOwnershipService {
  readonly draft: OwnershipDraft;
  readonly rules: ComputedRef<FormRules>;
  readonly organizationOptions: ComputedRef<readonly OrganizationCascaderOption[]>;
  readonly serialize: () => CodexCredentialOwnership | { readonly ownerType: 'PERSONAL' };
  readonly serializeModel: () => ResourceOwnership | undefined;
  readonly label: (ownership: CodexCredentialOwnership) => string;
  readonly loadOrganizations: () => Promise<void>;
  readonly prepare: (entry?: { readonly ownership?: CodexCredentialOwnership }) => Promise<void>;
}

export function createModelCredentialOwnershipService(
  request: <T>(path: string, init?: RequestInit) => Promise<T>,
  context: () => {
    edition: 'COMMUNITY' | 'ENTERPRISE';
    role: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER' | null;
    organizationId: number | null;
  },
  resource: 'CREDENTIAL' | 'MODEL' = 'CREDENTIAL'
): ModelCredentialOwnershipService {
  const organizations = ref<readonly OrganizationSummary[]>([]);
  let organizationsRequest: Promise<void> | undefined;
  let preparationSequence = 0;
  const credentialDraft = reactive(emptyCredentialDraft());
  const rules = computed<FormRules>(() => ({
    ownerOrganizationId: [
      {
        validator: (_rule, _value, callback) =>
          credentialDraft.ownerType !== 'ORGANIZATION' ||
          credentialDraft.ownerOrganizationId !== undefined
            ? callback()
            : callback(new Error(translate('marAgentModels.selectOrganization'))),
        trigger: 'change'
      }
    ]
  }));
  function emptyCredentialDraft(): OwnershipDraft {
    const current = context();
    const ownerType =
      resource === 'MODEL' || current.edition === 'COMMUNITY' || current.role === 'MEMBER'
        ? 'PERSONAL'
        : 'ORGANIZATION';
    return {
      ownerType,
      ownerUserId: undefined,
      ownerOrganizationId:
        ownerType === 'ORGANIZATION' && current.organizationId !== null
          ? current.organizationId
          : undefined
    };
  }

  async function ensureCredentialOrganizations(): Promise<void> {
    if (
      context().edition !== 'ENTERPRISE' ||
      (context().role !== 'ADMIN' && context().role !== 'ORG_ADMIN') ||
      organizations.value.length > 0
    )
      return;
    if (organizationsRequest !== undefined) return organizationsRequest;
    organizationsRequest = request<{ organizations: readonly OrganizationSummary[] }>(
      '/api/organizations'
    )
      .catch(() => ({ organizations: [] as readonly OrganizationSummary[] }))
      .then((result) => {
        organizations.value = result.organizations;
      })
      .finally(() => {
        organizationsRequest = undefined;
      });
    return organizationsRequest;
  }

  function credentialOwnershipDraft():
    CodexCredentialOwnership | { readonly ownerType: 'PERSONAL' } {
    if (credentialDraft.ownerType === 'PERSONAL')
      return credentialDraft.ownerUserId === undefined
        ? { ownerType: 'PERSONAL' }
        : { ownerType: 'PERSONAL', ownerUserId: credentialDraft.ownerUserId };
    if (credentialDraft.ownerType === 'ORGANIZATION') {
      const ownerOrganizationId = credentialDraft.ownerOrganizationId;
      if (ownerOrganizationId === undefined) throw new Error('CODEX_CREDENTIAL_INPUT_INVALID');
      return { ownerType: 'ORGANIZATION', ownerOrganizationId };
    }
    throw new Error('CODEX_CREDENTIAL_INPUT_INVALID');
  }

  function ownershipDraft(
    ownership: CodexCredentialOwnership
  ): Pick<OwnershipDraft, 'ownerType' | 'ownerUserId' | 'ownerOrganizationId'> {
    return ownership.ownerType === 'PERSONAL'
      ? {
          ownerType: 'PERSONAL',
          ownerUserId: ownership.ownerUserId,
          ownerOrganizationId: undefined
        }
      : {
          ownerType: 'ORGANIZATION',
          ownerUserId: undefined,
          ownerOrganizationId: ownership.ownerOrganizationId
        };
  }

  function organizationLabel(organizationId: number | undefined): string {
    if (organizationId === undefined) return '—';
    return organizationDisplayLabel(organizations.value, organizationId);
  }

  function credentialScopeLabel(ownership: CodexCredentialOwnership): string {
    if (ownership.ownerType === 'PERSONAL')
      return translate('marAgentModels.codexCredentialScopePersonal');
    return translate('marAgentModels.codexCredentialScopeOrganization', {
      value0: organizationLabel(ownership.ownerOrganizationId)
    });
  }

  return {
    draft: credentialDraft,
    rules,
    organizationOptions: computed(() => organizationCascaderOptions(organizations.value)),
    serialize: credentialOwnershipDraft,
    serializeModel() {
      try {
        const ownership = credentialOwnershipDraft();
        if (ownership.ownerType === 'PERSONAL')
          return 'ownerUserId' in ownership ? ownership : undefined;
        return ownership;
      } catch {
        throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
      }
    },
    label: credentialScopeLabel,
    loadOrganizations: ensureCredentialOrganizations,
    async prepare(entry?: { readonly ownership?: CodexCredentialOwnership }) {
      const sequence = ++preparationSequence;
      await ensureCredentialOrganizations();
      if (sequence !== preparationSequence) return;
      Object.assign(
        credentialDraft,
        emptyCredentialDraft(),
        entry?.ownership === undefined ? {} : ownershipDraft(entry.ownership)
      );
    }
  };
}
