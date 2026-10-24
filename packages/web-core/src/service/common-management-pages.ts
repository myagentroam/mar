import LoadingPanel from '../view/common/LoadingPanel.vue';
import { translate } from './locale-preference-service.js';
import { defineAsyncComponent, h } from 'vue';
import type { ManagementPageDefinition } from './management-composition.js';
import logoUrl from '../assets/logo-icon.png';

const loadingComponent = {
  render: () =>
    h(LoadingPanel, { loading: true, variant: 'page', 'aria-label': translate('common.loading') })
};

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
      component: defineAsyncComponent({
        loader: () => import('../view/settings/NodeManagementPage.vue'),
        loadingComponent,
        delay: 0
      }),
      visible: () => true,
      props: ({ request, admin }) => ({ request, writable: admin.managementWritable === true })
    },
    {
      id: 'resource-workspaces',
      order: 40,
      labelKey: 'navigation.workspaceManagement',
      component: defineAsyncComponent({
        loader: () => import('../view/settings/WorkspaceManagementPage.vue'),
        loadingComponent,
        delay: 0
      }),
      visible: () => true,
      props: ({ request, admin }) => ({ request, writable: admin.managementWritable === true })
    },
    {
      id: 'skill-config',
      order: 50,
      labelKey: 'navigation.skillConfiguration',
      component: defineAsyncComponent({
        loader: () => import('../view/skill/SkillCenterPage.vue'),
        loadingComponent,
        delay: 0
      }),
      visible: () => true,
      props: ({ request, nodes }) => ({ request, nodes })
    },
    {
      id: 'skill-sources',
      order: 60,
      labelKey: 'navigation.skillSources',
      component: defineAsyncComponent({
        loader: () => import('../view/skill/SkillSourceManagementPage.vue'),
        loadingComponent,
        delay: 0
      }),
      visible: () => true,
      props: ({ request, admin }) => ({ request, writable: admin.managementWritable === true })
    },
    {
      id: 'mcp-sources',
      order: 70,
      labelKey: 'navigation.mcpSources',
      component: defineAsyncComponent({
        loader: () => import('../view/skill/McpSourceManagementPage.vue'),
        loadingComponent,
        delay: 0
      }),
      visible: () => true,
      props: ({ request, admin }) => ({ request, writable: admin.managementWritable === true })
    },
    {
      id: 'secrets',
      order: 80,
      labelKey: 'navigation.secrets',
      component: defineAsyncComponent({
        loader: () => import('../view/settings/SecretManagementPage.vue'),
        loadingComponent,
        delay: 0
      }),
      visible: () => true,
      props: ({ request, admin }) => ({ request, writable: admin.managementWritable === true })
    },
    {
      id: 'mar-agent-models',
      order: 90,
      labelKey: 'navigation.marAgentModels',
      component: defineAsyncComponent({
        loader: () => import('../view/settings/MarAgentModelManagementPage.vue'),
        loadingComponent,
        delay: 0
      }),
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
      component: defineAsyncComponent({
        loader: () => import('../view/settings/ConversationTemplateManagementPage.vue'),
        loadingComponent,
        delay: 0
      }),
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
      component: defineAsyncComponent({
        loader: () => import('../view/settings/SystemConfigurationPage.vue'),
        loadingComponent,
        delay: 0
      }),
      visible: () => true,
      props: ({ request, admin }) => ({ request, writable: admin.managementWritable === true })
    },
    {
      id: 'system',
      order: 140,
      labelKey: 'navigation.system',
      component: defineAsyncComponent({
        loader: () => import('../view/SystemInformationPage.vue'),
        loadingComponent,
        delay: 0
      }),
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
