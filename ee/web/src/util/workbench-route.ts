import type { ManagementSection } from '../model/workbench.js';
import {
  parseWorkbenchRoute as parseSharedWorkbenchRoute,
  type WorkbenchRoute as SharedWorkbenchRoute
} from '@myagentroam/web-core/workbench-route';
export type { HostedConversationRoute } from '@myagentroam/web-core/workbench-route';

const MANAGEMENT_SECTIONS: readonly ManagementSection[] = [
  'organizations',
  'users',
  'resource-nodes',
  'resource-workspaces',
  'skill-config',
  'skill-sources',
  'mcp-sources',
  'secrets',
  'oauth',
  'mar-agent-models',
  'conversation-templates',
  'audit',
  'configuration',
  'system'
];

export interface WorkbenchRoute extends SharedWorkbenchRoute {
  readonly managementSection?: ManagementSection;
}

export function parseWorkbenchRoute(location: Pick<Location, 'search'>): WorkbenchRoute {
  const route = parseSharedWorkbenchRoute(location);
  const rawManagementSection = new URLSearchParams(location.search).get('management');
  const managementSection = MANAGEMENT_SECTIONS.find(
    (candidate) => candidate === rawManagementSection
  );
  return { ...route, ...(managementSection === undefined ? {} : { managementSection }) };
}
