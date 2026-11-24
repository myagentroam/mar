import { createApp, h, ref } from 'vue';
import type { BrowserHistoryItem } from '@myagentroam/protocol';
import BrowserAddressInput from '../../src/view/workbench/BrowserAddressInput.vue';
import { consoleKeyboardShortcutService } from '../../src/service/console-keyboard-shortcut-service.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
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
createApp({
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
})
  .use(i18n)
  .mount('#app');
