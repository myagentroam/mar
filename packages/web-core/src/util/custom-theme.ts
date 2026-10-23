import { CUSTOM_THEME_TOKENS, type BuiltinTheme } from '../model/custom-theme.js';

export interface ThemeWarning {
  readonly code: 'structure' | 'name' | 'version' | 'colors' | 'unknown' | 'color' | 'contrast';
  readonly field: string;
}
export interface ThemeAnalysis {
  readonly validJson: boolean;
  readonly name?: string | undefined;
  readonly colors: Record<string, string>;
  readonly warnings: readonly ThemeWarning[];
}
const tokens = new Set<string>(CUSTOM_THEME_TOKENS);
const hexColor = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function luminance(hex: string): number | undefined {
  if (hex.length === 5) {
    if (hex.slice(-1).toLowerCase() !== 'f') return undefined;
    hex = hex.slice(0, 4);
  } else if (hex.length === 9) {
    if (hex.slice(-2).toLowerCase() !== 'ff') return undefined;
    hex = hex.slice(0, 7);
  }
  const value =
    hex.length === 4
      ? hex
          .slice(1)
          .split('')
          .map((c) => c + c)
          .join('')
      : hex.slice(1);
  if (value.length !== 6) return undefined;
  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

export function analyzeCustomTheme(source: string): ThemeAnalysis {
  const warnings: ThemeWarning[] = [];
  const colors: Record<string, string> = {};
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { validJson: false, colors, warnings };
  }
  const warn = (code: ThemeWarning['code'], field = '') => warnings.push({ code, field });
  if (!isObject(value)) {
    warn('structure');
    return { validJson: true, colors, warnings };
  }
  const name = typeof value.name === 'string' && value.name.trim() ? value.name : undefined;
  if (!name) warn('name', 'name');
  if (value.version !== 1) warn('version', 'version');
  for (const key of Object.keys(value)) {
    if (!['name', 'version', 'colors'].includes(key)) warn('unknown', key);
  }
  if (!isObject(value.colors)) warn('colors', 'colors');
  else
    for (const [key, color] of Object.entries(value.colors)) {
      if (!tokens.has(key)) warn('unknown', key);
      else if (typeof color !== 'string' || !hexColor.test(color)) warn('color', key);
      else colors[key] = color;
    }
  // Assess only explicit opaque pairs; inherited/translucent colors need visual inspection.
  for (const [foreground, background] of [
    ['--mar-text-primary', '--mar-bg-panel'],
    ['--mar-text-secondary', '--mar-bg-panel'],
    ['--mar-text-primary', '--mar-bg-chrome'],
    ['--mar-text-secondary', '--mar-bg-chrome'],
    ['--mar-text-primary', '--mar-fill-selection'],
    ['--mar-text-secondary', '--mar-fill-selection'],
    ['--mar-conversation-text', '--mar-conversation-surface'],
    ['--mar-conversation-muted', '--mar-conversation-surface'],
    ['--mar-color-on-accent', '--mar-color-brand']
  ] as const) {
    const a = colors[foreground] ? luminance(colors[foreground]!) : undefined;
    const b = colors[background] ? luminance(colors[background]!) : undefined;
    if (
      a !== undefined &&
      b !== undefined &&
      (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) < 4.5
    ) {
      warn('contrast', `${foreground} / ${background}`);
    }
  }
  return { validJson: true, name, colors, warnings };
}

export function createThemeSource(name: string, colors: Record<string, string> = {}): string {
  return JSON.stringify({ version: 1, name, colors }, null, 2);
}

export function themeColorScheme(colors: Record<string, string>): BuiltinTheme {
  const color = colors['--mar-bg-page'] ?? '';
  // The default canvas is dark. Transparent backgrounds cannot determine a light scheme.
  const brightness = hexColor.test(color) ? luminance(color) : undefined;
  return brightness !== undefined && brightness > 0.5 ? 'daylight' : 'vscode-dark-2026';
}
