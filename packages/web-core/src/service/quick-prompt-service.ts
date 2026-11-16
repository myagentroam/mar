import { computed, ref } from 'vue';
import type { QuickPrompt } from '../model/workbench.js';

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
        prompts.value = Array.isArray(result.prompts) ? result.prompts : [];
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
