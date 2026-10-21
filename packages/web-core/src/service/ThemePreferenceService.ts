import { ref, type Ref } from 'vue';

export type ThemePreference = 'daylight' | 'vscode-dark-2026';

export const THEME_STORAGE_KEY = 'mar.theme';
const LIGHT_THEME_COLOR = '#ffffff';
const DARK_THEME_COLOR = '#0e1116';

export interface ThemePreferenceService {
  readonly theme: Ref<ThemePreference>;
  setTheme(theme: ThemePreference): void;
}

export function parseStoredThemePreference(value: string | null): ThemePreference {
  return value === 'daylight' ? 'daylight' : 'vscode-dark-2026';
}

function applyThemePreference(theme: ThemePreference): void {
  const root = document.documentElement;
  const themeColor = document.querySelector?.<HTMLMetaElement>('meta[name="theme-color"]');
  if (theme === 'vscode-dark-2026') {
    root.setAttribute('data-theme', theme);
    root.classList.add('dark');
    themeColor?.setAttribute('content', DARK_THEME_COLOR);
    return;
  }
  root.removeAttribute('data-theme');
  root.classList.remove('dark');
  themeColor?.setAttribute('content', LIGHT_THEME_COLOR);
}

export function createThemePreferenceService(): ThemePreferenceService {
  const theme = ref<ThemePreference>(
    parseStoredThemePreference(localStorage.getItem(THEME_STORAGE_KEY))
  );
  applyThemePreference(theme.value);
  return {
    theme,
    setTheme(next) {
      theme.value = next;
      localStorage.setItem(THEME_STORAGE_KEY, next);
      applyThemePreference(next);
    }
  };
}

let shared: ThemePreferenceService | undefined;

export function themePreferenceService(): ThemePreferenceService {
  shared ??= createThemePreferenceService();
  return shared;
}
