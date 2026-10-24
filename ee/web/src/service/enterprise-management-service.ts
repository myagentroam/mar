export type EnterpriseRole = 'ADMIN' | 'ORG_ADMIN' | 'MEMBER';

export function roleLabel(role: EnterpriseRole): string {
  return role === 'ADMIN'
    ? translate('generated.enterpriseManagementService.systemAdministrator')
    : role === 'ORG_ADMIN'
      ? translate('generated.enterpriseManagementService.organizationAdministrator')
      : translate('generated.enterpriseManagementService.member');
}

export interface EnterpriseCapability {
  readonly edition: 'COMMUNITY' | 'ENTERPRISE';
  readonly licenseState: 'COMMUNITY' | 'ENTERPRISE_VALID' | 'ENTERPRISE_FROZEN';
  readonly role: EnterpriseRole | null;
  readonly organizationId?: number | null;
  readonly managementWritable: boolean;
}

export interface OrganizationSummary {
  readonly id: number;
  readonly name: string;
  readonly parentOrganizationId: number | null;
}

export interface OrganizationCascaderOption {
  readonly value: number;
  readonly label: string;
  readonly children: readonly OrganizationCascaderOption[];
}

export type ResourceOwnership =
  | { readonly ownerType: 'PERSONAL'; readonly ownerUserId: number }
  | { readonly ownerType: 'ORGANIZATION'; readonly ownerOrganizationId: number };

export function resourceEditBody(input: {
  readonly resourceType: 'NODE' | 'WORKSPACE';
  readonly displayName: string;
  readonly ownership: ResourceOwnership;
  readonly ownerOrganizationId?: number;
}): { readonly displayName: string | null; readonly ownership?: ResourceOwnership } {
  const displayName = input.displayName.trim();
  return {
    displayName: input.resourceType === 'NODE' && displayName === '' ? null : displayName,
    ...(input.ownership.ownerType === 'ORGANIZATION' && input.ownerOrganizationId !== undefined
      ? {
          ownership: {
            ownerType: 'ORGANIZATION' as const,
            ownerOrganizationId: input.ownerOrganizationId
          }
        }
      : {})
  };
}

export interface OAuthProviderDraft {
  providerKey: string;
  callbackUri: string;
  name: string;
  clientId: string;
  clientSecret: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  scopes: string[];
  pkceMode: 'REQUIRED' | 'SUPPORTED' | 'DISABLED';
  tokenAuthMethod: 'client_secret_basic' | 'client_secret_post' | 'client_secret_json';
  autoProvisioningEnabled: boolean;
  mappings: {
    externalUserId: string;
    email?: string;
    displayName?: string;
  };
}

export function enterpriseManagementAccess(capability: EnterpriseCapability): {
  readonly visible: boolean;
  readonly writable: boolean;
  readonly licenseImportable: true;
} {
  const visible = capability.edition === 'COMMUNITY' || capability.role !== null;
  return {
    visible,
    writable: visible && capability.managementWritable,
    licenseImportable: true
  };
}

export function organizationPath(
  organizations: readonly OrganizationSummary[],
  organizationId: number
): string {
  const byId = new Map(organizations.map((organization) => [organization.id, organization]));
  const visited = new Set<number>();
  const names: string[] = [];
  let current = byId.get(organizationId);
  while (current !== undefined && !visited.has(current.id)) {
    visited.add(current.id);
    names.unshift(current.name);
    current =
      current.parentOrganizationId === null ? undefined : byId.get(current.parentOrganizationId);
  }
  return names.join(' / ');
}

export function organizationDisplayLabel(
  organizations: readonly OrganizationSummary[],
  organizationId: number
): string {
  return organizationPath(organizations, organizationId) || String(organizationId);
}

export function organizationCascaderOptions(
  organizations: readonly OrganizationSummary[]
): readonly OrganizationCascaderOption[] {
  const organizationsById = new Map<number, OrganizationSummary>();
  for (const organization of organizations)
    if (!organizationsById.has(organization.id))
      organizationsById.set(organization.id, organization);
  const optionsById = new Map(
    [...organizationsById.values()].map((organization) => [
      organization.id,
      {
        value: organization.id,
        label: organization.name,
        children: [] as OrganizationCascaderOption[]
      }
    ])
  );
  const roots: OrganizationCascaderOption[] = [];
  for (const organization of organizationsById.values()) {
    const option = optionsById.get(organization.id)!;
    const parent =
      organization.parentOrganizationId === null
        ? undefined
        : optionsById.get(organization.parentOrganizationId);
    if (parent !== undefined && !organizationHasCyclicParent(organization, organizationsById))
      parent.children.push(option);
    else roots.push(option);
  }
  return roots;
}

function organizationHasCyclicParent(
  organization: OrganizationSummary,
  organizationsById: ReadonlyMap<number, OrganizationSummary>
): boolean {
  const visited = new Set<number>([organization.id]);
  let parentOrganizationId = organization.parentOrganizationId;
  while (parentOrganizationId !== null) {
    if (visited.has(parentOrganizationId)) return true;
    visited.add(parentOrganizationId);
    parentOrganizationId =
      organizationsById.get(parentOrganizationId)?.parentOrganizationId ?? null;
  }
  return false;
}

export function newOAuthProviderDraft(providerKey: string, origin: string): OAuthProviderDraft {
  return {
    providerKey,
    callbackUri: `${origin}/api/oauth/${encodeURIComponent(providerKey)}/callback`,
    name: '',
    clientId: '',
    clientSecret: '',
    authorizationEndpoint: '',
    tokenEndpoint: '',
    userinfoEndpoint: '',
    scopes: ['openid'],
    pkceMode: 'REQUIRED' as const,
    tokenAuthMethod: 'client_secret_basic' as const,
    autoProvisioningEnabled: false,
    mappings: {
      externalUserId: '/id'
    }
  };
}

export function oauthProviderInput(draft: OAuthProviderDraft): object {
  const clientSecret = draft.clientSecret.trim();
  const email = draft.mappings.email?.trim();
  return {
    providerKey: draft.providerKey,
    name: draft.name,
    clientId: draft.clientId,
    ...(clientSecret === '' ? {} : { clientSecret }),
    authorizationEndpoint: draft.authorizationEndpoint,
    tokenEndpoint: draft.tokenEndpoint,
    userinfoEndpoint: draft.userinfoEndpoint,
    scopes: draft.scopes.filter(Boolean),
    pkceMode: draft.pkceMode,
    tokenAuthMethod: draft.tokenAuthMethod,
    autoProvisioningEnabled: draft.autoProvisioningEnabled,
    mappings: {
      externalUserId: draft.mappings.externalUserId,
      ...(email === undefined || email === '' ? {} : { email }),
      ...(draft.mappings.displayName?.trim()
        ? { displayName: draft.mappings.displayName.trim() }
        : {})
    }
  };
}
import { translate } from './locale-preference-service.js';
