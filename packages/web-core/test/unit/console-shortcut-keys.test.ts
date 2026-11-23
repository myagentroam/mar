import { describe, expect, it } from 'vitest';
import {
  composerModelKeys,
  composerSendKeys,
  fileKeys,
  shortcutKeysLabel,
  workspaceKeys
} from '../../src/service/console-shortcut-keys.js';
import {
  invokeConsoleShortcut,
  type ConsoleShortcutBinding
} from '../../src/service/console-keyboard-shortcut-service.js';

describe('console shortcut presentation', () => {
  it('puts the browser-safe new-session chord first without changing Control to Command', () => {
    expect(shortcutKeysLabel(workspaceKeys.newSession, false)).toBe('Alt+N / Ctrl+N');
    expect(shortcutKeysLabel(workspaceKeys.newSession, true)).toBe('Option+N / Control+N');
  });

  it('selects the platform chord when Control and Meta are interchangeable', () => {
    expect(shortcutKeysLabel(fileKeys.find, false)).toBe('Ctrl+F');
    expect(shortcutKeysLabel(fileKeys.find, true)).toBe('Command+F');
    expect(shortcutKeysLabel(fileKeys.back, true)).toBe('Option+←');
  });

  it('keeps Control for the Composer chord that steers a run', () => {
    expect(shortcutKeysLabel([composerSendKeys[1]], true)).toBe('Control+Enter');
  });

  it.each([composerModelKeys, fileKeys.symbols].map((keys) => ({ keys })))(
    'handles the advertised Option+M when the keyboard reports a modified character ($keys)',
    ({ keys }) => {
      const binding: ConsoleShortcutBinding = {
        command: 'option-m',
        scope: 'pane',
        priority: 0,
        keys,
        when: () => true,
        execute: () => 'HANDLED'
      };
      expect(shortcutKeysLabel(keys, true)).toBe('Option+M');
      expect(
        invokeConsoleShortcut(binding, { key: 'µ', code: 'KeyM', altKey: true } as KeyboardEvent)
      ).toBe('HANDLED');
      expect(invokeConsoleShortcut(binding, { key: 'm', code: 'KeyM' } as KeyboardEvent)).toBe(
        'IGNORED'
      );
    }
  );
});
