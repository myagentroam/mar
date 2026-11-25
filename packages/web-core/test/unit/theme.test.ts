import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createThemePreferenceService,
  CUSTOM_THEMES_STORAGE_KEY,
  parseStoredThemePreference,
  THEME_BOOTSTRAP_STORAGE_KEY,
  THEME_STORAGE_KEY
} from '../../src/service/theme-preference-service';

function sharedStyles(): string {
  return [
    'styles.css',
    'styles/theme.css',
    'styles/mar-ui-theme.css',
    'styles/product-primitives.css'
  ]
    .map((path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8'))
    .join('\n');
}

it('defines every shared font role and MAR status token consumed by components', () => {
  const css = sharedStyles();
  const defined = new Set([...css.matchAll(/(--mar-font-[\w-]+)\s*:/gu)].map((match) => match[1]));
  const root = fileURLToPath(new URL('../../src/view/', import.meta.url));
  for (const file of readdirSync(root, {
    recursive: true,
    encoding: 'utf8',
    withFileTypes: false
  })) {
    if (!file.endsWith('.vue')) continue;
    const source = readFileSync(join(root, file), 'utf8');
    for (const match of source.matchAll(/var\((--mar-font-[\w-]+)/gu)) {
      expect(defined.has(match[1]!), `${file}: ${match[1]}`).toBe(true);
    }
  }
  for (const type of ['success', 'warning', 'danger']) {
    for (const suffix of ['text', 'bg']) {
      expect(css).toContain(`--mar-color-${type}-${suffix}:`);
      expect(css).toContain(`--mar-ui-color-${type}-${suffix}: var(--mar-color-${type}-${suffix})`);
    }
  }
});

function stubBrowserEnvironment(pageColors = { dark: '#14181e', daylight: '#f8fbff' }) {
  const storage = new Map<string, string>();
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const themeColorAttributes = new Map<string, string>();
  const styles = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  });
  vi.stubGlobal('document', {
    documentElement: {
      style: {
        setProperty: (name: string, value: string) => styles.set(name, value),
        removeProperty: (name: string) => styles.delete(name)
      },
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
        contains: (name: string) => classes.has(name)
      },
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
      getAttribute: (name: string) => attributes.get(name) ?? null
    },
    querySelector: (selector: string) =>
      selector === 'meta[name="theme-color"]'
        ? {
            setAttribute: (name: string, value: string) => themeColorAttributes.set(name, value)
          }
        : null
  });
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) =>
      styles.get(name) ??
      (name === '--mar-bg-page'
        ? pageColors[attributes.has('data-theme') ? 'dark' : 'daylight']
        : '')
  }));
  return { storage, classes, attributes, themeColorAttributes };
}

afterEach(() => vi.unstubAllGlobals());

describe('Web theme preference', () => {
  it('loads the production stylesheet stack in the theme browser fixture', () => {
    const cssImports = (path: string) => {
      const file = new URL(path, import.meta.url);
      return [...readFileSync(file, 'utf8').matchAll(/import '([^']+\.css)'/gu)].map(
        ([, specifier]) => (specifier!.startsWith('.') ? new URL(specifier!, file).href : specifier)
      );
    };
    const production = cssImports('../../src/bootstrap.ts');
    expect(production).toEqual([new URL('../../src/styles.css', import.meta.url).href]);
    expect(cssImports('../e2e/custom-theme-app.ts')).toEqual(production);
  });

  it('keeps private headers and file actions in their owning components', () => {
    const global = sharedStyles();
    for (const selector of [
      '.file-preview-header',
      '.mobile-preview-actions',
      '.conversation-header'
    ])
      expect(global).not.toContain(selector);
  });

  it('accepts registered theme identifiers and falls back to the default dark theme for others', () => {
    expect(parseStoredThemePreference('dark')).toBe('dark');
    expect(parseStoredThemePreference('daylight')).toBe('daylight');
    expect(parseStoredThemePreference(null)).toBe('dark');
    expect(parseStoredThemePreference('')).toBe('dark');
  });

  it.each([null, '', 'unknown-theme', 'dark'])(
    'initializes the dark theme without overwriting stored value %s',
    (stored) => {
      const { storage, classes, attributes, themeColorAttributes } = stubBrowserEnvironment();
      if (stored !== null) storage.set(THEME_STORAGE_KEY, stored);

      const service = createThemePreferenceService();

      expect(service.theme.value).toBe('dark');
      expect(attributes.get('data-theme')).toBe('dark');
      expect(classes.has('dark')).toBe(true);
      expect(themeColorAttributes.get('content')).toBe('#14181e');
      expect(storage.get(THEME_STORAGE_KEY)).toBe(stored ?? undefined);
    }
  );

  it('preserves the saved light theme during initialization', () => {
    const { storage, classes, attributes, themeColorAttributes } = stubBrowserEnvironment();
    storage.set(THEME_STORAGE_KEY, 'daylight');

    const service = createThemePreferenceService();

    expect(service.theme.value).toBe('daylight');
    expect(attributes.has('data-theme')).toBe(false);
    expect(classes.has('dark')).toBe(false);
    expect(themeColorAttributes.get('content')).toBe('#f8fbff');
    expect(storage.get(THEME_STORAGE_KEY)).toBe('daylight');
  });

  it('synchronizes the root marker and local persistence when switching themes', () => {
    const { storage, classes, attributes, themeColorAttributes } = stubBrowserEnvironment();
    const service = createThemePreferenceService();

    service.setTheme('dark');
    expect(service.theme.value).toBe('dark');
    expect(storage.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(attributes.get('data-theme')).toBe('dark');
    expect(classes.has('dark')).toBe(true);
    expect(themeColorAttributes.get('content')).toBe('#14181e');

    service.setTheme('daylight');
    expect(service.theme.value).toBe('daylight');
    expect(storage.get(THEME_STORAGE_KEY)).toBe('daylight');
    expect(attributes.has('data-theme')).toBe(false);
    expect(classes.has('dark')).toBe(false);
    expect(themeColorAttributes.get('content')).toBe('#f8fbff');
  });

  it('keeps PWA chrome on the applied page color through built-in and custom theme changes', () => {
    const pageColors = { dark: '#182026', daylight: '#eff3f8' };
    const { themeColorAttributes, storage } = stubBrowserEnvironment(pageColors);
    const service = createThemePreferenceService((theme) => ({
      '--mar-bg-page': pageColors[theme]
    }));
    expect(themeColorAttributes.get('content')).toBe(pageColors['dark']);
    service.setTheme('daylight');
    expect(themeColorAttributes.get('content')).toBe(pageColors.daylight);

    const source = (color: string) => JSON.stringify({ colors: { '--mar-bg-page': color } });
    const custom = service.saveCustomTheme(source('#284038'));
    expect(themeColorAttributes.get('content')).toBe(pageColors.daylight);
    service.setTheme(custom.id);
    expect(themeColorAttributes.get('content')).toBe('#284038');
    expect(JSON.parse(storage.get(THEME_BOOTSTRAP_STORAGE_KEY)!)).toEqual({
      themeId: custom.id,
      scheme: 'dark',
      background: '#284038'
    });
    service.saveCustomTheme(source('#dce8df'), custom.id);
    expect(themeColorAttributes.get('content')).toBe('#dce8df');
    const lightSnapshot = {
      themeId: custom.id,
      scheme: 'daylight',
      background: '#dce8df'
    };
    expect(JSON.parse(storage.get(THEME_BOOTSTRAP_STORAGE_KEY)!)).toEqual(lightSnapshot);

    storage.delete(THEME_BOOTSTRAP_STORAGE_KEY);
    const restored = createThemePreferenceService((theme) => ({
      '--mar-bg-page': pageColors[theme]
    }));
    expect(restored.theme.value).toBe(custom.id);
    expect(themeColorAttributes.get('content')).toBe('#dce8df');
    expect(storage.get(CUSTOM_THEMES_STORAGE_KEY)).toContain(custom.id);
    expect(JSON.parse(storage.get(THEME_BOOTSTRAP_STORAGE_KEY)!)).toEqual(lightSnapshot);
    restored.setTheme('daylight');
    expect(storage.has(THEME_BOOTSTRAP_STORAGE_KEY)).toBe(false);
    restored.setTheme(custom.id);
    restored.deleteCustomTheme(custom.id);
    expect(themeColorAttributes.get('content')).toBe(pageColors['dark']);
    expect(storage.has(THEME_BOOTSTRAP_STORAGE_KEY)).toBe(false);
  });

  it('discards a stale startup snapshot without blocking the theme when the cache write fails', () => {
    const { storage, themeColorAttributes } = stubBrowserEnvironment();
    const service = createThemePreferenceService(() => ({ '--mar-bg-page': '#14181e' }));
    const source = (background: string) =>
      JSON.stringify({ colors: { '--mar-bg-page': background } });
    const custom = service.saveCustomTheme(source('#dce8df'));
    service.setTheme(custom.id);
    expect(storage.has(THEME_BOOTSTRAP_STORAGE_KEY)).toBe(true);

    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === THEME_BOOTSTRAP_STORAGE_KEY) throw new Error('quota');
      storage.set(key, value);
    });
    service.saveCustomTheme(source('#284038'), custom.id);

    expect(themeColorAttributes.get('content')).toBe('#284038');
    expect(storage.get(CUSTOM_THEMES_STORAGE_KEY)).toContain('#284038');
    expect(storage.has(THEME_BOOTSTRAP_STORAGE_KEY)).toBe(false);
  });

  it('does not publish outdated startup colors from an older tab', () => {
    const { storage } = stubBrowserEnvironment();
    const createService = () =>
      createThemePreferenceService(() => ({ '--mar-bg-page': '#14181e' }));
    const firstTab = createService();
    const source = (background: string) =>
      JSON.stringify({ colors: { '--mar-bg-page': background } });
    const custom = firstTab.saveCustomTheme(source('#dce8df'));
    const secondTab = createService();
    secondTab.setTheme(custom.id);
    secondTab.saveCustomTheme(source('#284038'), custom.id);
    const expected = {
      themeId: custom.id,
      scheme: 'dark',
      background: '#284038'
    };

    firstTab.saveCustomTheme(source('#bfd0c1'));
    expect(JSON.parse(storage.get(THEME_BOOTSTRAP_STORAGE_KEY)!)).toEqual(expected);
    firstTab.setTheme(custom.id);
    expect(JSON.parse(storage.get(THEME_BOOTSTRAP_STORAGE_KEY)!)).toEqual(expected);

    secondTab.deleteCustomTheme(custom.id);
    firstTab.setTheme(custom.id);
    expect(firstTab.theme.value).toBe('dark');
    expect(storage.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(storage.has(THEME_BOOTSTRAP_STORAGE_KEY)).toBe(false);
  });
});
