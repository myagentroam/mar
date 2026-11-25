import { computed, ref, type Ref } from 'vue';
import {
  CUSTOM_THEME_TOKENS,
  type BuiltinTheme,
  type CustomTheme,
  type ThemePreference
} from '../model/custom-theme.js';
import {
  analyzeCustomTheme,
  createThemeSource,
  resolveActivityFill,
  themeColorScheme
} from '../util/custom-theme.js';
import { readBuiltinThemeColors } from '../util/theme-palette.js';

export type { ThemePreference } from '../model/custom-theme.js';

export const THEME_STORAGE_KEY = 'mar.theme';
export const CUSTOM_THEMES_STORAGE_KEY = 'mar.customThemes';
export const THEME_BOOTSTRAP_STORAGE_KEY = 'mar.themeBootstrap';

// The inline console bootstrap only consumes this derived cache, never the theme source.
function cacheBootstrapTheme(snapshot?: {
  themeId: CustomTheme['id'];
  scheme: BuiltinTheme;
  background: string;
}): void {
  try {
    if (snapshot) {
      localStorage.setItem(THEME_BOOTSTRAP_STORAGE_KEY, JSON.stringify(snapshot));
      return;
    }
  } catch {
    // Discard any previous value if refreshing the cache failed.
  }
  try {
    localStorage.removeItem(THEME_BOOTSTRAP_STORAGE_KEY);
  } catch {
    // The cache is optional and must not prevent the selected theme from applying.
  }
}

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
  return value === 'daylight' ? 'daylight' : 'dark';
}

function applyThemePreference(theme: ThemePreference): void {
  const root = document.documentElement;
  if (theme === 'dark') {
    root.setAttribute('data-theme', theme);
    root.classList.add('dark');
    return;
  }
  root.removeAttribute('data-theme');
  root.classList.remove('dark');
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
    const { colors } = analyzeCustomTheme(source);
    const fill =
      colors['--mar-conversation-activity-fill'] ?? colors['--mar-conversation-activity-fg'];
    return {
      ...palette('dark'),
      ...colors,
      // A legacy source may only set the activity foreground. Preserve its hue for the solid fill.
      ...(fill && resolveActivityFill(fill))
    };
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
        : 'dark'
  );
  let appliedTokens: string[] = [];
  function apply(): void {
    const root = document.documentElement;
    for (const token of appliedTokens) root.style.removeProperty(token);
    const colors = activeColors.value;
    appliedTokens = Object.keys(colors);
    applyThemePreference(baseTheme.value);
    for (const [token, color] of Object.entries(colors)) root.style.setProperty(token, color);
    document
      .querySelector?.('meta[name="theme-color"]')
      ?.setAttribute('content', getComputedStyle(root).getPropertyValue('--mar-bg-page').trim());
    root.style.removeProperty('--mar-bootstrap-bg');
  }
  function refreshBootstrapTheme(): void {
    // The next page follows the shared preference, which may differ from this tab's theme.
    let selectedId: string | null;
    try {
      selectedId = localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      return;
    }
    const selected = customThemes.value.find((item) => item.id === selectedId);
    if (!selected) {
      cacheBootstrapTheme();
      return;
    }
    const colors = selected === active.value ? activeColors.value : resolveColors(selected.source);
    const background = colors['--mar-bg-page'];
    cacheBootstrapTheme(
      background
        ? { themeId: selected.id, scheme: themeColorScheme(colors), background }
        : undefined
    );
  }
  function setTheme(next: ThemePreference): void {
    // Another tab may have edited or deleted the theme since this page loaded.
    const items = readCustomThemes();
    const resolved = parseStoredThemePreference(next, items);
    localStorage.setItem(THEME_STORAGE_KEY, resolved);
    customThemes.value = items;
    theme.value = resolved;
    apply();
    refreshBootstrapTheme();
  }
  function persist(items: readonly CustomTheme[]): void {
    localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(items));
    customThemes.value = items;
    // A stale stored selection also resolves to the default on the next load.
    theme.value = parseStoredThemePreference(theme.value, items);
    apply();
    refreshBootstrapTheme();
  }
  apply();
  refreshBootstrapTheme();
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
      const colors = resolveColors(source);
      return JSON.stringify(
        {
          ...data,
          version: 1,
          name,
          colors: Object.fromEntries(CUSTOM_THEME_TOKENS.map((token) => [token, colors[token]]))
        },
        null,
        2
      );
    },
    saveCustomTheme(source, id) {
      if (id && !id.startsWith('custom:')) throw new Error('BUILTIN_THEME_READ_ONLY');
      if (!analyzeCustomTheme(source).validJson) throw new Error('INVALID_THEME_JSON');
      const item: CustomTheme = { id: id ?? createCustomThemeId(), source };
      const items = readCustomThemes().filter((entry) => entry.id !== item.id);
      persist([...items, item]);
      return item;
    },
    deleteCustomTheme(id) {
      if (!id.startsWith('custom:')) throw new Error('BUILTIN_THEME_READ_ONLY');
      persist(readCustomThemes().filter((item) => item.id !== id));
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
