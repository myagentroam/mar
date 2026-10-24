import LoadingPanel from '@myagentroam/web-core/LoadingPanel.vue';
import { translate } from '@myagentroam/web-core/locale';
import { defineAsyncComponent, h } from 'vue';
import type { AdminState } from '../service/admin-auth-service.js';
import {
  createManagementComposition,
  type ManagementComposition,
  type ManagementPageDefinition
} from '../service/management-composition.js';
import { createCommonManagementPages } from './common-management.js';

const loadingComponent = {
  render: () =>
    h(LoadingPanel, { loading: true, variant: 'page', 'aria-label': translate('common.loading') })
};

function organizationManagementVisible(admin: AdminState): boolean {
  return admin.edition === 'ENTERPRISE' && (admin.role === 'ADMIN' || admin.role === 'ORG_ADMIN');
}

export function createEnterpriseManagementPages(): readonly ManagementPageDefinition[] {
  return [
    {
      id: 'organizations',
      order: 10,
      labelKey: 'navigation.organizations',
      component: defineAsyncComponent({
        loader: () => import('../view/settings/OrganizationManagementPage.vue'),
        loadingComponent,
        delay: 0
      }),
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
      component: defineAsyncComponent({
        loader: () => import('../view/settings/EnterpriseUserManagementPage.vue'),
        loadingComponent,
        delay: 0
      }),
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
      component: defineAsyncComponent({
        loader: () => import('../view/settings/OAuthManagementPage.vue'),
        loadingComponent,
        delay: 0
      }),
      visible: (admin) => admin.edition === 'ENTERPRISE' && admin.role === 'ADMIN',
      props: ({ request, admin }) => ({ request, writable: admin.managementWritable === true })
    },
    {
      id: 'audit',
      order: 120,
      labelKey: 'navigation.audit',
      component: defineAsyncComponent({
        loader: () => import('../view/settings/AuditManagementPage.vue'),
        loadingComponent,
        delay: 0
      }),
      visible: organizationManagementVisible,
      props: ({ request }) => ({ request })
    }
  ];
}

export function createEnterpriseManagementComposition(): ManagementComposition {
  return createManagementComposition([
    ...createCommonManagementPages(
      defineAsyncComponent({
        loader: () => import('../view/settings/LicenseManagementPage.vue'),
        loadingComponent,
        delay: 0
      })
    ),
    ...createEnterpriseManagementPages()
  ]);
}
