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

it('documents every canonical token in both languages without duplicate keys', async () => {
  const { CUSTOM_THEME_TOKENS, LEGACY_THEME_TOKENS } =
    await import('../../src/model/custom-theme.js');
  const { THEME_TOKEN_HELP } = await import('../../src/model/theme-token-help.js');
  const { personalSettingsEnUS: en } = await import('../../src/i18n/personal-settings.en-US.js');
  const { personalSettingsZhCN: zh } = await import('../../src/i18n/personal-settings.zh-CN.js');
  expect(new Set(CUSTOM_THEME_TOKENS).size).toBe(CUSTOM_THEME_TOKENS.length);
  for (const token of CUSTOM_THEME_TOKENS) {
    expect(token).toMatch(/^--mar-/u);
    const description = THEME_TOKEN_HELP[token].description;
    expect(en.customThemes.tokenDescriptions[description]).toBeTruthy();
    expect(zh.customThemes.tokenDescriptions[description]).toBeTruthy();
  }
  for (const target of Object.values(LEGACY_THEME_TOKENS))
    expect(CUSTOM_THEME_TOKENS).toContain(target);
});
