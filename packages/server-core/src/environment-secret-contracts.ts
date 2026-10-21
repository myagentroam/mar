import type { ManagementPageMetadata } from '@myagentroam/protocol';
export type EnvironmentSecretScope = 'PERSONAL' | 'ORGANIZATION' | 'NODE' | 'WORKSPACE';
export type OrganizationSecretVisibility = 'PRIVATE' | 'PUBLIC';

export interface EnvironmentSecretSummary {
  readonly id: string;
  readonly scope: EnvironmentSecretScope;
  readonly name: string;
  readonly value: string;
  readonly nodeId: string | null;
  readonly workspaceId: string | null;
  readonly organizationId: number | null;
  readonly visibility: OrganizationSecretVisibility | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface EnvironmentSecretActor {
  readonly userId: number;
  readonly isAdmin: boolean;
}
export interface EnvironmentSecretInput {
  readonly scope: EnvironmentSecretScope;
  readonly name: string;
  readonly value: string;
  readonly nodeId?: string;
  readonly workspaceId?: string;
  readonly organizationId?: number;
  readonly visibility?: OrganizationSecretVisibility;
}
export interface EnvironmentSecretOperations {
  listPage?(
    user: EnvironmentSecretActor,
    query: Record<string, unknown>
  ): Promise<ManagementPageMetadata & { readonly secrets: readonly EnvironmentSecretSummary[] }>;

  list(
    user: EnvironmentSecretActor,
    nodeId?: string,
    workspaceId?: string
  ): readonly EnvironmentSecretSummary[] | Promise<readonly EnvironmentSecretSummary[]>;
  create(
    user: EnvironmentSecretActor,
    input: EnvironmentSecretInput
  ): EnvironmentSecretSummary | Promise<EnvironmentSecretSummary>;
  replace(
    user: EnvironmentSecretActor,
    id: string,
    value: string
  ): EnvironmentSecretSummary | Promise<EnvironmentSecretSummary>;
  remove(user: EnvironmentSecretActor, id: string): boolean | Promise<boolean>;
}
