import { ref, type Ref } from 'vue';
import type { IconThemeId } from '../icon-themes/index.js';

export const ICON_THEME_STORAGE_KEY = 'mar.icon-theme';

export interface IconThemePreferenceService {
  readonly theme: Ref<IconThemeId>;
  setTheme(theme: IconThemeId): void;
}

export function parseStoredIconThemePreference(value: string | null): IconThemeId {
  return value === 'seti' ? 'seti' : 'material';
}

export function createIconThemePreferenceService(): IconThemePreferenceService {
  const theme = ref<IconThemeId>(
    parseStoredIconThemePreference(localStorage.getItem(ICON_THEME_STORAGE_KEY))
  );
  return {
    theme,
    setTheme(next) {
      theme.value = next;
      localStorage.setItem(ICON_THEME_STORAGE_KEY, next);
    }
  };
}

let shared: IconThemePreferenceService | undefined;

export function iconThemePreferenceService(): IconThemePreferenceService {
  shared ??= createIconThemePreferenceService();
  return shared;
}
