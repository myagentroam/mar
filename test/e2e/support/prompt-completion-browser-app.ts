import { createApp, reactive, ref } from 'vue';
import { ElButton } from '../../../packages/web-core/test/support/element-plus-button.js';
import '../../../packages/web-core/src/styles.css';
import { localePreferenceService } from '../../../packages/web-core/src/service/LocalePreferenceService.js';
import ConversationComposer from '../../../packages/web-core/src/view/composer/ConversationComposer.vue';
import type { CompletionDraft } from '../../../packages/web-core/src/service/PromptCompletionService.js';

localePreferenceService().setLocale(
  new URLSearchParams(location.search).get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US'
);

interface PromptCompletionHarness {
  readonly requests: {
    readonly contextKey: string;
    readonly draft: CompletionDraft;
    readonly trigger: string;
    aborted: boolean;
  }[];
  signal(key: string): void;
  signalTerminal(key: string): void;
  reviseContext(key: string): void;
  selectContext(key: string, automaticKey?: string | null, terminalKey?: string | null): void;
  restoreFocus(): void;
  foreground(visible: boolean, focused: boolean): void;
  submissions: number;
  interrupts: number;
  parentKeydowns: number;
  resolve(index: number, suggestion: string | null): void;
}

declare global {
  interface Window {
    __promptCompletionHarness: PromptCompletionHarness;
  }
}

const resolvers: ((response: object) => void)[] = [];
const harness: PromptCompletionHarness = {
  requests: [],
  signal(key) {
    completion.automaticKey = key;
  },
  signalTerminal(key) {
    completion.automaticTerminalKey = key;
    completion.automaticKey = key ? `terminal-reply:${key}` : '';
  },
  selectContext(key, automaticKey = 'loaded-history', terminalKey = '') {
    completion.contextKey = key;
    completion.automaticKey = automaticKey ?? undefined;
    completion.automaticTerminalKey = terminalKey ?? undefined;
  },
  reviseContext(key) {
    completion.contextRevision = key;
  },
  restoreFocus() {},
  foreground(visible, focused) {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: visible ? 'visible' : 'hidden'
    });
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event(focused ? 'focus' : 'blur'));
  },
  submissions: 0,
  interrupts: 0,
  parentKeydowns: 0,
  resolve(index, suggestion) {
    const request = harness.requests[index];
    const resolveRequest = resolvers[index];
    if (request === undefined || resolveRequest === undefined)
      throw new Error(`No prompt completion request at index ${index}`);
    resolveRequest({
      requestId: `fixture-${index + 1}`,
      contextVersion: 'fixture-context',
      historyGeneration: 'fixture-history',
      draftRevision: index + 1,
      cursorPosition: request.draft.cursor,
      status: suggestion === null ? 'empty' : 'ready',
      suggestion,
      source: 'generated',
      expiresAt: Date.now() + 60_000
    });
  }
};
window.__promptCompletionHarness = harness;

const completion = reactive({
  enabled: new URLSearchParams(location.search).get('enabled') !== '0',
  contextKey: 'prompt-completion-browser-fixture',
  contextRevision: 'initial',
  readContextRevision: (): string => completion.contextRevision,
  automaticKey: new URLSearchParams(location.search).get('automatic') === '0' ? undefined : '',
  automaticTerminalKey:
    new URLSearchParams(location.search).get('automatic') === '0' ? undefined : '',
  request(
    draft: CompletionDraft,
    signal: AbortSignal,
    _attention?: unknown,
    trigger = 'MANUAL'
  ): Promise<object> {
    const request = {
      contextKey: completion.contextKey,
      draft: { ...draft },
      trigger,
      aborted: false
    };
    const index = harness.requests.push(request) - 1;
    return new Promise((resolve) => {
      resolvers[index] = resolve;
      signal.addEventListener('abort', () => (request.aborted = true), { once: true });
    });
  }
});

const app = createApp({
  components: { ConversationComposer },
  setup() {
    const input = ref('');
    const composer = ref<{ focus(): void }>();
    harness.restoreFocus = () => composer.value?.focus();
    return {
      composer,
      completion,
      input,
      onKeydown() {
        harness.parentKeydowns++;
      },
      onSubmit() {
        harness.submissions++;
      }
    };
  },
  template: `
    <main>
      <button type="button" data-testid="before-composer">Before composer</button>
      <ConversationComposer
        ref="composer"
        v-model:input="input"
        placeholder="Fixture message placeholder"
        :working="false"
        working-label="Working"
        :readonly="false"
        :drop-target="false"
        :mobile-viewport="false"
        :command-states="[]"
        :loading="false"
        :skill-tokens="[]"
        :completion="completion"
        @keydown="onKeydown"
        @submit="onSubmit"
      >
        <template #toolbar>
          <button type="submit" data-testid="send-message">Send</button>
        </template>
      </ConversationComposer>
      <button type="button" data-testid="after-composer">After composer</button>
    </main>
  `
});

app.component('ElButton', ElButton).mount('#app');
