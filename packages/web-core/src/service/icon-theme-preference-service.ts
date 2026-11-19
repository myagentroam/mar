import { ref, type Ref } from 'vue';
import { DEFAULT_ICON_THEME_ID, isIconThemeId, type IconThemeId } from '../icon-themes/index.js';

export const ICON_THEME_STORAGE_KEY = 'mar.icon-theme.v2';

export interface IconThemePreferenceService {
  readonly theme: Ref<IconThemeId>;
  setTheme(theme: IconThemeId): void;
}

export function parseStoredIconThemePreference(value: string | null): IconThemeId {
  return value !== null && isIconThemeId(value) ? value : DEFAULT_ICON_THEME_ID;
}

export function createIconThemePreferenceService(): IconThemePreferenceService {
  const theme = ref<IconThemeId>(
    parseStoredIconThemePreference(localStorage.getItem(ICON_THEME_STORAGE_KEY))
  );
  return {
    theme,
    setTheme(next) {
      localStorage.setItem(ICON_THEME_STORAGE_KEY, next);
      theme.value = next;
    }
  };
}

let shared: IconThemePreferenceService | undefined;

export function iconThemePreferenceService(): IconThemePreferenceService {
  shared ??= createIconThemePreferenceService();
  return shared;
}
