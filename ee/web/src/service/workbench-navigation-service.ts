import {
  createWorkbenchNavigationService as createSharedNavigation,
  type WorkbenchNavigationService as SharedNavigation
} from '@myagentroam/web-core/navigation';
import type { ManagementSection, SettingsSection, WorkbenchView } from '../model/workbench.js';
import { parseWorkbenchRoute } from '../util/workbench-route.js';

export type WorkbenchNavigationService = SharedNavigation<
  WorkbenchView,
  SettingsSection,
  ManagementSection
>;

export function createWorkbenchNavigationService(): WorkbenchNavigationService {
  const route = parseWorkbenchRoute(window.location);
  return createSharedNavigation<WorkbenchView, SettingsSection, ManagementSection>({
    initialView: route.view ?? 'nodes',
    initialSettingsSection: 'account',
    initialManagementSection: route.managementSection ?? 'users',
    opensMobileSidebar: (view) => view !== 'conversations'
  });
}
