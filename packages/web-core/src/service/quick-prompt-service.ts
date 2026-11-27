import { computed, ref } from 'vue';
import type { QuickPrompt } from '../model/workbench.js';

// Settings and the Composer share a default order independent of API recency and UI language.
const phraseOrder = new Intl.Collator('en', { sensitivity: 'accent' });

export function createQuickPromptService(options: {
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
}) {
  const prompts = ref<readonly QuickPrompt[]>([]);
  const loading = ref(false);
  const failed = ref(false);
  let inflight: Promise<void> | undefined;

  async function refresh(): Promise<void> {
    if (inflight !== undefined) return inflight;
    loading.value = true;
    failed.value = false;
    const operation = options
      .request<{ prompts: readonly QuickPrompt[] }>('/api/quick-prompts')
      .then((result) => {
        if (inflight !== operation) return;
        // Copy before sorting without requiring toSorted on the Web build's browser baseline.
        prompts.value = Array.isArray(result.prompts)
          ? [...result.prompts].sort((left, right) =>
              phraseOrder.compare(left.phrase, right.phrase)
            )
          : [];
      })
      .catch(() => {
        if (inflight !== operation) return;
        failed.value = true;
      })
      .finally(() => {
        if (inflight !== operation) return;
        loading.value = false;
        inflight = undefined;
      });
    inflight = operation;
    return inflight;
  }

  return {
    clear: () => {
      inflight = undefined;
      prompts.value = [];
      loading.value = false;
      failed.value = false;
    },
    prompts: computed(() => prompts.value),
    loading: computed(() => loading.value),
    failed: computed(() => failed.value),
    refresh
  };
}
