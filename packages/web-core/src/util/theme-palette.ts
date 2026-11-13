import { CUSTOM_THEME_TOKENS, type BuiltinTheme } from '../model/custom-theme.js';

// Resolve the existing stylesheet, including aliases and color-mix, rather than maintaining
// a second set of built-in colors. The isolated probe cannot inherit active custom overrides.
export function readBuiltinThemeColors(theme: BuiltinTheme): Record<string, string> {
  const probe = document.createElement('div');
  probe.className = 'mar-theme-preview';
  probe.dataset.theme = theme;
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;contain:strict;width:0;height:0;overflow:hidden';
  const swatch = document.createElement('span');
  probe.append(swatch);
  document.body.append(probe);
  try {
    const colors: Record<string, string> = {};
    for (const token of CUSTOM_THEME_TOKENS) {
      swatch.style.color = `var(${token})`;
      colors[token] = resolvedColorToHex(getComputedStyle(swatch).color);
    }
    return colors;
  } finally {
    probe.remove();
  }
}

export function resolvedColorToHex(value: string): string {
  const channels = value.match(/[0-9.]+/gu)?.map(Number);
  if (
    !channels ||
    (channels.length !== 3 && channels.length !== 4) ||
    (!value.startsWith('rgb(') && !value.startsWith('rgba(') && !value.startsWith('color(srgb '))
  ) {
    throw new Error('UNSUPPORTED_BUILTIN_THEME_COLOR');
  }
  const scale = value.startsWith('color(') ? 255 : 1;
  const hex = channels
    .slice(0, 3)
    .map((channel) =>
      Math.round(Math.max(0, Math.min(255, channel * scale)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('');
  const alpha = channels[3];
  return `#${hex}${
    alpha === undefined || alpha >= 1
      ? ''
      : Math.round(Math.max(0, alpha) * 255)
          .toString(16)
          .padStart(2, '0')
  }`;
}
