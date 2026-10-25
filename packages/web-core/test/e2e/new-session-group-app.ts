import { defineComponent, h, proxyRefs } from 'vue';
import { bootstrapConsole } from '../../src/bootstrap.js';
import WorkbenchPage from '../../src/view/workbench/WorkbenchPage.vue';
import { createWorkbenchPageController } from '../../src/service/workbench-page-controller.js';
import { createWorkbenchNavigationService } from '../../src/service/workbench-navigation-service.js';
import type { ManagementComposition } from '../../src/service/management-composition.js';
import type { SettingsSection } from '../../src/model/settings.js';
import type { WorkbenchView } from '../../src/util/workbench-route.js';

// Real core page and lifecycle; browser tests supply the Node/Server HTTP and Watch boundaries.
const management: ManagementComposition = {
  items: () => [],
  resolve: () => {
    throw new Error('Management is outside this fixture');
  }
};
const workbench = defineComponent({
  setup() {
    const page = proxyRefs(
      createWorkbenchPageController({
        navigation: createWorkbenchNavigationService<WorkbenchView, SettingsSection, string>({
          initialView: 'nodes',
          initialSettingsSection: 'account',
          initialManagementSection: 'system',
          opensMobileSidebar: (view) => view === 'nodes'
        }),
        management,
        systemManagementSection: 'system',
        nodeManagementSection: 'system',
        webVersion: '0.11.19',
        webBuildHash: 'fixture'
      })
    );
    return () => h(WorkbenchPage<string, void, void>, { page });
  }
});
bootstrapConsole({ workbench, filePreview: defineComponent(() => () => null), management });
