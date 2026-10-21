import { defineAsyncComponent } from 'vue';
import type { ManagementPageDefinition } from './ManagementComposition.js';
import logoUrl from '../assets/logo-icon.png';
export type CommonManagementSection =
  | 'resource-nodes'
  | 'resource-workspaces'
  | 'skill-config'
  | 'skill-sources'
  | 'mcp-sources'
  | 'secrets'
  | 'mar-agent-models'
  | 'conversation-templates'
  | 'configuration'
  | 'system';
export function createCommonManagementPages(): readonly ManagementPageDefinition<CommonManagementSection>[] {
  return [
    {
      id: 'resource-nodes',
      order: 30,
      labelKey: 'navigation.nodeManagement',
      component: defineAsyncComponent(() => import('../view/settings/NodeManagementPage.vue')),
      visible: () => true,
      props: ({ request, admin }) => ({ request, writable: admin.managementWritable === true })
    },
    {
      id: 'resource-workspaces',
      order: 40,
      labelKey: 'navigation.workspaceManagement',
      component: defineAsyncComponent(() => import('../view/settings/WorkspaceManagementPage.vue')),
      visible: () => true,
      props: ({ request, admin }) => ({ request, writable: admin.managementWritable === true })
    },
    {
      id: 'skill-config',
      order: 50,
      labelKey: 'navigation.skillConfiguration',
      component: defineAsyncComponent(() => import('../view/skill/SkillCenterPage.vue')),
      visible: () => true,
      props: ({ request, nodes }) => ({ request, nodes })
    },
    {
      id: 'skill-sources',
      order: 60,
      labelKey: 'navigation.skillSources',
      component: defineAsyncComponent(() => import('../view/skill/SkillSourceManagementPage.vue')),
      visible: () => true,
      props: ({ request, admin }) => ({ request, writable: admin.managementWritable === true })
    },
    {
      id: 'mcp-sources',
      order: 70,
      labelKey: 'navigation.mcpSources',
      component: defineAsyncComponent(() => import('../view/skill/McpSourceManagementPage.vue')),
      visible: () => true,
      props: ({ request, admin }) => ({ request, writable: admin.managementWritable === true })
    },
    {
      id: 'secrets',
      order: 80,
      labelKey: 'navigation.secrets',
      component: defineAsyncComponent(() => import('../view/settings/SecretManagementPage.vue')),
      visible: () => true,
      props: ({ request, admin }) => ({ request, writable: admin.managementWritable === true })
    },
    {
      id: 'mar-agent-models',
      order: 90,
      labelKey: 'navigation.marAgentModels',
      component: defineAsyncComponent(
        () => import('../view/settings/MarAgentModelManagementPage.vue')
      ),
      visible: () => true,
      props: ({ request, nodes, admin }) => ({
        request,
        nodes,
        writable: admin.managementWritable === true
      })
    },
    {
      id: 'conversation-templates',
      order: 110,
      labelKey: 'navigation.conversationTemplates',
      component: defineAsyncComponent(
        () => import('../view/settings/ConversationTemplateManagementPage.vue')
      ),
      visible: () => true,
      props: ({ request, nodes, admin }) => ({
        request,
        nodes,
        writable: admin.managementWritable === true
      })
    },
    {
      id: 'configuration',
      order: 130,
      labelKey: 'navigation.configuration',
      component: defineAsyncComponent(() => import('../view/settings/SystemConfigurationPage.vue')),
      visible: () => true,
      props: ({ request, admin }) => ({ request, writable: admin.managementWritable === true })
    },
    {
      id: 'system',
      order: 140,
      labelKey: 'navigation.system',
      component: defineAsyncComponent(() => import('../view/SystemInformationPage.vue')),
      visible: () => true,
      props: ({ request, nodes, admin, onlineNodeCount, serverVersion }) => ({
        request,
        authenticated: admin.authenticated,
        logoUrl,
        isAdmin: admin.isAdmin === true,
        onlineNodeCount,
        nodeCount: nodes.length,
        ...(serverVersion === undefined ? {} : { serverVersion })
      })
    }
  ];
}
