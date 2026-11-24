import { defineComponent, h, nextTick, ref } from 'vue';
import type {
  BrowserAttachmentMessage,
  BrowserContextOptions,
  BrowserPageInput
} from '@myagentroam/protocol';
import WorkspaceNodeBrowser from '../../src/view/workbench/WorkspaceNodeBrowser.vue';
import { createWorkbenchBrowserService } from '../../src/service/workbench-browser-service.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { createTooltipApp } from './tooltip-app.js';
import '../../src/styles.css';

declare const fixtureInput: (action: BrowserPageInput) => Promise<void>;
declare const fixtureCopy: () => Promise<string>;
declare const fixtureContext: (
  id: string,
  point?: { x: number; y: number }
) => Promise<BrowserContextOptions | undefined>;
declare const fixturePaste: (
  message: Extract<BrowserAttachmentMessage, { type: 'context.paste' }>
) => Promise<void>;

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
browser.queryContextMenu = async (viewVersion, point) => {
  const id = crypto.randomUUID();
  const options = await fixtureContext(id, point);
  // The real attachment publishes a fresh frame object during menu resolution.
  if (browser.frame.value?.viewVersion === viewVersion)
    browser.frame.value = { ...browser.frame.value };
  return options && { ...options, id, viewVersion };
};
browser.send = (message) => {
  if (message.type === 'input') void fixtureInput(message.action);
  if (message.type === 'context.paste') void fixturePaste(message);
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
        capability: {
          apiVersion: 1,
          nodeGeneration: 'fixture',
          ice: false,
          nativeTouch,
          contextMenu: !location.search.includes('legacy')
        }
      })
  })
)
  .use(i18n)
  .mount('#app');
await nextTick();
const canvas = document.querySelector('canvas')!;
canvas.width = 800;
canvas.height = 600;
