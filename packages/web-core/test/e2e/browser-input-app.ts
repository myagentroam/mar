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
browser.frame.value = { viewVersion: 1, width: 800, height: 600 };
browser.path.value = 'relay';
browser.show = async () => {};
const takeover = location.search.includes('takeover');
const requested = ref<{ url: string }>();
const confirmTakeover = () => {
  browser.snapshot.value = { tabs: [], viewVersion: 1, agentControl: 'user' };
};
if (takeover) document.addEventListener('fixture-agent-disconnected', confirmTakeover);
if (takeover)
  document.addEventListener('fixture-open-page', () => {
    requested.value = { url: 'https://example.test/' };
  });
let takeAttempts = 0;
if (takeover) browser.snapshot.value = { tabs: [], viewVersion: 1, agentControl: 'agent' };
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
  if (takeover && message.type === 'agent.control') {
    browser.error.value = undefined;
    if (message.action === 'take') {
      if (++takeAttempts === 1) {
        browser.snapshot.value = {
          tabs: [],
          viewVersion: 1,
          agentControl: 'taking',
          fileChooser: { id: crypto.randomUUID(), multiple: false }
        };
        browser.error.value = 'BROWSER_USE_REVOKE_FAILED';
      } else {
        confirmTakeover();
      }
    } else if (message.action === 'resume') {
      browser.snapshot.value = { tabs: [], viewVersion: 1, agentControl: 'idle' };
    }
  }
  if (message.type === 'input') void fixtureInput(message.action);
  if (takeover && message.type === 'tab.open') document.body.dataset.opened = message.address;
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
  browser.frame.value = { viewVersion: version.value, width: 800, height: 600 };
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
