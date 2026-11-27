import { h } from 'vue';
import BrowserHistoryDialog from '../../src/view/workbench/BrowserHistoryDialog.vue';
import { createWorkbenchBrowserService } from '../../src/service/workbench-browser-service.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { createTooltipApp } from './tooltip-app.js';
import '../../src/styles.css';

localePreferenceService().setLocale('en-US');
const scope = { nodeId: 'history-node', workspaceId: 'history-workspace' };
const profile = { id: '57fd173b-d545-4a6f-823b-945462de9b21', kind: 'live', persistent: true };
const browser = createWorkbenchBrowserService({
  send: () => false,
  connectionId: () => undefined
});
let items = Array.from({ length: 32 }, (_, i) => ({
  url: `https://example.test/${i + 1}`,
  title: i < 30 ? `First page ${i + 1}` : `Second page ${i - 29}`,
  visitedAt: Date.UTC(2026, 0, 15, 12) - i * 60_000
}));
browser.profile = async (_, request) => {
  if (request.action === 'describe') return { profile };
  if (request.action === 'history') {
    return {
      items: items.filter((item) => item.title.toLowerCase().includes(request.input.text)),
      capped: false
    };
  }
  if (request.action === 'delete') {
    items = items.filter((item) => !request.input.includes(item.url));
    return {};
  }
  throw new Error(`Unexpected history fixture request: ${request.action}`);
};

createTooltipApp({
  render: () =>
    h(BrowserHistoryDialog, {
      scope,
      scopeLabel: 'History workspace',
      expectedLiveId: profile.id,
      browser,
      connected: true
    })
})
  .use(i18n)
  .mount('#app');
