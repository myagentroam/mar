import { createWorkbenchPageController as createCore } from '@myagentroam/web-core/page-controller';
import { usePwaApplicationService } from '@myagentroam/web-core/pwa-application';
import { createWorkbenchNavigationService } from './workbench-navigation-service.js';
import { useManagementComposition } from './management-composition.js';
import type { ManagementSection } from '../model/workbench.js';
import {
  submitWorkspaceRegistration,
  type WorkspaceRegistrationOwnership as Ownership
} from './workspace-registration-service.js';
type NodeOwnership = Extract<Ownership, { ownerType: 'ORGANIZATION' }>;
export function createWorkbenchPageController() {
  const pwaApplication = usePwaApplicationService();
  return createCore<ManagementSection, Ownership, NodeOwnership>({
    navigation: createWorkbenchNavigationService(),
    management: useManagementComposition(),
    systemManagementSection: 'system',
    nodeManagementSection: 'resource-nodes',
    webVersion: __MAR_WEB_VERSION__,
    pwaApplication,
    submitWorkspaceRegistration,
    submitNodeRegistration: (request, ownership) =>
      request<{ token: string }>('/api/node-registration-tokens', {
        method: 'POST',
        ...(ownership === undefined ? {} : { body: JSON.stringify({ ownership }) })
      })
  });
}
