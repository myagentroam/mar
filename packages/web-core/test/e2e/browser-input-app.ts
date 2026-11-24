import { defineComponent, h, nextTick, ref } from 'vue';
import type { BrowserPageInput } from '@myagentroam/protocol';
import WorkspaceNodeBrowser from '../../src/view/workbench/WorkspaceNodeBrowser.vue';
import { createWorkbenchBrowserService } from '../../src/service/workbench-browser-service.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { createTooltipApp } from './tooltip-app.js';
import '../../src/styles.css';

declare const fixtureInput: (action: BrowserPageInput) => Promise<void>;
declare const fixtureCopy: () => Promise<string>;

localePreferenceService().setLocale('en-US');
const scope = { nodeId: 'test-node', workspaceId: 'test-workspace' };
const browser = createWorkbenchBrowserService({
  send: () => false,
  connectionId: () => undefined,
  acquire: () => undefined
});
browser.status.value = 'ready';
browser.frame.value = { viewVersion: 1, width: 800, height: 600 };
browser.path.value = 'relay';
browser.show = async () => {};
browser.copySelection = () => fixtureCopy();
browser.send = (message) => {
  if (message.type === 'input') void fixtureInput(message.action);
  return true;
};
const version = ref(1);
document.addEventListener('fixture-view-change', () => {
  version.value++;
  browser.snapshot.value = {
    tabs: [],
    viewVersion: version.value
  };
  browser.frame.value = { viewVersion: version.value, width: 800, height: 600 };
});
const nativeTouch = !location.search.includes('legacy');
createTooltipApp(
  defineComponent({
    setup: () => () =>
      h(WorkspaceNodeBrowser, {
        scope,
        browser,
        connected: false,
        capability: { apiVersion: 1, nodeGeneration: 'fixture', ice: false, nativeTouch }
      })
  })
)
  .use(i18n)
  .mount('#app');
await nextTick();
const canvas = document.querySelector('canvas')!;
canvas.width = 800;
canvas.height = 600;
