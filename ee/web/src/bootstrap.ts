import { defineAsyncComponent } from 'vue';
import { bootstrapConsole } from '@myagentroam/web-core/bootstrap';
import './service/locale-preference-service';
import './styles.css';
import { createEnterpriseManagementComposition } from './composition/enterprise-management';

bootstrapConsole({
  webBuild: { version: __MAR_WEB_VERSION__, buildId: __MAR_WEB_BUILD_HASH__ },
  documentationAvailable: true,
  workbench: defineAsyncComponent(() => import('./view/workbench/WorkbenchPage.vue')),
  filePreview: defineAsyncComponent(
    () => import('@myagentroam/web-core/StandaloneFilePreviewPage.vue')
  ),
  management: createEnterpriseManagementComposition()
});
