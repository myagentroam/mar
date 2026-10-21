import type { Workspace as CoreWorkspace } from '@myagentroam/web-core/workbench-model';
export type * from '@myagentroam/web-core/workbench-model';

export interface Workspace extends CoreWorkspace {
  readonly ownership?:
    | { readonly ownerType: 'PERSONAL'; readonly ownerUserId: number }
    | { readonly ownerType: 'ORGANIZATION'; readonly ownerOrganizationId: number };
}

export type { SettingsSection } from '@myagentroam/web-core/settings-model';
export type ManagementSection =
  | 'organizations'
  | 'users'
  | 'resource-nodes'
  | 'resource-workspaces'
  | 'skill-config'
  | 'skill-sources'
  | 'mcp-sources'
  | 'secrets'
  | 'oauth'
  | 'mar-agent-models'
  | 'conversation-templates'
  | 'audit'
  | 'configuration'
  | 'system';
export type { WorkbenchView } from '@myagentroam/web-core/workbench-route';
