import { computed, ref, type Ref } from 'vue';
import type { BuiltinTheme, CustomTheme, ThemePreference } from '../model/custom-theme.js';
import { analyzeCustomTheme, createThemeSource, themeColorScheme } from '../util/custom-theme.js';
import { readBuiltinThemeColors } from '../util/theme-palette.js';

export type { ThemePreference } from '../model/custom-theme.js';

export const THEME_STORAGE_KEY = 'mar.theme';
export const CUSTOM_THEMES_STORAGE_KEY = 'mar.customThemes';
const LIGHT_THEME_COLOR = '#ffffff';
const DARK_THEME_COLOR = '#0e1116';

export interface ThemePreferenceService {
  readonly theme: Ref<ThemePreference>;
  readonly baseTheme: Readonly<Ref<BuiltinTheme>>;
  readonly customThemes: Readonly<Ref<readonly CustomTheme[]>>;
  setTheme(theme: ThemePreference): void;
  saveCustomTheme(source: string, id?: CustomTheme['id']): CustomTheme;
  deleteCustomTheme(id: CustomTheme['id']): void;
  builtinSource(theme: BuiltinTheme, name: string): string;
  resolveColors(source: string): Record<string, string>;
  duplicateSource(source: string, name: string): string;
}

export function parseStoredThemePreference(
  value: string | null,
  themes: readonly CustomTheme[] = []
): ThemePreference {
  const custom = themes.find((item) => item.id === value);
  if (custom) return custom.id;
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

export function createThemePreferenceService(
  readColors: (theme: BuiltinTheme) => Record<string, string> = readBuiltinThemeColors
): ThemePreferenceService {
  const palettes = new Map<BuiltinTheme, Record<string, string>>();
  function palette(theme: BuiltinTheme): Record<string, string> {
    let colors = palettes.get(theme);
    if (!colors) {
      colors = readColors(theme);
      palettes.set(theme, colors);
    }
    return colors;
  }
  function resolveColors(source: string): Record<string, string> {
    return { ...palette('vscode-dark-2026'), ...analyzeCustomTheme(source).colors };
  }
  const customThemes = ref<readonly CustomTheme[]>(readCustomThemes());
  const theme = ref<ThemePreference>(
    parseStoredThemePreference(localStorage.getItem(THEME_STORAGE_KEY), customThemes.value)
  );
  const active = computed(() => customThemes.value.find((item) => item.id === theme.value));
  const activeColors = computed(() => (active.value ? resolveColors(active.value.source) : {}));
  const baseTheme = computed<BuiltinTheme>(() =>
    active.value
      ? themeColorScheme(activeColors.value)
      : theme.value === 'daylight'
        ? 'daylight'
        : 'vscode-dark-2026'
  );
  let appliedTokens: string[] = [];
  function apply(): void {
    for (const token of appliedTokens) document.documentElement.style.removeProperty(token);
    const colors = activeColors.value;
    appliedTokens = Object.keys(colors);
    applyThemePreference(baseTheme.value);
    for (const [token, color] of Object.entries(colors))
      document.documentElement.style.setProperty(token, color);
    if (colors['--mar-bg-page'])
      document
        .querySelector?.('meta[name=theme-color]')
        ?.setAttribute('content', colors['--mar-bg-page']);
  }
  function setTheme(next: ThemePreference): void {
    const resolved = parseStoredThemePreference(next, customThemes.value);
    localStorage.setItem(THEME_STORAGE_KEY, resolved);
    theme.value = resolved;
    apply();
  }
  function persist(items: readonly CustomTheme[]): void {
    localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(items));
    customThemes.value = items;
  }
  apply();
  return {
    theme,
    baseTheme,
    customThemes: computed(() => customThemes.value),
    setTheme,
    resolveColors,
    builtinSource: (theme, name) => createThemeSource(name, palette(theme)),
    duplicateSource(source, name) {
      const original: unknown = JSON.parse(source);
      const data: Record<string, unknown> =
        original && typeof original === 'object' && !Array.isArray(original) ? { ...original } : {};
      delete data.base;
      const originalColors =
        data.colors && typeof data.colors === 'object' && !Array.isArray(data.colors)
          ? data.colors
          : {};
      return JSON.stringify(
        { ...data, version: 1, name, colors: { ...originalColors, ...resolveColors(source) } },
        null,
        2
      );
    },
    saveCustomTheme(source, id) {
      if (id && !id.startsWith('custom:')) throw new Error('BUILTIN_THEME_READ_ONLY');
      if (!analyzeCustomTheme(source).validJson) throw new Error('INVALID_THEME_JSON');
      const item: CustomTheme = { id: id ?? createCustomThemeId(), source };
      const items = customThemes.value.filter((entry) => entry.id !== item.id);
      persist([...items, item]);
      apply();
      return item;
    },
    deleteCustomTheme(id) {
      if (!id.startsWith('custom:')) throw new Error('BUILTIN_THEME_READ_ONLY');
      persist(customThemes.value.filter((item) => item.id !== id));
      if (theme.value === id) {
        // A stale stored selection also resolves to the default on the next load.
        theme.value = 'vscode-dark-2026';
      }
      apply();
    }
  };
}

function createCustomThemeId(): CustomTheme['id'] {
  // getRandomValues also works on self-hosted HTTP origins without randomUUID.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `custom:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function readCustomThemes(): readonly CustomTheme[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value.filter((item): item is CustomTheme => {
      if (
        !item ||
        typeof item.id !== 'string' ||
        !item.id.startsWith('custom:') ||
        typeof item.source !== 'string' ||
        !analyzeCustomTheme(item.source).validJson ||
        seen.has(item.id)
      )
        return false;
      seen.add(item.id);
      return true;
    });
  } catch {
    return [];
  }
}

let shared: ThemePreferenceService | undefined;

export function themePreferenceService(): ThemePreferenceService {
  shared ??= createThemePreferenceService();
  return shared;
}
