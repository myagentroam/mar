import { defineAsyncComponent } from 'vue';
import { bootstrapConsole } from '@myagentroam/web-core/bootstrap';
import MarketingHomePage from './view/marketing/MarketingHomePage.vue';
import './service/LocalePreferenceService';
import './styles.css';
import { createEnterpriseManagementComposition } from './composition/enterprise-management';

bootstrapConsole({
  home: MarketingHomePage,
  documentationAvailable: true,
  workbench: defineAsyncComponent(() => import('./view/workbench/WorkbenchPage.vue')),
  filePreview: defineAsyncComponent(
    () => import('@myagentroam/web-core/StandaloneFilePreviewPage.vue')
  ),
  management: createEnterpriseManagementComposition()
});
