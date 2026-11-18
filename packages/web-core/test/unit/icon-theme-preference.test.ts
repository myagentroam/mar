import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveIconTheme } from '../../src/icon-themes/index.js';
import illustrations from '../../src/icon-themes/mar/illustrations.svg?raw';
import mapping from '../../src/icon-themes/mar/mapping.json';
import {
  createIconThemePreferenceService,
  ICON_THEME_STORAGE_KEY,
  parseStoredIconThemePreference
} from '../../src/service/icon-theme-preference-service.js';

afterEach(() => vi.unstubAllGlobals());

describe('File Icon Theme Preferences', () => {
  it('Defaults to MAR File Icons without overriding a valid preference', () => {
    expect(parseStoredIconThemePreference(null)).toBe('mar');
    expect(parseStoredIconThemePreference('')).toBe('mar');
    expect(parseStoredIconThemePreference('unknown')).toBe('mar');
    expect(parseStoredIconThemePreference('constructor')).toBe('mar');
    expect(parseStoredIconThemePreference('mar')).toBe('mar');
    expect(parseStoredIconThemePreference('material')).toBe('material');
    expect(parseStoredIconThemePreference('seti')).toBe('seti');
  });

  it.each([null, '', 'unknown', 'mar', 'seti', 'material'])(
    'Restore the icon theme from stored value %s without overwriting it',
    (stored) => {
      const storage = new Map<string, string>();
      if (stored !== null) storage.set(ICON_THEME_STORAGE_KEY, stored);
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value)
      });

      const service = createIconThemePreferenceService();

      expect(service.theme.value).toBe(stored === 'seti' || stored === 'material' ? stored : 'mar');
      expect(storage.get(ICON_THEME_STORAGE_KEY)).toBe(stored ?? undefined);
    }
  );

  it.each(['mar', 'seti', 'material'] as const)(
    'Persist the %s theme selected by the current browser',
    (next) => {
      const storage = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value)
      });
      const service = createIconThemePreferenceService();

      service.setTheme(next);

      expect(service.theme.value).toBe(next);
      expect(storage.get(ICON_THEME_STORAGE_KEY)).toBe(next);
    }
  );

  it('Matches MAR icons by exact name, longest suffix, ordinary suffix and fallback', () => {
    const mar = resolveIconTheme('mar');
    for (const [name, icon] of [
      ['AGENTS.MD', 'agent'],
      ['nested.dir/AGENTS.MD', 'agent'],
      ['nested.dir/Dockerfile', 'docker'],
      ['nested.dir/.py', 'fallback'],
      ['CLAUDE.local.md', 'agent'],
      ['.mcp.json', 'bridge'],
      ['foo.instructions.md', 'agent'],
      ['foo.ts', 'ts'],
      ['foo.d.MTS', 'decl'],
      ['foo.spec.ts', 'test'],
      ['pasted-text.TXT', 'txt'],
      ['notes.rst', 'text'],
      ['illustrations.svg', 'vector'],
      ['illustrations.SVGZ', 'vector'],
      ['screenshot.png', 'image'],
      ['latest.tar.zst', 'archive'],
      ['places.geojson', 'geo'],
      ['schedule.ics', 'mail'],
      ['script.PY', 'python'],
      ['script.pyi', 'decl'],
      ['module.pyx', 'cython'],
      ['legacy.vhd', 'fallback'],
      ['asset.obj', 'fallback'],
      ['.md', 'fallback'],
      ['README', 'readme'],
      ['constructor', 'fallback'],
      ['asset.toString', 'fallback']
    ] as const) {
      expect(mar.resolveFile(name, true)).toMatchObject({
        kind: 'sprite',
        href: expect.stringMatching(new RegExp(`#mar-file-${icon}$`, 'u'))
      });
    }
  });

  it('Shares a stylesheet icon across CSS and its preprocessor formats', () => {
    const mar = resolveIconTheme('mar');
    const css = mar.resolveFile('theme.css', true);
    expect(css).toMatchObject({ kind: 'sprite', href: expect.stringMatching(/#mar-file-style$/u) });
    for (const extension of ['SCSS', 'sass', 'less', 'styl', 'stylus', 'sss', 'pcss']) {
      expect(mar.resolveFile(`theme.${extension}`, true)).toEqual(css);
    }
  });

  it('Ships a symbol and a complete palette for every mapped MAR icon', () => {
    const ids = [
      ...illustrations.matchAll(/<symbol id="mar-file-([a-z-]+)" viewBox="0 0 24 24">/gu)
    ].map((match) => match[1]);
    const referenced = new Set([
      ...Object.values(mapping.fileNames),
      ...Object.values(mapping.fileExtensions),
      ...Object.values(mapping.folderNames),
      ...Object.values(mapping.fallback)
    ]);
    expect(Object.keys(mapping.artwork).toSorted()).toEqual([...referenced].toSorted());
    const usedSymbols = new Set(
      Object.entries(mapping.artwork).map(([id, artwork]) =>
        'symbol' in artwork ? artwork.symbol : id
      )
    );
    expect(ids.toSorted()).toEqual([...usedSymbols].toSorted());
    for (const { accent } of Object.values(mapping.artwork)) {
      expect(mapping.colors[accent as keyof typeof mapping.colors]).toEqual({
        light: expect.stringMatching(/^#[0-9a-f]{6}$/iu),
        dark: expect.stringMatching(/^#[0-9a-f]{6}$/iu)
      });
    }
  });

  it.each([true, false])('Uses blue only for AGENTS.md among robot icons (light=%s)', (light) => {
    const mar = resolveIconTheme('mar');
    const agents = mar.resolveFile('docs/AGENTS.md', light);
    const claude = mar.resolveFile('CLAUDE.md', light);
    expect(agents).toMatchObject({ kind: 'sprite', color: light ? '#0069e8' : '#59a9ff' });
    expect(claude).toMatchObject({ kind: 'sprite', color: light ? '#8039e8' : '#bd96ff' });
    if (agents.kind !== 'sprite' || claude.kind !== 'sprite')
      throw new Error('Expected SVG sprite');
    expect(agents.href).toBe(claude.href);
  });

  it('Keeps the offline icon preview synchronized with the product resources', () => {
    const generator = fileURLToPath(
      new URL('../../src/icon-themes/mar/generate-preview.mjs', import.meta.url)
    );
    execFileSync(process.execPath, [generator, '--check'], { stdio: 'pipe' });
  });

  it('Resolves folders independently and reuses geometry across light and dark colors', () => {
    const mar = resolveIconTheme('mar');
    const light = mar.resolveFolder(true, 'SRC');
    const dark = mar.resolveFolder(false, 'src');
    expect(light).toMatchObject({ kind: 'sprite', href: expect.stringMatching(/#mar-file-src$/u) });
    expect(dark).toMatchObject({ kind: 'sprite', href: expect.stringMatching(/#mar-file-src$/u) });
    expect(dark.color).not.toBe(light.color);
    expect(mar.resolveFolder(true, 'packages/web-core/SRC')).toEqual(light);
    expect(mar.resolveFolder(true, 'AGENTS.md')).toEqual(mar.resolveFolder(true));
  });

  it('Marks only source and conventional test directories in MAR', () => {
    const mar = resolveIconTheme('mar');
    for (const name of ['test', 'tests', 'nested/__TESTS__']) {
      expect(mar.resolveFolder(true, name)).toMatchObject({
        kind: 'sprite',
        href: expect.stringMatching(/#mar-file-tests$/u)
      });
    }
    for (const name of ['.agents', '.git', 'data', 'docs', 'dist', 'node_modules', 'assets']) {
      expect(mar.resolveFolder(true, name)).toEqual(mar.resolveFolder(true));
    }
  });

  it('Resolve Material file and folder icons through the registry', () => {
    const material = resolveIconTheme('material');

    expect(material.resolveFolder(true)).toMatchObject({ kind: 'svg', color: '#1976d2' });
    expect(material.resolveFile('component.vue', true)).toMatchObject({
      kind: 'svg',
      color: '#42a5f5'
    });
    expect(material.resolveFile('unknown.file', false)).toMatchObject({
      kind: 'svg',
      color: '#b0bec5'
    });
    expect(material.resolveFile('AGENTS.md', true)).toMatchObject({
      kind: 'svg',
      markup: expect.stringContaining('#ff5252')
    });
    expect(material.resolveFile('CLAUDE.md', true)).not.toEqual(
      material.resolveFile('README.md', true)
    );
    expect(material.resolveFile('.gitignore', true)).not.toEqual(
      material.resolveFile('unknown.file', true)
    );
    expect(material.resolveFile('README.md', true)).not.toEqual(
      material.resolveFile('notes.md', true)
    );
    expect(material.resolveFile('README.md', true)).toMatchObject({
      markup: expect.stringContaining('fill="none"')
    });
    expect(material.resolveFile('README.md', true)).not.toMatchObject({
      markup: expect.stringContaining('fill="currentColor"')
    });
    expect(material.resolveFolder(true, '.vscode')).not.toEqual(
      material.resolveFolder(true, 'other')
    );
    expect(material.resolveFolder(true, 'src')).not.toEqual(material.resolveFolder(true, 'other'));
    expect(material.resolveFolder(true, 'docs')).not.toEqual(material.resolveFolder(true, 'other'));
    expect(material.resolveFolder(true, 'build')).not.toEqual(
      material.resolveFolder(true, 'other')
    );
  });

  it.each(['mar', 'seti', 'material'] as const)(
    'keeps the effective %s theme on storage failure and confirms a later successful write',
    (previous) => {
      const next = previous === 'mar' ? 'seti' : 'mar';
      const storage = new Map<string, string>([[ICON_THEME_STORAGE_KEY, previous]]);
      const failure = new Error('Storage unavailable');
      let failWrite = true;
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          expect(service.theme.value).toBe(previous);
          if (failWrite) throw failure;
          storage.set(key, value);
        }
      });
      const service = createIconThemePreferenceService();

      expect(() => service.setTheme(next)).toThrow(failure);
      expect(service.theme.value).toBe(previous);
      expect(storage.get(ICON_THEME_STORAGE_KEY)).toBe(previous);

      failWrite = false;
      service.setTheme(next);
      expect(service.theme.value).toBe(next);
      expect(createIconThemePreferenceService().theme.value).toBe(next);
    }
  );
});
