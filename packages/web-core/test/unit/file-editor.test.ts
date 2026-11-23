import { describe, expect, it } from 'vitest';
import {
  fileEditorPreferenceService,
  parseFileEditorDefaultMode
} from '../../src/service/file-editor-preference-service.js';
import { codeEditorLanguage } from '../../src/util/code-editor-language.js';

describe('Web File Editor Preferences', () => {
  it('defaults to read-only without storage or a valid preference and honors explicit choices', () => {
    expect(fileEditorPreferenceService().mode.value).toBe('read-only');
    expect(parseFileEditorDefaultMode(undefined)).toBe('read-only');
    expect(parseFileEditorDefaultMode(null)).toBe('read-only');
    expect(parseFileEditorDefaultMode('edit')).toBe('edit');
    expect(parseFileEditorDefaultMode('invalid')).toBe('read-only');
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
