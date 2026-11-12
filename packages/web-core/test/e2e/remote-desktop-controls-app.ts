import { createApp, h } from 'vue';
import RemoteDesktopPage from '../../src/view/remote-desktop/RemoteDesktopPage.vue';
import SharedTooltipHost from '../../src/view/common/SharedTooltipHost.vue';
import { i18n } from '../../src/service/locale-preference-service.js';
import { tooltipPlugin } from '../../src/directive/tooltip.js';
import { createThemePreferenceService } from '../../src/service/theme-preference-service.js';
import '../../src/styles.css';

document.documentElement.classList.add('console-ui');
createThemePreferenceService();
createApp({
  render: () => [h(RemoteDesktopPage, { nodeId: 'node-a-internal-id' }), h(SharedTooltipHost)]
})
  .use(i18n)
  .use(tooltipPlugin)
  .mount('#app');
