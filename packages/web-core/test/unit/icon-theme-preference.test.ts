import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { iconThemes, isIconThemeId, resolveIconTheme } from '../../src/icon-themes/index.js';
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
    expect(parseStoredIconThemePreference('material')).toBe('mar');
    expect(parseStoredIconThemePreference('seti')).toBe('mar');
  });

  it('Ignores the previous storage key without migrating or deleting its value', () => {
    const storage = new Map([['mar.icon-theme', 'material']]);
    const setItem = vi.fn();
    const removeItem = vi.fn();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem,
      removeItem
    });

    expect(createIconThemePreferenceService().theme.value).toBe('mar');
    expect(localStorage.getItem).toHaveBeenCalledExactlyOnceWith('mar.icon-theme.v2');
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
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

      expect(service.theme.value).toBe('mar');
      expect(storage.get(ICON_THEME_STORAGE_KEY)).toBe(stored ?? undefined);
    }
  );

  it('Matches MAR icons by exact name, longest suffix, ordinary suffix and fallback', () => {
    const mar = resolveIconTheme('mar');
    for (const [name, icon] of [
      ['AGENTS.MD', 'agent'],
      ['nested.dir/AGENTS.MD', 'agent'],
      ['nested.dir/Dockerfile', 'docker'],
      ['tools/Containerfile', 'docker'],
      ['build.Dockerfile', 'docker'],
      ['.dockerignore', 'docker'],
      ['build.Dockerfile.dockerignore', 'docker'],
      ['compose.yaml', 'docker'],
      ['compose.yml', 'docker'],
      ['docker-compose.yaml', 'docker'],
      ['nested.dir/DOCKER-COMPOSE.YML', 'docker'],
      ['compose.override.yaml', 'docker'],
      ['compose.override.yml', 'docker'],
      ['docker-compose.override.yaml', 'docker'],
      ['docker-compose.override.yml', 'docker'],
      ['service.compose.yaml', 'yaml'],
      ['compose.prod.yaml', 'yaml'],
      ['settings.yaml', 'yaml'],
      ['project.npmignore', 'ignore'],
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
      ['firmware.BIN', 'binary'],
      ['payload.blob', 'binary'],
      ['data.dat', 'binary'],
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

  it('Shares the C icon with generic headers and reserves C++ for its own suffixes', () => {
    const mar = resolveIconTheme('mar');
    for (const [name, id] of [
      ['main.c', 'c'],
      ['main.cpp', 'cpp'],
      ['main.cxx', 'cpp'],
      ['main.cc', 'cpp'],
      ['main.c++', 'cpp'],
      ['include/widget.hpp', 'cpp'],
      ['include/widget.hxx', 'cpp'],
      ['include/widget.hh', 'cpp'],
      ['include/widget.h++', 'cpp'],
      ['include/shared.h', 'c'],
      ['include/shared.H', 'c'],
      ['include/kernel.cuh', 'cuda']
    ] as const) {
      expect(mar.resolveFile(name, true)).toMatchObject({
        kind: 'sprite',
        href: expect.stringMatching(new RegExp(`#mar-file-${id}$`, 'u'))
      });
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

  it('Registers only MAR File Icons', () => {
    expect(iconThemes).toEqual([resolveIconTheme('mar')]);
    expect(isIconThemeId('mar')).toBe(true);
    expect(isIconThemeId('seti')).toBe(false);
    expect(isIconThemeId('material')).toBe(false);
  });

  it('keeps the default on storage failure and confirms a later successful write', () => {
    const storage = new Map<string, string>();
    const failure = new Error('Storage unavailable');
    const setItem = vi.fn((key: string, value: string) => storage.set(key, value));
    setItem.mockImplementationOnce(() => {
      throw failure;
    });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem
    });
    const service = createIconThemePreferenceService();

    expect(() => service.setTheme('mar')).toThrow(failure);
    expect(service.theme.value).toBe('mar');
    expect(storage.has(ICON_THEME_STORAGE_KEY)).toBe(false);

    service.setTheme('mar');
    expect(storage.get(ICON_THEME_STORAGE_KEY)).toBe('mar');
    expect(createIconThemePreferenceService().theme.value).toBe('mar');
  });
});
