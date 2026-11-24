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
browser.snapshot.value = { tabs: [], viewVersion: 1 };
browser.status.value = location.search.includes('offline') ? 'failed' : 'ready';
const viewportSize = { width: 800, height: 600 };
browser.frame.value = { viewVersion: 1, ...viewportSize, raster: viewportSize };
document.addEventListener('fixture-raster-change', () => {
  const frame = browser.frame.value;
  if (frame) browser.frame.value = { ...frame, raster: { width: 640, height: 480 } };
});
browser.path.value = 'relay';
browser.show = async () => {};
const requested = ref<{ url: string }>();
document.addEventListener('fixture-agent-activity', () => {
  browser.snapshot.value = { tabs: [], viewVersion: 1, agentActive: true };
});
document.addEventListener('fixture-open-page', () => {
  requested.value = { url: 'https://example.test/' };
});
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
  if (message.type === 'tab.open') document.body.dataset.opened = message.address;
  if (message.type === 'context.paste') void fixturePaste(message);
  return true;
};
const version = ref(1);
document.addEventListener('fixture-snapshot-ahead', () => {
  browser.snapshot.value = { tabs: [], viewVersion: version.value + 1 };
});
document.addEventListener('fixture-view-change', () => {
  version.value++;
  browser.snapshot.value = {
    tabs: [],
    viewVersion: version.value
  };
  browser.frame.value = { viewVersion: version.value, ...viewportSize, raster: viewportSize };
});
const nativeTouch = !location.search.includes('legacy');
createTooltipApp(
  defineComponent({
    setup: () => () =>
      h(WorkspaceNodeBrowser, {
        scope,
        browser,
        requested: requested.value,
        onConsumed: () => {
          requested.value = undefined;
          document.body.dataset.consumed = 'true';
        },
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
