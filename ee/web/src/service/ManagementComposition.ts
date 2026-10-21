import {
  useManagementComposition as useSharedManagementComposition,
  type ManagementComposition as SharedManagementComposition,
  type ManagementPageDefinition as SharedManagementPageDefinition,
  type ManagementPageProps as SharedManagementPageProps
} from '@myagentroam/web-core/management';
import type { ManagementSection } from '../model/workbench.js';

export {
  MANAGEMENT_COMPOSITION_KEY,
  createManagementComposition,
  type ManagementPageContext
} from '@myagentroam/web-core/management';

export interface ManagementPageProps extends SharedManagementPageProps {
  readonly admin?: boolean;
  readonly edition?: 'COMMUNITY' | 'ENTERPRISE';
  readonly role?: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER' | null;
  readonly organizationId?: number | null;
  readonly mode?: 'organizations' | 'users';
}

export type ManagementPageDefinition = SharedManagementPageDefinition<
  ManagementSection,
  ManagementPageProps
>;
export type ManagementComposition = SharedManagementComposition<
  ManagementSection,
  ManagementPageProps
>;

export function useManagementComposition(): ManagementComposition {
  return useSharedManagementComposition<ManagementSection, ManagementPageProps>();
}
