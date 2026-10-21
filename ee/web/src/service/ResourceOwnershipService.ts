import { computed, ref, watch } from 'vue';
import {
  organizationCascaderOptions,
  organizationDisplayLabel,
  resourceEditBody,
  type OrganizationSummary
} from './EnterpriseManagementService.js';
import { managementUrlValues, replaceManagementUrlValues } from './ManagementUrlService.js';
import { translate } from './LocalePreferenceService.js';
import type { ResourceRow } from '@myagentroam/web-core/resource-management';
export type ResourceOwnership =
  | { ownerType: 'PERSONAL'; ownerUserId: number }
  | { ownerType: 'ORGANIZATION'; ownerOrganizationId: number };
export type EnterpriseResourceRow = ResourceRow<ResourceOwnership>;
export interface ResourceOwnerUser {
  id: number;
  username: string;
  organizationId: number;
}
export function createResourceOwnershipService(
  request: <T>(path: string, init?: RequestInit) => Promise<T>,
  context: () => {
    edition: 'COMMUNITY' | 'ENTERPRISE';
    role: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER' | null;
    resourceType: 'NODE' | 'WORKSPACE';
  }
) {
  const organizations = ref<readonly OrganizationSummary[]>([]);
  const users = ref<readonly ResourceOwnerUser[]>([]);
  const editOrganizationId = ref<number>();
  const registrationOwner = ref<'PERSONAL' | number>('PERSONAL');
  const path = (id: number) => organizationDisplayLabel(organizations.value, id);
  const organizationOptions = computed(() => organizationCascaderOptions(organizations.value));
  const registrationOwnerOptions = computed(() => [
    {
      value: 'PERSONAL',
      label: translate('generated.resourceSharingPage.personal5'),
      children: []
    },
    ...organizationOptions.value
  ]);
  const ownerType = ref<'' | 'PERSONAL' | 'ORGANIZATION'>('');
  const ownerOrganizationId = ref<number>();
  const ownerUserId = ref<number>();
  const urlNamespace = context().resourceType === 'NODE' ? 'nodes' : 'workspaces';
  const initialFilters = managementUrlValues(urlNamespace, [
    'ownerType',
    'organization',
    'ownerUser'
  ]);
  ownerType.value = (initialFilters.ownerType as typeof ownerType.value) ?? '';
  ownerOrganizationId.value = initialFilters.organization
    ? Number(initialFilters.organization)
    : undefined;
  ownerUserId.value = initialFilters.ownerUser ? Number(initialFilters.ownerUser) : undefined;
  watch([ownerType, ownerOrganizationId, ownerUserId], () =>
    replaceManagementUrlValues(urlNamespace, {
      ownerType: ownerType.value || undefined,
      organization: ownerOrganizationId.value,
      ownerUser: ownerUserId.value
    })
  );
  watch(ownerType, (value) => {
    if (value === 'PERSONAL') ownerOrganizationId.value = undefined;
    else if (value === 'ORGANIZATION') ownerUserId.value = undefined;
    else {
      ownerOrganizationId.value = undefined;
      ownerUserId.value = undefined;
    }
  });
  const ownerUserOptions = computed(() =>
    users.value.map((user) => ({ value: user.id, label: user.username }))
  );
  function ownershipTypeLabel(ownership: ResourceOwnership): string {
    return ownership.ownerType === 'PERSONAL'
      ? translate('generated.resourceSharingPage.personal2')
      : translate('generated.resourceSharingPage.organization');
  }
  function ownershipTypeTag(ownership: ResourceOwnership): 'primary' | 'info' {
    return ownership.ownerType === 'PERSONAL' ? 'info' : 'primary';
  }
  function ownerLabel(ownership: ResourceOwnership, ownerUsername?: string): string {
    return ownership.ownerType === 'PERSONAL'
      ? (ownerUsername ?? translate('generated.resourceSharingPage.personal'))
      : path(ownership.ownerOrganizationId);
  }

  async function load() {
    if (context().edition !== 'ENTERPRISE') {
      organizations.value = [];
      users.value = [];
      return;
    }
    const [organizationResult, userResult] = await Promise.all([
      request<{ organizations: readonly OrganizationSummary[] }>('/api/organizations').catch(
        () => ({ organizations: [] })
      ),
      request<{ users: readonly ResourceOwnerUser[] }>('/api/enterprise/users').catch(() => ({
        users: []
      }))
    ]);
    organizations.value = organizationResult.organizations;
    users.value = userResult.users;
  }
  function matches(row: EnterpriseResourceRow): boolean {
    if (ownerType.value && row.ownership.ownerType !== ownerType.value) return false;
    if (
      ownerType.value !== 'PERSONAL' &&
      ownerOrganizationId.value !== undefined &&
      (row.ownership.ownerType !== 'ORGANIZATION' ||
        row.ownership.ownerOrganizationId !== ownerOrganizationId.value)
    )
      return false;
    if (
      ownerType.value === 'PERSONAL' &&
      ownerUserId.value !== undefined &&
      (row.ownership.ownerType !== 'PERSONAL' || row.ownership.ownerUserId !== ownerUserId.value)
    )
      return false;
    return true;
  }
  function prepareEdit(row: EnterpriseResourceRow) {
    editOrganizationId.value =
      row.ownership.ownerType === 'ORGANIZATION' ? row.ownership.ownerOrganizationId : undefined;
  }
  function editBody(row: EnterpriseResourceRow, displayName: string) {
    return resourceEditBody({
      resourceType: row.resourceType,
      displayName,
      ownership: row.ownership,
      ...(editOrganizationId.value === undefined
        ? {}
        : { ownerOrganizationId: editOrganizationId.value })
    });
  }
  function registrationBody(displayName: string) {
    return typeof registrationOwner.value === 'number'
      ? {
          displayName,
          ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: registrationOwner.value }
        }
      : { displayName };
  }
  return {
    organizations,
    users,
    organizationOptions,
    registrationOwnerOptions,
    ownerUserOptions,
    ownerType,
    ownerOrganizationId,
    ownerUserId,
    registrationOwner,
    editOrganizationId,
    load,
    matches,
    prepareEdit,
    editBody,
    registrationBody,
    typeLabel: (row: EnterpriseResourceRow) => ownershipTypeLabel(row.ownership),
    typeTag: (row: EnterpriseResourceRow) => ownershipTypeTag(row.ownership),
    label: (row: EnterpriseResourceRow) => ownerLabel(row.ownership, row.ownerUsername)
  };
}
