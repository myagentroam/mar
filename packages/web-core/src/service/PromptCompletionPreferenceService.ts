import { readonly, shallowRef } from 'vue';

export const PROMPT_COMPLETION_STORAGE_KEY = 'mar.prompt-completion.enabled';

export function createPromptCompletionPreferenceService() {
  let stored = true;
  try {
    stored = localStorage.getItem(PROMPT_COMPLETION_STORAGE_KEY) !== 'false';
  } catch {
    // Use the product default when browser preferences are unavailable.
  }
  const enabled = shallowRef(stored);
  return {
    enabled: readonly(enabled),
    setEnabled(value: boolean) {
      localStorage.setItem(PROMPT_COMPLETION_STORAGE_KEY, String(value));
      enabled.value = value;
    }
  };
}

let shared: ReturnType<typeof createPromptCompletionPreferenceService> | undefined;

export function promptCompletionPreferenceService() {
  shared ??= createPromptCompletionPreferenceService();
  return shared;
}
