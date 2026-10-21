import { describe, expect, it } from 'vitest';
import { resolvedColorToHex } from '../../src/util/theme-palette.js';

describe('Built-in color serialization', () => {
  it('materializes aliases and computed srgb colors as accepted portable hex values', () => {
    expect(resolvedColorToHex('rgb(19, 25, 34)')).toBe('#131922');
    expect(resolvedColorToHex('rgba(48, 147, 255, 0.14)')).toBe('#3093ff24');
    expect(resolvedColorToHex('color(srgb 1 0.5 0 / 0.5)')).toBe('#ff800080');
    expect(resolvedColorToHex('color(srgb 0 0 0)')).toBe('#000000');
    expect(() => resolvedColorToHex('var(--missing)')).toThrow('UNSUPPORTED_BUILTIN_THEME_COLOR');
  });
});
