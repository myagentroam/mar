import { describe, expect, it } from 'vitest';
import { parseFileEditorDefaultMode } from '../../src/service/FileEditorPreferenceService.js';
import { codeEditorLanguage } from '../../src/util/code-editor-language.js';

describe('Web File Editor Preferences', () => {
  it('Defaults to edit mode and only accepts explicit read-only preferences', () => {
    expect(parseFileEditorDefaultMode(undefined)).toBe('edit');
    expect(parseFileEditorDefaultMode('edit')).toBe('edit');
    expect(parseFileEditorDefaultMode('invalid')).toBe('edit');
    expect(parseFileEditorDefaultMode('read-only')).toBe('read-only');
  });

  it('Uses and loads the CodeMirror language registry for Vue and supported source files', async () => {
    const fixtures: readonly (readonly [path: string, name: string])[] = [
      ['src/App.vue', 'Vue'],
      ['src/main.tsx', 'TSX'],
      ['src/server.php', 'PHP'],
      ['src/query.sql', 'SQL'],
      ['src/service.go', 'Go'],
      ['src/styles.scss', 'SCSS'],
      ['config/settings.yaml', 'YAML'],
      ['scripts/update.ps1', 'PowerShell'],
      ['Dockerfile.local', 'Dockerfile']
    ];
    for (const [path, name] of fixtures) {
      const language = codeEditorLanguage(path);
      expect(language?.name).toBe(name);
      if (language === undefined) throw new Error(`Expected a language for ${path}`);
      await expect(language.load()).resolves.toHaveProperty('language');
    }
    expect(codeEditorLanguage('notes.txt')).toBeUndefined();
  });
});
