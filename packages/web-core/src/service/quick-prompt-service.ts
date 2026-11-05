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
    inflight = options
      .request<{ prompts: readonly QuickPrompt[] }>('/api/quick-prompts')
      .then((result) => {
        prompts.value = Array.isArray(result.prompts) ? result.prompts : [];
      })
      .catch(() => {
        failed.value = true;
      })
      .finally(() => {
        loading.value = false;
        inflight = undefined;
      });
    return inflight;
  }

  return {
    prompts: computed(() => prompts.value),
    loading: computed(() => loading.value),
    failed: computed(() => failed.value),
    refresh
  };
}
