import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeCustomTheme,
  createThemeSource,
  themeColorScheme
} from '../../src/util/custom-theme.js';
import {
  createThemePreferenceService as createService,
  CUSTOM_THEMES_STORAGE_KEY,
  THEME_STORAGE_KEY
} from '../../src/service/ThemePreferenceService.js';

const source = (colors: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, name: 'Ocean', colors, ...extra });
const darkPalette = {
  '--mar-bg-page': '#141619',
  '--mar-bg-panel': '#1e2836',
  '--mar-fill-selection': '#293545',
  '--mar-bg-chrome': '#18263b',
  '--mar-color-brand': '#3071d1',
  '--mar-text-primary': '#e7eaf0'
};
const lightPalette = {
  '--mar-bg-page': '#f3f6f9',
  '--mar-bg-panel': '#ffffff',
  '--mar-fill-selection': '#dfe5ed',
  '--mar-bg-chrome': '#f5f6f8',
  '--mar-color-brand': '#0a6fd8',
  '--mar-text-primary': '#1c2733'
};
const createThemePreferenceService = () =>
  createService((theme) => (theme === 'daylight' ? lightPalette : darkPalette));
const storage = new Map<string, string>();
const styles = new Map<string, string>();
const attributes = new Map<string, string>();
const classes = new Set<string>();
beforeEach(() => {
  storage.clear();
  styles.clear();
  attributes.clear();
  classes.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value)
  });
  vi.stubGlobal('document', {
    documentElement: {
      style: {
        setProperty: (key: string, value: string) => styles.set(key, value),
        removeProperty: (key: string) => styles.delete(key)
      },
      setAttribute: (key: string, value: string) => attributes.set(key, value),
      removeAttribute: (key: string) => attributes.delete(key),
      classList: {
        add: (key: string) => classes.add(key),
        remove: (key: string) => classes.delete(key)
      }
    }
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('Custom theme validation', () => {
  it('round-trips navigation selection independently and defaults missing or invalid values', () => {
    const service = createThemePreferenceService();
    const input = source({
      '--mar-fill-selection': '#dfe5ed',
      '--mar-color-brand-selected': '#dce8f7'
    });
    const colors = analyzeCustomTheme(input).colors;
    expect(colors['--mar-fill-selection']).toBe('#dfe5ed');
    expect(colors['--mar-color-brand-selected']).toBe('#dce8f7');
    expect(analyzeCustomTheme(createThemeSource('Navigation palette', colors)).colors).toEqual(
      colors
    );
    expect(service.resolveColors(input)['--mar-fill-selection']).toBe('#dfe5ed');
    for (const colors of [{}, { '--mar-fill-selection': 'invalid' }]) {
      expect(service.resolveColors(source(colors))['--mar-fill-selection']).toBe(
        darkPalette['--mar-fill-selection']
      );
    }
  });

  it('resolves chrome independently and defaults missing or invalid chrome colors', () => {
    const service = createThemePreferenceService();
    expect(service.resolveColors(source())['--mar-bg-chrome']).toBe(darkPalette['--mar-bg-chrome']);
    expect(service.resolveColors(source({ '--mar-bg-panel': '#28312b' }))['--mar-bg-chrome']).toBe(
      darkPalette['--mar-bg-chrome']
    );
    expect(
      service.resolveColors(source({ '--mar-bg-panel': '#28312b', '--mar-bg-chrome': '#202428' }))[
        '--mar-bg-chrome'
      ]
    ).toBe('#202428');
    expect(
      service.resolveColors(source({ '--mar-bg-panel': '#28312b', '--mar-bg-chrome': 'invalid' }))[
        '--mar-bg-chrome'
      ]
    ).toBe(darkPalette['--mar-bg-chrome']);
  });

  it('warns about low-contrast chrome text without rejecting a custom theme', () => {
    const result = analyzeCustomTheme(
      source({ '--mar-bg-chrome': '#777777', '--mar-text-primary': '#777777' })
    );
    expect(result.validJson).toBe(true);
    expect(result.warnings).toContainEqual({
      code: 'contrast',
      field: '--mar-text-primary / --mar-bg-chrome'
    });
  });

  it('warns about low-contrast selection titles and metadata without blocking save or apply', () => {
    const service = createThemePreferenceService();
    for (const foreground of ['--mar-text-primary', '--mar-text-secondary']) {
      const input = source({ '--mar-fill-selection': '#777777', [foreground]: '#777777' });
      const result = analyzeCustomTheme(input);
      expect(result.validJson).toBe(true);
      expect(result.warnings).toContainEqual({
        code: 'contrast',
        field: `${foreground} / --mar-fill-selection`
      });
      const item = service.saveCustomTheme(input);
      service.setTheme(item.id);
      expect(item.source).toBe(input);
      expect(styles.get('--mar-fill-selection')).toBe('#777777');
      expect(styles.get(foreground)).toBe('#777777');
    }
  });

  it('blocks syntax errors but accepts every syntactically valid JSON value with advisory warnings', () => {
    expect(analyzeCustomTheme('{').validJson).toBe(false);
    for (const text of ['null', 'true', '42', '[]', '{}']) {
      const result = analyzeCustomTheme(text);
      expect(result.validJson).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.colors).toEqual({});
    }
    expect(analyzeCustomTheme(createThemeSource('Ocean')).warnings).toEqual([]);
  });
  it('applies only registered hexadecimal colors, never CSS, external URLs or layout tokens', () => {
    const result = analyzeCustomTheme(
      source({
        '--mar-bg-panel': '#1234',
        '--mar-text-primary': '#abcdef88',
        '--mar-color-brand': '#abc',
        '--el-color-primary': '#123456',
        '--mar-terminal-background': '#fff',
        '--mar-font-size-body': '100px',
        '--mar-bg-page': 'url(https://example.test/track)',
        '--mar-text-muted': 'var(--missing)',
        '--mar-fill-hover': '#12345',
        '--unknown': '#fff'
      })
    );
    expect(result.colors).toEqual({
      '--mar-bg-panel': '#1234',
      '--mar-text-primary': '#abcdef88',
      '--mar-color-brand': '#abc'
    });
    expect(
      result.warnings.filter((item) => item.code === 'unknown').map((item) => item.field)
    ).toEqual([
      '--el-color-primary',
      '--mar-terminal-background',
      '--mar-font-size-body',
      '--unknown'
    ]);
    expect(result.warnings.filter((item) => item.code === 'color')).toHaveLength(3);
  });
  it('reports unknown metadata, invalid structure and low contrast without rejecting the document', () => {
    const result = analyzeCustomTheme(
      source(
        { '--mar-bg-panel': '#fff', '--mar-text-primary': '#eee' },
        { version: 99, name: '', base: 'unknown', extension: true }
      )
    );
    expect(result.validJson).toBe(true);
    expect(result.warnings.map((item) => item.code)).toEqual(
      expect.arrayContaining(['name', 'version', 'unknown', 'contrast'])
    );
    expect(analyzeCustomTheme(source({}, { colors: [] })).warnings).toContainEqual({
      code: 'colors',
      field: 'colors'
    });
    expect(
      analyzeCustomTheme(source({ '--mar-bg-panel': '#fff', '--mar-text-primary': '#111' }))
        .warnings
    ).toEqual([]);
  });
});

describe('Custom theme persistence and application', () => {
  it('copies complete palettes without a base and fills missing custom colors from dark defaults', () => {
    const service = createThemePreferenceService();
    const builtin = JSON.parse(service.builtinSource('daylight', 'Light'));
    expect(builtin).toEqual({ version: 1, name: 'Light', colors: lightPalette });
    expect(storage.size).toBe(0);
    const partial = source({ '--mar-bg-panel': '#aabbcc' }, { base: 'daylight', extension: true });
    expect(service.resolveColors(partial)).toEqual({
      ...darkPalette,
      '--mar-bg-panel': '#aabbcc'
    });
    const copy = JSON.parse(service.duplicateSource(partial, 'Copy'));
    expect(copy).toEqual({
      version: 1,
      name: 'Copy',
      extension: true,
      colors: { ...darkPalette, '--mar-bg-panel': '#aabbcc' }
    });
    expect(storage.size).toBe(0);
    expect(analyzeCustomTheme(partial).warnings).toContainEqual({ code: 'unknown', field: 'base' });
    expect(themeColorScheme(lightPalette)).toBe('daylight');
    expect(themeColorScheme({ '--mar-bg-page': '#ffff' })).toBe('daylight');
    expect(themeColorScheme({ '--mar-bg-page': '#FFFFFFFF' })).toBe('daylight');
    expect(themeColorScheme(darkPalette)).toBe('vscode-dark-2026');
    expect(themeColorScheme({ '--mar-bg-page': '#fff0' })).toBe('vscode-dark-2026');
  });

  it('never overwrites or deletes built-in identities', () => {
    const service = createThemePreferenceService();
    const builtinId = 'daylight' as `custom:${string}`;
    expect(() => service.saveCustomTheme(source(), builtinId)).toThrow('BUILTIN_THEME_READ_ONLY');
    expect(() => service.deleteCustomTheme(builtinId)).toThrow('BUILTIN_THEME_READ_ONLY');
    expect(storage.size).toBe(0);
  });

  it('creates distinct themes when secure-context randomUUID is unavailable', () => {
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    vi.stubGlobal('crypto', { getRandomValues });
    const service = createThemePreferenceService();
    const first = service.saveCustomTheme(source());
    const second = service.saveCustomTheme(source());
    expect(first.id).toMatch(/^custom:[0-9a-f]{32}$/u);
    expect(first.id).not.toBe(second.id);
  });

  it('preserves source including advisory fields, creates separate identities and restores selection', () => {
    const service = createThemePreferenceService();
    const text = source(
      { '--mar-bg-panel': '#ff00ff', '--mar-bg-page': '#ffffff' },
      { extension: { untouched: true } }
    );
    const first = service.saveCustomTheme(text);
    const second = service.saveCustomTheme(text);
    expect(first.id).not.toBe(second.id);
    expect(service.theme.value).toBe('vscode-dark-2026');
    service.setTheme(first.id);
    expect(service.baseTheme.value).toBe('daylight');
    expect(classes.has('dark')).toBe(false);
    expect(styles.get('--mar-bg-panel')).toBe('#ff00ff');
    const restored = createThemePreferenceService();
    expect(restored.theme.value).toBe(first.id);
    expect(restored.customThemes.value[0]?.source).toBe(text);
    expect(storage.get(THEME_STORAGE_KEY)).toBe(first.id);
  });
  it('updates active colors immediately, removes stale overrides and resets on deletion or built-in selection', () => {
    const service = createThemePreferenceService();
    const item = service.saveCustomTheme(
      source({ '--mar-bg-panel': '#123', '--mar-text-primary': '#fff' })
    );
    service.setTheme(item.id);
    service.saveCustomTheme(
      source({ '--mar-bg-panel': '#456' }, { base: 'vscode-dark-2026' }),
      item.id
    );
    expect(styles.get('--mar-bg-panel')).toBe('#456');
    expect(styles.get('--mar-text-primary')).toBe(darkPalette['--mar-text-primary']);
    expect(classes.has('dark')).toBe(true);
    service.setTheme('daylight');
    expect(styles.size).toBe(0);
    service.setTheme(item.id);
    service.deleteCustomTheme(item.id);
    expect(service.theme.value).toBe('vscode-dark-2026');
    expect(styles.size).toBe(0);
    expect(createThemePreferenceService().theme.value).toBe('vscode-dark-2026');
  });
  it('rejects only invalid JSON and saves warning-only documents', () => {
    const service = createThemePreferenceService();
    expect(() => service.saveCustomTheme('{')).toThrow('INVALID_THEME_JSON');
    expect(storage.has(CUSTOM_THEMES_STORAGE_KEY)).toBe(false);
    const item = service.saveCustomTheme('null');
    service.setTheme(item.id);
    expect(service.customThemes.value[0]?.source).toBe('null');
    expect(service.baseTheme.value).toBe('vscode-dark-2026');
  });
  it('recovers from corrupt storage and missing custom selections', () => {
    storage.set(CUSTOM_THEMES_STORAGE_KEY, '{');
    storage.set(THEME_STORAGE_KEY, 'custom:missing');
    const service = createThemePreferenceService();
    expect(service.theme.value).toBe('vscode-dark-2026');
    expect(service.customThemes.value).toEqual([]);
  });
  it('does not change saved state or applied colors when storage fails', () => {
    const service = createThemePreferenceService();
    const item = service.saveCustomTheme(source({ '--mar-bg-panel': '#123' }));
    service.setTheme(item.id);
    vi.stubGlobal('localStorage', {
      setItem: () => {
        throw new Error('quota');
      }
    });
    expect(() => service.saveCustomTheme('null', item.id)).toThrow('quota');
    expect(() => service.deleteCustomTheme(item.id)).toThrow('quota');
    expect(() => service.setTheme('daylight')).toThrow('quota');
    expect(service.customThemes.value[0]?.source).toBe(item.source);
    expect(service.theme.value).toBe(item.id);
    expect(styles.get('--mar-bg-panel')).toBe('#123');
  });
});

describe('Canonical theme tokens', () => {
  it('ignores unregistered library keys and copies only current canonical colors', () => {
    const analysis = analyzeCustomTheme(source({ '--el-color-primary': '#123456' }));
    expect(analysis.colors).toEqual({});
    expect(analysis.warnings).toContainEqual({ code: 'unknown', field: '--el-color-primary' });
    for (const colors of [
      { '--el-color-primary': '#123456', '--mar-color-brand': '#abcdef' },
      { '--mar-color-brand': '#abcdef', '--el-color-primary': '#123456' }
    ]) {
      expect(analyzeCustomTheme(source(colors)).colors).toEqual({ '--mar-color-brand': '#abcdef' });
    }
    expect(
      analyzeCustomTheme(source({ '--el-color-primary': 'url(https://invalid.test)' })).colors
    ).toEqual({});
    const service = createThemePreferenceService();
    const legacy = source({ '--el-color-primary': '#123456' });
    const item = service.saveCustomTheme(legacy);
    service.setTheme(item.id);
    expect(styles.get('--mar-color-brand')).toBe(darkPalette['--mar-color-brand']);
    expect(styles.has('--el-color-primary')).toBe(false);
    expect(item.source).toBe(legacy);
    const copy = JSON.parse(service.duplicateSource(legacy, 'Copy'));
    expect(copy.colors['--mar-color-brand']).toBe(darkPalette['--mar-color-brand']);
    expect(copy.colors).not.toHaveProperty('--el-color-primary');
  });
});
