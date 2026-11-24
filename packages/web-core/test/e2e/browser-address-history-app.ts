import { createApp, h, ref } from 'vue';
import type { BrowserHistoryItem } from '@myagentroam/protocol';
import BrowserAddressInput from '../../src/view/workbench/BrowserAddressInput.vue';
import WorkspaceNodeBrowser from '../../src/view/workbench/WorkspaceNodeBrowser.vue';
import { consoleKeyboardShortcutService } from '../../src/service/console-keyboard-shortcut-service.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { createWorkbenchBrowserService } from '../../src/service/workbench-browser-service.js';
import { createTooltipApp } from './tooltip-app.js';
import '../../src/styles.css';

const draft = ref('');
const context = ref('initial');
const navigation = ref('');
const requested = ref<string[]>([]);
const pending = new Map<string, (items: BrowserHistoryItem[]) => void>();
document.addEventListener('fixture-history-response', (event) => {
  const { text, items } = (event as CustomEvent<{ text: string; items: BrowserHistoryItem[] }>)
    .detail;
  pending.get(text)?.(items);
  pending.delete(text);
});
document.addEventListener('fixture-history-context', () => {
  context.value = 'changed';
});
document.addEventListener('keydown', consoleKeyboardShortcutService.handle, { capture: true });
localePreferenceService().setLocale('en-US');
const workspace = new URLSearchParams(location.search).get('workspace');

function mountWorkspace() {
  const target = { id: crypto.randomUUID(), kind: 'live', persistent: true } as const;
  const browser = createWorkbenchBrowserService({
    send: () => false,
    connectionId: () => undefined,
    acquire: () => undefined
  });
  browser.status.value = 'ready';
  browser.browserId = () => target.id;
  browser.show = async () => {};
  browser.snapshot.value = {
    viewVersion: 1,
    activeId: target.id,
    tabs: [
      {
        id: target.id,
        url: 'https://site.test/',
        title: 'Site',
        loading: false,
        canGoBack: false,
        canGoForward: false
      }
    ]
  };
  browser.profile = async (_scope, command) => {
    if (command.action === 'describe')
      return { profile: target, ...(workspace === 'bounded' ? { historySuggestions: true } : {}) };
    if (command.action !== 'history') throw new Error('Unexpected profile command');
    document.body.dataset.historyQuery = JSON.stringify(command.input);
    return {
      items: Array.from({ length: command.input.suggestions ? 6 : 10 }, (_, index) => ({
        url: `https://site.test/${index}`,
        title: `Page ${index + 1}`,
        visitedAt: 1
      })),
      capped: false
    };
  };
  createTooltipApp({
    setup: () => () =>
      h(WorkspaceNodeBrowser, {
        scope: { nodeId: 'node', workspaceId: 'workspace' },
        browser,
        connected: true,
        capability: { apiVersion: 1, nodeGeneration: 'fixture', ice: false }
      })
  })
    .use(i18n)
    .mount('#app');
}

const addressFixture = {
  setup() {
    return () =>
      h('main', { style: 'margin: 20px; max-width: 500px' }, [
        h(
          'form',
          {
            onSubmit(event: SubmitEvent) {
              event.preventDefault();
              navigation.value = draft.value;
            }
          },
          [
            h(BrowserAddressInput, {
              modelValue: draft.value,
              label: 'Address',
              errorId: 'unused',
              historyContext: context.value,
              lookup(text: string) {
                requested.value = [...requested.value, text];
                if (text === 'failure.test')
                  return Promise.reject(new Error('History unavailable'));
                return new Promise<BrowserHistoryItem[]>((resolve) => pending.set(text, resolve));
              },
              onEdit: (value: string) => (draft.value = value),
              onNavigate: (url: string) => (navigation.value = url)
            })
          ]
        ),
        h('button', { type: 'button' }, 'Outside'),
        h('div', { 'data-testid': 'navigation' }, navigation.value),
        h('div', { 'data-testid': 'requested' }, requested.value.join(','))
      ]);
  }
};

if (workspace) mountWorkspace();
else createApp(addressFixture).use(i18n).mount('#app');
