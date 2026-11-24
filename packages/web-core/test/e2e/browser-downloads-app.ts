import { defineComponent, h, ref } from 'vue';
import type { BrowserDownloadInfo } from '@myagentroam/protocol';
import WorkspaceNodeBrowser from '../../src/view/workbench/WorkspaceNodeBrowser.vue';
import { createWorkbenchBrowserService } from '../../src/service/workbench-browser-service.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { ApiError } from '../../src/util/api-error.js';
import { createTooltipApp } from './tooltip-app.js';
import '../../src/styles.css';

const fixtureLocale = new URLSearchParams(location.search).get('locale');
const negotiateProgress = new URLSearchParams(location.search).has('negotiateProgress');
localePreferenceService().setLocale(fixtureLocale === 'zh-CN' ? 'zh-CN' : 'en-US');
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
  activeCount?: number | null;
  startedCount?: number | null;
  listDelay?: number;
  failList?: boolean;
  failDelete?: boolean;
};
const browserId = ref('browser-a');
const scope = { nodeId: 'test-node', workspaceId: 'test-workspace' };
const capability = {
  apiVersion: 1,
  nodeGeneration: 'fixture',
  ice: false,
  downloadWorkspace: new URLSearchParams(location.search).has('workspaceSave')
};
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
let failList = false;
let failDelete = false;
let listDelay = 0;

function update({
  revision,
  id,
  status,
  items: nextItems,
  activeCount,
  startedCount,
  listDelay: delay,
  failList: listError,
  failDelete: fail
}: Update): void {
  if (id !== undefined) browserId.value = id;
  if (status !== undefined) browser.status.value = status;
  if (nextItems !== undefined) items = nextItems;
  if (listError !== undefined) failList = listError;
  if (fail !== undefined) failDelete = fail;
  if (delay !== undefined) listDelay = delay;
  browser.snapshot.value = {
    activeId: browser.snapshot.value?.activeId ?? tab.id,
    tabs,
    viewVersion: 1,
    downloadVersion: revision,
    startedDownloadCount:
      startedCount === null
        ? undefined
        : (startedCount ?? browser.snapshot.value?.startedDownloadCount),
    activeDownloadCount:
      activeCount === null
        ? undefined
        : (activeCount ?? items.filter(({ state }) => state === 'downloading').length)
  };
}

browser.send = (message) => {
  const snapshot = browser.snapshot.value;
  if (message.type !== 'tab.select' || !snapshot) return false;
  browser.snapshot.value = { ...snapshot, activeId: message.tabId };
  return true;
};
browser.browserId = () => browserId.value;
browser.downloads = async (_offset, signal) => {
  const listed =
    negotiateProgress && browser.snapshot.value?.startedDownloadCount === undefined
      ? items.map(({ receivedBytes: _received, totalBytes: _total, ...item }) => item)
      : items;
  const result = { items: listed, more: false };
  if (listDelay) await new Promise((resolve) => setTimeout(resolve, listDelay));
  signal.throwIfAborted();
  if (failList) throw new Error('Fixture could not list downloads');
  return result;
};
browser.cancelDownload = async (id) => {
  update({
    revision: (browser.snapshot.value?.downloadVersion ?? 0) + 1,
    items: items.map((item) => (item.id === id ? { ...item, state: 'canceled' } : item))
  });
};
browser.deleteDownload = async (id) => {
  if (failDelete) throw new Error('Fixture could not delete download');
  update({
    revision: (browser.snapshot.value?.downloadVersion ?? 0) + 1,
    items: items.filter((item) => item.id !== id)
  });
};
browser.downloadHref = (id) => `/fixture-download/${id}`;
const saved = new Set<string>();
browser.saveDownloadToWorkspace = async (_id, path) => {
  if (path === 'reports/slow.bin') throw new ApiError('BROWSER_OUTCOME_UNKNOWN', 'Not confirmed.');
  if (saved.has(path)) throw new ApiError('FILE_ALREADY_EXISTS', 'File exists.');
  saved.add(path);
};
browser.frame.value = {
  viewVersion: 1,
  width: 800,
  height: 600,
  raster: { width: 800, height: 600 }
};
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
