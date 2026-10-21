import { createWorkbenchPageController as createCore } from '@myagentroam/web-core/page-controller';
import { createWorkbenchNavigationService } from './WorkbenchNavigationService.js';
import { useManagementComposition } from './ManagementComposition.js';
import type { ManagementSection } from '../model/workbench.js';
import {
  submitWorkspaceRegistration,
  type WorkspaceRegistrationOwnership as Ownership
} from './WorkspaceRegistrationService.js';
type NodeOwnership = Extract<Ownership, { ownerType: 'ORGANIZATION' }>;
export function createWorkbenchPageController() {
  return createCore<ManagementSection, Ownership, NodeOwnership>({
    navigation: createWorkbenchNavigationService(),
    management: useManagementComposition(),
    systemManagementSection: 'system',
    nodeManagementSection: 'resource-nodes',
    webVersion: __MAR_WEB_VERSION__,
    webBuildHash: __MAR_WEB_BUILD_HASH__,
    submitWorkspaceRegistration,
    submitNodeRegistration: (request, ownership) =>
      request<{ token: string }>('/api/node-registration-tokens', {
        method: 'POST',
        ...(ownership === undefined ? {} : { body: JSON.stringify({ ownership }) })
      })
  });
}
