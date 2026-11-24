import { defineComponent, h } from 'vue';
import type { BrowserFindOperation, BrowserFindResult } from '@myagentroam/protocol';
import WorkspaceNodeBrowser from '../../src/view/workbench/WorkspaceNodeBrowser.vue';
import { createWorkbenchBrowserService } from '../../src/service/workbench-browser-service.js';
import { consoleKeyboardShortcutService } from '../../src/service/console-keyboard-shortcut-service.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { createTooltipApp } from './tooltip-app.js';
import '../../src/styles.css';

declare const fixtureFind: (
  operation: BrowserFindOperation
) => Promise<BrowserFindResult | undefined>;

localePreferenceService().setLocale('en-US');
document.addEventListener('keydown', consoleKeyboardShortcutService.handle, { capture: true });
const browser = createWorkbenchBrowserService({
  send: () => false,
  connectionId: () => undefined,
  acquire: () => undefined
});
browser.snapshot.value = {
  activeId: 'fixture',
  tabs: [
    {
      id: 'fixture',
      title: 'Remote fixture',
      url: 'https://example.test/',
      loading: false,
      canGoBack: false,
      canGoForward: false
    }
  ],
  viewVersion: 1
};
browser.status.value = 'ready';
browser.frame.value = { viewVersion: 1, width: 800, height: 600 };
browser.findInPage = (_view, operation) => fixtureFind(operation);
browser.show = async () => {};

createTooltipApp(
  defineComponent({
    setup: () => () =>
      h(WorkspaceNodeBrowser, {
        scope: { nodeId: 'test-node', workspaceId: 'test-workspace' },
        browser,
        connected: false,
        capability: { apiVersion: 1, nodeGeneration: 'fixture', ice: false, find: true }
      })
  })
)
  .use(i18n)
  .mount('#app');
