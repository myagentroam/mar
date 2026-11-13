import { h, ref } from 'vue';
import { createTooltipApp } from './tooltip-app.js';
import WorkspaceFileTabs from '../../src/view/workspace/WorkspaceFileTabs.vue';
import { i18n } from '../../src/service/locale-preference-service.js';
import 'element-plus/dist/index.css';
import '../../src/styles.css';

// Deliberately do not load any file page: the document lock belongs to the public entry.
createTooltipApp({
  setup() {
    const mounted = ref(true);
    return () => [
      h(
        'button',
        { id: 'unmount-empty-window', onClick: () => (mounted.value = false) },
        'Unmount'
      ),
      mounted.value ? h(WorkspaceFileTabs, { tabs: [], presentation: 'window' }) : null
    ];
  }
})
  .use(i18n)
  .mount('#app');
