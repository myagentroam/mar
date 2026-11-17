import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createThemePreferenceService,
  CUSTOM_THEMES_STORAGE_KEY,
  parseStoredThemePreference,
  THEME_STORAGE_KEY
} from '../../src/service/theme-preference-service';

function sharedStyles(): string {
  return [
    'styles.css',
    'styles/theme.css',
    'styles/element-plus-theme.css',
    'styles/mar-controls.css'
  ]
    .map((path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8'))
    .join('\n');
}

it('defines every shared font role and Element Plus status shade consumed by components', () => {
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
  for (const type of ['success', 'warning', 'danger', 'info']) {
    for (const suffix of ['light-3', 'light-5', 'light-7', 'light-8', 'light-9', 'dark-2']) {
      expect(css).toContain(`--el-color-${type}-${suffix}:`);
    }
  }
});

function stubBrowserEnvironment(
  pageColors = { 'vscode-dark-2026': '#14181e', daylight: '#f7f9fd' }
) {
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
        ? pageColors[attributes.has('data-theme') ? 'vscode-dark-2026' : 'daylight']
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
    expect(cssImports('../e2e/custom-theme-app.ts')).toEqual(cssImports('../../src/bootstrap.ts'));
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
    expect(parseStoredThemePreference('vscode-dark-2026')).toBe('vscode-dark-2026');
    expect(parseStoredThemePreference('daylight')).toBe('daylight');
    expect(parseStoredThemePreference(null)).toBe('vscode-dark-2026');
    expect(parseStoredThemePreference('')).toBe('vscode-dark-2026');
    expect(parseStoredThemePreference('dark')).toBe('vscode-dark-2026');
  });

  it.each([null, '', 'unknown-theme', 'vscode-dark-2026'])(
    'initializes the dark theme without overwriting stored value %s',
    (stored) => {
      const { storage, classes, attributes, themeColorAttributes } = stubBrowserEnvironment();
      if (stored !== null) storage.set(THEME_STORAGE_KEY, stored);

      const service = createThemePreferenceService();

      expect(service.theme.value).toBe('vscode-dark-2026');
      expect(attributes.get('data-theme')).toBe('vscode-dark-2026');
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
    expect(themeColorAttributes.get('content')).toBe('#f7f9fd');
    expect(storage.get(THEME_STORAGE_KEY)).toBe('daylight');
  });

  it('synchronizes the root marker and local persistence when switching themes', () => {
    const { storage, classes, attributes, themeColorAttributes } = stubBrowserEnvironment();
    const service = createThemePreferenceService();

    service.setTheme('vscode-dark-2026');
    expect(service.theme.value).toBe('vscode-dark-2026');
    expect(storage.get(THEME_STORAGE_KEY)).toBe('vscode-dark-2026');
    expect(attributes.get('data-theme')).toBe('vscode-dark-2026');
    expect(classes.has('dark')).toBe(true);
    expect(themeColorAttributes.get('content')).toBe('#14181e');

    service.setTheme('daylight');
    expect(service.theme.value).toBe('daylight');
    expect(storage.get(THEME_STORAGE_KEY)).toBe('daylight');
    expect(attributes.has('data-theme')).toBe(false);
    expect(classes.has('dark')).toBe(false);
    expect(themeColorAttributes.get('content')).toBe('#f7f9fd');
  });

  it('keeps PWA chrome on the applied page color through built-in and custom theme changes', () => {
    const pageColors = { 'vscode-dark-2026': '#182026', daylight: '#eff3f8' };
    const { themeColorAttributes, storage } = stubBrowserEnvironment(pageColors);
    const service = createThemePreferenceService((theme) => ({
      '--mar-bg-page': pageColors[theme]
    }));
    expect(themeColorAttributes.get('content')).toBe(pageColors['vscode-dark-2026']);
    service.setTheme('daylight');
    expect(themeColorAttributes.get('content')).toBe(pageColors.daylight);

    const source = (color: string) => JSON.stringify({ colors: { '--mar-bg-page': color } });
    const custom = service.saveCustomTheme(source('#284038'));
    expect(themeColorAttributes.get('content')).toBe(pageColors.daylight);
    service.setTheme(custom.id);
    expect(themeColorAttributes.get('content')).toBe('#284038');
    service.saveCustomTheme(source('#dce8df'), custom.id);
    expect(themeColorAttributes.get('content')).toBe('#dce8df');

    const restored = createThemePreferenceService((theme) => ({
      '--mar-bg-page': pageColors[theme]
    }));
    expect(restored.theme.value).toBe(custom.id);
    expect(themeColorAttributes.get('content')).toBe('#dce8df');
    expect(storage.get(CUSTOM_THEMES_STORAGE_KEY)).toContain(custom.id);
    restored.deleteCustomTheme(custom.id);
    expect(themeColorAttributes.get('content')).toBe(pageColors['vscode-dark-2026']);
  });
});
