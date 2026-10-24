import { ref, type Ref } from 'vue';

const STORAGE_KEY = 'mar.markdown-preview';

export interface MarkdownPreviewPreference {
  readonly watermarkEnabled: boolean;
  readonly watermarkText: string;
}

export interface MarkdownPreviewPreferenceService {
  readonly preference: Ref<MarkdownPreviewPreference>;
  save(next: MarkdownPreviewPreference): void;
}

export function parseMarkdownPreviewPreference(value: string | null): MarkdownPreviewPreference {
  try {
    const parsed = JSON.parse(value ?? 'null') as Record<string, unknown> | null;
    return {
      watermarkEnabled: parsed?.watermarkEnabled === true,
      watermarkText: typeof parsed?.watermarkText === 'string' ? parsed.watermarkText : ''
    };
  } catch {
    return { watermarkEnabled: false, watermarkText: '' };
  }
}

export function createMarkdownPreviewPreferenceService(): MarkdownPreviewPreferenceService {
  const preference = ref(parseMarkdownPreviewPreference(localStorage.getItem(STORAGE_KEY)));
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY)
      preference.value = parseMarkdownPreviewPreference(event.newValue);
  });
  return {
    preference,
    save(next) {
      const normalized = {
        watermarkEnabled: next.watermarkEnabled,
        watermarkText: next.watermarkText.trim()
      };
      preference.value = normalized;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    }
  };
}

let shared: MarkdownPreviewPreferenceService | undefined;
export function markdownPreviewPreferenceService(): MarkdownPreviewPreferenceService {
  shared ??= createMarkdownPreviewPreferenceService();
  return shared;
}
