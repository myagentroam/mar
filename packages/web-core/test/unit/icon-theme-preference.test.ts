import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveIconTheme } from '../../src/icon-themes/index.js';
import {
  createIconThemePreferenceService,
  ICON_THEME_STORAGE_KEY,
  parseStoredIconThemePreference
} from '../../src/service/IconThemePreferenceService.js';

afterEach(() => vi.unstubAllGlobals());

describe('File Icon Theme Preferences', () => {
  it('Use Material by default and safely fall back from invalid values', () => {
    expect(parseStoredIconThemePreference(null)).toBe('material');
    expect(parseStoredIconThemePreference('')).toBe('material');
    expect(parseStoredIconThemePreference('unknown')).toBe('material');
    expect(parseStoredIconThemePreference('material')).toBe('material');
    expect(parseStoredIconThemePreference('seti')).toBe('seti');
  });

  it.each([null, '', 'unknown', 'seti', 'material'])(
    'Restore the icon theme from stored value %s without overwriting it',
    (stored) => {
      const storage = new Map<string, string>();
      if (stored !== null) storage.set(ICON_THEME_STORAGE_KEY, stored);
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value)
      });

      const service = createIconThemePreferenceService();

      expect(service.theme.value).toBe(stored === 'seti' ? 'seti' : 'material');
      expect(storage.get(ICON_THEME_STORAGE_KEY)).toBe(stored ?? undefined);
    }
  );

  it.each(['seti', 'material'] as const)(
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
});
