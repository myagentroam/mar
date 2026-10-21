import { ref } from 'vue';
import {
  createSkillCenterService as createCore,
  type SkillSourceCard as CoreSource,
  type SkillFavoriteCard as CoreFavorite,
  type SkillCandidateCard,
  type SkillFavoriteInput,
  type SkillSourceInput
} from '@myagentroam/web-core/skill-center';
export type {
  SkillCandidateCard,
  InstalledSkillCard,
  SkillTargetInspectionCard,
  SkillManagedTargetResources
} from '@myagentroam/web-core/skill-center';
type Scope = 'ENTERPRISE' | 'ORGANIZATION' | 'PERSONAL';
export type SkillSourceCard = CoreSource<Scope>;
export type SkillFavoriteCard = CoreFavorite<Scope>;
export interface SkillOrganizationOption {
  readonly id: number;
  readonly name: string;
  readonly parentOrganizationId: number | null;
}

interface Target {
  readonly scope: Scope;
  readonly organizationId?: number;
}
export function createSkillCatalogSubmissions(
  request: <T>(path: string, init?: RequestInit) => Promise<T>
) {
  return {
    submitFavorite: (input: SkillFavoriteInput, target?: Target) =>
      request('/api/skill-favorites', {
        method: 'POST',
        body: JSON.stringify({
          ...input,
          scope: target?.scope ?? 'PERSONAL',
          ...(target?.scope === 'ORGANIZATION' && target.organizationId !== undefined
            ? { organizationId: target.organizationId }
            : {})
        })
      }),
    submitSource: (input: SkillSourceInput, target?: Target) =>
      request('/api/skill-sources', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'REPOSITORY',
          enabled: true,
          ...input,
          scope: target?.scope ?? 'PERSONAL',
          ...(target?.organizationId === undefined ? {} : { organizationId: target.organizationId })
        })
      })
  };
}
export function createSkillCenterService(
  request: <T>(path: string, init?: RequestInit) => Promise<T>
) {
  const core = createCore<Scope, Target>(request, createSkillCatalogSubmissions(request));
  const organizations = ref<readonly SkillOrganizationOption[]>([]);
  async function loadOrganizations(): Promise<void> {
    organizations.value = (
      await request<{ organizations: readonly SkillOrganizationOption[] }>('/api/organizations')
    ).organizations;
  }
  return {
    ...core,
    organizations,
    loadOrganizations,
    favorite: (
      candidate: SkillCandidateCard,
      scope: Scope = 'PERSONAL',
      organizationId?: number,
      presentation = { featured: false, tags: [] as readonly string[] }
    ) =>
      core.favorite(candidate, presentation, {
        scope,
        ...(organizationId === undefined ? {} : { organizationId })
      }),
    addSource: (input: { name: string; locator: string; scope: Scope; organizationId?: number }) =>
      core.addSource(
        { name: input.name, locator: input.locator },
        {
          scope: input.scope,
          ...(input.organizationId === undefined ? {} : { organizationId: input.organizationId })
        }
      )
  };
}
