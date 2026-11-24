import { defineComponent, h, ref } from 'vue';
import type { BrowserDownloadInfo } from '@myagentroam/protocol';
import WorkspaceNodeBrowser from '../../src/view/workbench/WorkspaceNodeBrowser.vue';
import { createWorkbenchBrowserService } from '../../src/service/workbench-browser-service.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { createTooltipApp } from './tooltip-app.js';
import '../../src/styles.css';

localePreferenceService().setLocale('en-US');
const browser = createWorkbenchBrowserService({
  send: () => false,
  connectionId: () => undefined,
  acquire: () => undefined
});
type Update = {
  revision: number;
  id?: string;
  status?: typeof browser.status.value;
  items?: BrowserDownloadInfo[];
};
const browserId = ref('browser-a');
const scope = { nodeId: 'test-node', workspaceId: 'test-workspace' };
const capability = { apiVersion: 1, nodeGeneration: 'fixture', ice: false };
const tab = {
  id: 'test-tab',
  url: 'https://example.test/',
  title: 'Downloads fixture',
  loading: false,
  canGoBack: false,
  canGoForward: false
};
const tabs = [tab, { ...tab, id: 'second-tab', title: 'Second page' }];
let items: BrowserDownloadInfo[] = [];

function update({ revision, id, status, items: nextItems }: Update): void {
  if (id !== undefined) browserId.value = id;
  if (status !== undefined) browser.status.value = status;
  if (nextItems !== undefined) items = nextItems;
  browser.snapshot.value = {
    activeId: browser.snapshot.value?.activeId ?? tab.id,
    tabs,
    viewVersion: 1,
    downloadVersion: revision
  };
}

browser.send = (message) => {
  const snapshot = browser.snapshot.value;
  if (message.type !== 'tab.select' || !snapshot) return false;
  browser.snapshot.value = { ...snapshot, activeId: message.tabId };
  return true;
};
browser.browserId = () => browserId.value;
browser.downloads = async () => ({ items, more: false });
browser.cancelDownload = async (id) => {
  update({
    revision: (browser.snapshot.value?.downloadVersion ?? 0) + 1,
    items: items.map((item) => (item.id === id ? { ...item, state: 'canceled' } : item))
  });
};
browser.downloadHref = (id) => `/fixture-download/${id}`;
browser.frame.value = { viewVersion: 1, width: 800, height: 600 };
update({ revision: 4, status: 'ready' });
document.addEventListener('fixture-download-update', (event) =>
  update((event as CustomEvent<Update>).detail)
);
createTooltipApp(
  defineComponent({
    setup: () => () => h(WorkspaceNodeBrowser, { scope, browser, connected: false, capability })
  })
)
  .use(i18n)
  .mount('#app');
