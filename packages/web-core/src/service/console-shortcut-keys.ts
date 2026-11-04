import type { ConsoleShortcutKey } from './console-keyboard-shortcut-service.js';

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
  { key: 'm', alt: true }
] as const satisfies readonly ConsoleShortcutKey[];

const controlOrMetaShift = (key: string): readonly ConsoleShortcutKey[] => [
  { key, ctrl: true, shift: true },
  { key, meta: true, shift: true }
];
export const workspaceKeys = {
  close: [
    { key: 'w', code: 'KeyW', alt: true },
    { key: 'w', code: 'KeyW', ctrl: true },
    { key: 'w', code: 'KeyW', alt: true, shift: true },
    { key: 'w', code: 'KeyW', ctrl: true, shift: true }
  ],
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
  symbols: [{ key: 'm', alt: true }],
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

export function shortcutKeyLabel(key: ConsoleShortcutKey, aria = false): string {
  const arrows: Record<string, string> = {
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓'
  };
  const parts = [
    key.ctrl && (aria ? 'Control' : 'Ctrl'),
    key.meta && 'Meta',
    key.alt && 'Alt',
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
