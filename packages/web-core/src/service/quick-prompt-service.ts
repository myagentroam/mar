import type { Ref } from 'vue';
import type { QuickPrompt } from '../model/workbench.js';

export function createQuickPromptService(options: {
  readonly prompts: Ref<readonly QuickPrompt[]>;
  readonly loading: Ref<boolean>;
  readonly failed: Ref<boolean>;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
}) {
  let inflight: Promise<void> | undefined;

  async function refresh(): Promise<void> {
    if (inflight !== undefined) return inflight;
    options.loading.value = true;
    options.failed.value = false;
    inflight = options
      .request<{ prompts: readonly QuickPrompt[] }>('/api/quick-prompts')
      .then((result) => {
        options.prompts.value = Array.isArray(result.prompts) ? result.prompts : [];
      })
      .catch(() => {
        options.failed.value = true;
      })
      .finally(() => {
        options.loading.value = false;
        inflight = undefined;
      });
    return inflight;
  }

  return { refresh };
}
