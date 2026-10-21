import { defineAsyncComponent } from 'vue';
import type { AdminState } from '../service/AdminAuthService.js';
import {
  createManagementComposition,
  type ManagementComposition,
  type ManagementPageDefinition
} from '../service/ManagementComposition.js';
import { createCommonManagementPages } from './common-management.js';

function organizationManagementVisible(admin: AdminState): boolean {
  return admin.edition === 'ENTERPRISE' && (admin.role === 'ADMIN' || admin.role === 'ORG_ADMIN');
}

export function createEnterpriseManagementPages(): readonly ManagementPageDefinition[] {
  return [
    {
      id: 'organizations',
      order: 10,
      labelKey: 'navigation.organizations',
      component: defineAsyncComponent(
        () => import('../view/settings/OrganizationManagementPage.vue')
      ),
      visible: organizationManagementVisible,
      props: ({ request, admin }) => ({
        request,
        writable: admin.managementWritable === true
      })
    },
    {
      id: 'users',
      order: 20,
      labelKey: 'navigation.users',
      component: defineAsyncComponent(
        () => import('../view/settings/EnterpriseUserManagementPage.vue')
      ),
      visible: organizationManagementVisible,
      props: ({ request, admin }) => ({
        request,
        writable: admin.managementWritable === true,
        admin: admin.role === 'ADMIN'
      })
    },
    {
      id: 'oauth',
      order: 100,
      labelKey: 'navigation.oauth',
      component: defineAsyncComponent(() => import('../view/settings/OAuthManagementPage.vue')),
      visible: (admin) => admin.edition === 'ENTERPRISE' && admin.role === 'ADMIN',
      props: ({ request, admin }) => ({ request, writable: admin.managementWritable === true })
    },
    {
      id: 'audit',
      order: 120,
      labelKey: 'navigation.audit',
      component: defineAsyncComponent(() => import('../view/settings/AuditManagementPage.vue')),
      visible: organizationManagementVisible,
      props: ({ request }) => ({ request })
    }
  ];
}

export function createEnterpriseManagementComposition(): ManagementComposition {
  return createManagementComposition([
    ...createCommonManagementPages(
      defineAsyncComponent(() => import('../view/settings/LicenseManagementPage.vue'))
    ),
    ...createEnterpriseManagementPages()
  ]);
}
