import { defineAsyncComponent, type Component } from 'vue';
import type { AdminState } from '../service/AdminAuthService.js';
import type { ManagementPageDefinition } from '../service/ManagementComposition.js';
import {
  createCommonManagementPages as createSharedPages,
  type CommonManagementSection
} from '@myagentroam/web-core/common-management';
import logoUrl from '@myagentroam/web-core/assets/logo-icon.png';

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
      component: defineAsyncComponent(
        () => import('../view/settings/ConversationTemplateManagementPage.vue')
      ),
      visible: (admin) => admin.edition !== 'ENTERPRISE' || admin.role === 'ADMIN',
      props: ({ request, nodes, admin }) => ({
        request,
        nodes,
        edition: admin.edition ?? 'COMMUNITY',
        writable: admin.managementWritable === true
      })
    },
    'resource-nodes': {
      component: defineAsyncComponent(() => import('../view/settings/NodeManagementPage.vue')),
      visible: resourceManagementVisible,
      props: ({ request, admin }) => ({
        request,
        writable: admin.managementWritable === true,
        edition: admin.edition ?? 'COMMUNITY',
        role: admin.role ?? null
      })
    },
    'resource-workspaces': {
      component: defineAsyncComponent(() => import('../view/settings/WorkspaceManagementPage.vue')),
      visible: resourceManagementVisible,
      props: ({ request, admin }) => ({
        request,
        writable: admin.managementWritable === true,
        edition: admin.edition ?? 'COMMUNITY',
        role: admin.role ?? null
      })
    },
    'skill-config': {
      component: defineAsyncComponent(() => import('../view/skill/SkillCenterPage.vue')),
      visible: () => true,
      props: ({ request, nodes }) => ({ request, nodes })
    },
    'skill-sources': {
      component: defineAsyncComponent(() => import('../view/skill/SkillSourceManagementPage.vue')),
      visible: () => true,
      props: ({ request, admin }) => ({
        request,
        writable: admin.managementWritable !== false,
        edition: admin.edition ?? 'COMMUNITY',
        role: admin.role ?? null
      })
    },
    'mcp-sources': {
      component: defineAsyncComponent(() => import('../view/skill/McpSourceManagementPage.vue')),
      visible: () => true,
      props: ({ request, admin }) => ({
        request,
        writable: admin.managementWritable !== false,
        edition: admin.edition ?? 'COMMUNITY',
        role: admin.role ?? null
      })
    },
    secrets: {
      component: defineAsyncComponent(() => import('../view/settings/SecretManagementPage.vue')),
      visible: () => true,
      props: ({ request, admin }) => ({
        request,
        writable: admin.managementWritable !== false,
        edition: admin.edition ?? 'COMMUNITY',
        role: admin.role ?? null
      })
    },
    'mar-agent-models': {
      component: defineAsyncComponent(
        () => import('../view/settings/MarAgentModelManagementPage.vue')
      ),
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
      component: defineAsyncComponent(() => import('../view/settings/SystemConfigurationPage.vue')),
      visible: (admin) => admin.edition !== 'ENTERPRISE' || admin.role === 'ADMIN',
      props: ({ request, admin }) => ({
        request,
        writable: admin.managementWritable === true
      })
    },
    system: {
      component: defineAsyncComponent(
        () => import('@myagentroam/web-core/SystemInformationPage.vue')
      ),
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
