import type { ConsoleShortcutKey } from './console-keyboard-shortcut-service.js';
import { translate } from './locale-preference-service.js';

/** Shared product key declarations; ownership and actions remain with their domains. */
export const activityToggleKeys = [
  { key: 'e', ctrl: true, shift: true },
  { key: 'e', meta: true, shift: true }
] as const satisfies readonly ConsoleShortcutKey[];

export const composerSendKeys = [
  { key: 'Enter' },
  { key: 'Enter', ctrl: true },
  { key: 'Enter', meta: true },
  { key: 'Enter', ctrl: true, meta: true }
] as const satisfies readonly ConsoleShortcutKey[];

export const composerStopKeys = [
  { key: 'Escape' }
] as const satisfies readonly ConsoleShortcutKey[];
export const composerModelKeys = [
  { key: 'm', code: 'KeyM', alt: true }
] as const satisfies readonly ConsoleShortcutKey[];

const controlOrMetaShift = (key: string): readonly ConsoleShortcutKey[] => [
  { key, ctrl: true, shift: true },
  { key, meta: true, shift: true }
];
export const closeTabKeys = [
  { key: 'w', code: 'KeyW', alt: true },
  { key: 'w', code: 'KeyW', ctrl: true }
] as const satisfies readonly ConsoleShortcutKey[];
export const closeAllTabsKeys = [
  { key: 'w', code: 'KeyW', alt: true, shift: true },
  { key: 'w', code: 'KeyW', ctrl: true, shift: true }
] as const satisfies readonly ConsoleShortcutKey[];

export const workspaceKeys = {
  close: [...closeTabKeys, ...closeAllTabsKeys],
  newSession: [
    { key: 'n', code: 'KeyN', alt: true },
    { key: 'n', code: 'KeyN', ctrl: true }
  ],
  cycle: [
    { key: 'ArrowLeft', alt: true },
    { key: 'ArrowRight', alt: true },
    { key: 'Tab', ctrl: true },
    { key: 'Tab', ctrl: true, shift: true }
  ],
  numbered: Array.from({ length: 10 }, (_, index) => ({
    key: String(index),
    code: `Digit${index}`,
    ctrl: true
  })),
  preview: controlOrMetaShift('v'),
  quickOpen: controlOrMetaShift('o'),
  search: controlOrMetaShift('f'),
  changes: controlOrMetaShift('k'),
  terminal: [
    { key: '`', code: 'Backquote', ctrl: true, shift: true },
    { key: '`', code: 'Backquote', meta: true, shift: true }
  ]
} as const satisfies Record<string, readonly ConsoleShortcutKey[]>;

const controlOrMeta = (key: string): readonly ConsoleShortcutKey[] => [
  { key, ctrl: true },
  { key, meta: true }
];
export const fileKeys = {
  back: [{ key: 'ArrowLeft', alt: true }],
  forward: [{ key: 'ArrowRight', alt: true }],
  find: controlOrMeta('f'),
  selectAll: controlOrMeta('a'),
  toggleEdit: controlOrMeta('e'),
  replace: controlOrMeta('h'),
  save: controlOrMeta('s'),
  symbols: [{ key: 'm', code: 'KeyM', alt: true }],
  dismiss: [{ key: 'Escape' }],
  choose: [{ key: 'Enter' }, { key: 'Enter', ctrl: true }, { key: 'Enter', meta: true }]
} as const satisfies Record<string, readonly ConsoleShortcutKey[]>;

export const queueKeys = {
  save: [{ key: 'Enter' }, { key: 'Enter', meta: true }],
  execute: [
    { key: 'Enter', ctrl: true },
    { key: 'Enter', ctrl: true, meta: true }
  ]
} as const satisfies Record<string, readonly ConsoleShortcutKey[]>;

export const findNavigationKeys = [
  { key: 'Enter' },
  { key: 'Enter', shift: true }
] as const satisfies readonly ConsoleShortcutKey[];

export const diffNavigationKeys = [
  { key: 'ArrowLeft' },
  { key: 'ArrowRight' },
  { key: 'ArrowUp' },
  { key: 'ArrowDown' }
] as const satisfies readonly ConsoleShortcutKey[];

export function shortcutKeyLabel(key: ConsoleShortcutKey, aria = false, apple = false): string {
  const arrows: Record<string, string> = {
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓'
  };
  const parts = [
    key.ctrl && (aria || apple ? 'Control' : 'Ctrl'),
    key.meta && (!aria && apple ? 'Command' : 'Meta'),
    key.alt && (!aria && apple ? 'Option' : 'Alt'),
    key.shift && 'Shift',
    key.key === 'Escape' && !aria
      ? 'Esc'
      : !aria && arrows[key.key] !== undefined
        ? arrows[key.key]
        : key.key.length === 1
          ? key.key.toUpperCase()
          : key.key
  ].filter(Boolean);
  return parts.join(aria ? '+' : ' + ');
}

export function shortcutKeysLabel(
  keys: readonly ConsoleShortcutKey[],
  apple = typeof navigator !== 'undefined' && /^(Mac|iPhone|iPad|iPod)/u.test(navigator.platform)
): string {
  const preferred = apple ? 'meta' : 'ctrl';
  const alternate = apple ? 'ctrl' : 'meta';
  return keys
    .filter(
      (key) =>
        !key[alternate] ||
        key[preferred] ||
        !keys.some(
          (candidate) =>
            candidate[preferred] &&
            !candidate[alternate] &&
            candidate.key === key.key &&
            candidate.code === key.code &&
            Boolean(candidate.alt) === Boolean(key.alt) &&
            Boolean(candidate.shift) === Boolean(key.shift)
        )
    )
    .map((key) => shortcutKeyLabel(key, false, apple).replaceAll(' + ', '+'))
    .join(' / ');
}

export function shortcutTooltip(label: string, keys: readonly ConsoleShortcutKey[] = []): string {
  return keys.length > 0
    ? translate('keyboardShortcuts.actionHint', { label, keys: shortcutKeysLabel(keys) })
    : label;
}
