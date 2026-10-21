import {
  createEnvironmentSecretService as createCore,
  type EnvironmentSecretSummary as CoreSummary,
  type EnvironmentSecretInput as CoreInput,
  type EnvironmentSecretService as CoreService
} from '@myagentroam/web-core/environment-secrets';
export {
  environmentSecretNameError,
  environmentSecretValueError
} from '@myagentroam/web-core/environment-secrets';
export type EnvironmentSecretScope = 'PERSONAL' | 'ORGANIZATION' | 'NODE' | 'WORKSPACE';
export type OrganizationSecretVisibility = 'PRIVATE' | 'PUBLIC';
export interface EnvironmentSecretSummary extends CoreSummary<EnvironmentSecretScope> {
  readonly organizationId: number | null;
  readonly visibility: OrganizationSecretVisibility | null;
}
export interface EnvironmentSecretInput extends CoreInput<EnvironmentSecretScope> {
  readonly organizationId?: number;
  readonly visibility?: OrganizationSecretVisibility;
}
export type EnvironmentSecretService = CoreService<
  EnvironmentSecretSummary,
  EnvironmentSecretInput
>;
export function createEnvironmentSecretService(
  request: <T>(path: string, init?: RequestInit) => Promise<T>
): EnvironmentSecretService {
  return createCore<EnvironmentSecretSummary, EnvironmentSecretInput>(request);
}
