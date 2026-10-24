import LoadingPanel from '@myagentroam/web-core/LoadingPanel.vue';
import { translate } from '@myagentroam/web-core/locale';
import { defineAsyncComponent, h, type Component } from 'vue';
import type { AdminState } from '../service/admin-auth-service.js';
import type { ManagementPageDefinition } from '../service/management-composition.js';
import {
  createCommonManagementPages as createSharedPages,
  type CommonManagementSection
} from '@myagentroam/web-core/common-management';
import logoUrl from '@myagentroam/web-core/assets/logo-icon.png';

const loadingComponent = {
  render: () =>
    h(LoadingPanel, { loading: true, variant: 'page', 'aria-label': translate('common.loading') })
};

function resourceManagementVisible(admin: AdminState): boolean {
  return admin.edition !== 'ENTERPRISE' || admin.role === 'ADMIN' || admin.role === 'ORG_ADMIN';
}

export function createCommonManagementPages(
  systemInformationExtension?: Component
): readonly ManagementPageDefinition[] {
  const extensions: Record<
    CommonManagementSection,
    Pick<ManagementPageDefinition, 'component' | 'visible' | 'props'>
  > = {
    'conversation-templates': {
      component: defineAsyncComponent({
        loader: () => import('../view/settings/ConversationTemplateManagementPage.vue'),
        loadingComponent,
        delay: 0
      }),
      visible: (admin) => admin.edition !== 'ENTERPRISE' || admin.role === 'ADMIN',
      props: ({ request, nodes, admin }) => ({
        request,
        nodes,
        edition: admin.edition ?? 'COMMUNITY',
        writable: admin.managementWritable === true
      })
    },
    'resource-nodes': {
      component: defineAsyncComponent({
        loader: () => import('../view/settings/NodeManagementPage.vue'),
        loadingComponent,
        delay: 0
      }),
      visible: resourceManagementVisible,
      props: ({ request, admin }) => ({
        request,
        writable: admin.managementWritable === true,
        edition: admin.edition ?? 'COMMUNITY',
        role: admin.role ?? null
      })
    },
    'resource-workspaces': {
      component: defineAsyncComponent({
        loader: () => import('../view/settings/WorkspaceManagementPage.vue'),
        loadingComponent,
        delay: 0
      }),
      visible: resourceManagementVisible,
      props: ({ request, admin }) => ({
        request,
        writable: admin.managementWritable === true,
        edition: admin.edition ?? 'COMMUNITY',
        role: admin.role ?? null
      })
    },
    'skill-config': {
      component: defineAsyncComponent({
        loader: () => import('../view/skill/SkillCenterPage.vue'),
        loadingComponent,
        delay: 0
      }),
      visible: () => true,
      props: ({ request, nodes }) => ({ request, nodes })
    },
    'skill-sources': {
      component: defineAsyncComponent({
        loader: () => import('../view/skill/SkillSourceManagementPage.vue'),
        loadingComponent,
        delay: 0
      }),
      visible: () => true,
      props: ({ request, admin }) => ({
        request,
        writable: admin.managementWritable !== false,
        edition: admin.edition ?? 'COMMUNITY',
        role: admin.role ?? null
      })
    },
    'mcp-sources': {
      component: defineAsyncComponent({
        loader: () => import('../view/skill/McpSourceManagementPage.vue'),
        loadingComponent,
        delay: 0
      }),
      visible: () => true,
      props: ({ request, admin }) => ({
        request,
        writable: admin.managementWritable !== false,
        edition: admin.edition ?? 'COMMUNITY',
        role: admin.role ?? null
      })
    },
    secrets: {
      component: defineAsyncComponent({
        loader: () => import('../view/settings/SecretManagementPage.vue'),
        loadingComponent,
        delay: 0
      }),
      visible: () => true,
      props: ({ request, admin }) => ({
        request,
        writable: admin.managementWritable !== false,
        edition: admin.edition ?? 'COMMUNITY',
        role: admin.role ?? null
      })
    },
    'mar-agent-models': {
      component: defineAsyncComponent({
        loader: () => import('../view/settings/MarAgentModelManagementPage.vue'),
        loadingComponent,
        delay: 0
      }),
      visible: () => true,
      props: ({ request, nodes, admin }) => ({
        request,
        nodes,
        writable: admin.managementWritable === true,
        edition: admin.edition ?? 'COMMUNITY',
        role: admin.role ?? null,
        organizationId: admin.organizationId ?? null
      })
    },
    configuration: {
      component: defineAsyncComponent({
        loader: () => import('../view/settings/SystemConfigurationPage.vue'),
        loadingComponent,
        delay: 0
      }),
      visible: (admin) => admin.edition !== 'ENTERPRISE' || admin.role === 'ADMIN',
      props: ({ request, admin }) => ({
        request,
        writable: admin.managementWritable === true
      })
    },
    system: {
      component: defineAsyncComponent({
        loader: () => import('@myagentroam/web-core/SystemInformationPage.vue'),
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
        ...(serverVersion === undefined ? {} : { serverVersion }),
        ...(systemInformationExtension === undefined
          ? {}
          : { extension: systemInformationExtension })
      })
    }
  };
  return createSharedPages().map((page) => ({ ...page, ...extensions[page.id] }));
}
