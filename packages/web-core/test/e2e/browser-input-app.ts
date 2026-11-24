import { defineComponent, h, nextTick, ref } from 'vue';
import type {
  BrowserAttachmentMessage,
  BrowserContextOptions,
  BrowserPageInput
} from '@myagentroam/protocol';
import WorkspaceNodeBrowser from '../../src/view/workbench/WorkspaceNodeBrowser.vue';
import { createWorkbenchBrowserService } from '../../src/service/workbench-browser-service.js';
import { consoleKeyboardShortcutService } from '../../src/service/console-keyboard-shortcut-service.js';
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

const fixtureOptions = new URLSearchParams(location.search);
localePreferenceService().setLocale(fixtureOptions.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US');
document.addEventListener('keydown', consoleKeyboardShortcutService.handle, { capture: true });
const scope = { nodeId: 'test-node', workspaceId: 'test-workspace' };
const browser = createWorkbenchBrowserService({
  send: () => false,
  connectionId: () => undefined,
  acquire: () => undefined
});
browser.snapshot.value = { tabs: [], viewVersion: 1 };
if (fixtureOptions.has('zoom')) {
  browser.snapshot.value = {
    viewVersion: 1,
    tabControls: { zoom: 100, reopen: false },
    activeId: 'page',
    tabs: [
      {
        id: 'page',
        url: 'https://example.test/',
        title: 'Example page',
        loading: false,
        canGoBack: false,
        canGoForward: false
      }
    ]
  };
}
if (fixtureOptions.has('close-pages')) {
  browser.snapshot.value = {
    activeId: 'first',
    viewVersion: 1,
    tabs: ['first', 'last'].map((id) => ({
      id,
      title: id,
      url: `https://example.test/${id}`,
      loading: false,
      canGoBack: false,
      canGoForward: false
    }))
  };
  document.addEventListener('fixture-close-page', () => {
    const current = browser.snapshot.value;
    if (!current) return;
    const tabs = current.tabs.filter(({ id }) => id !== document.body.dataset.closePage);
    const activeId = tabs[0]?.id;
    browser.snapshot.value = {
      tabs,
      ...(activeId === undefined ? {} : { activeId }),
      viewVersion: current.viewVersion + 1
    };
  });
}
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
  if (message.type === 'tab.close') document.body.dataset.closePage = message.tabId;
  if (message.type === 'context.paste') void fixturePaste(message);
  if (message.type === 'page.zoom') {
    const snapshot = browser.snapshot.value;
    const current = snapshot?.tabControls;
    if (snapshot && current && snapshot.viewVersion === message.viewVersion) {
      const levels = [50, 67, 80, 90, 100, 110, 125, 150, 175, 200];
      const step = levels.indexOf(current.zoom) + (message.direction === 'in' ? 1 : -1);
      const zoom = message.direction === 'reset' ? 100 : (levels[step] ?? current.zoom);
      browser.snapshot.value = { ...snapshot, tabControls: { ...current, zoom } };
    }
  }
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
        onClosed: () => {
          document.body.dataset.browserClosed = 'true';
        },
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
