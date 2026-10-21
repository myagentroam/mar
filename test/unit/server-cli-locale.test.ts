import { describe, expect, it } from 'vitest';
import { resolveCliLocale } from '../../ee/server/src/cli-locale';

describe('Server CLI locale', () => {
  it('uses an explicit supported locale before system settings', () => {
    expect(resolveCliLocale({ MAR_LOCALE: 'en-US', LANG: 'zh_CN.UTF-8' })).toBe('en-US');
    expect(resolveCliLocale({ MAR_LOCALE: 'zh-CN', LANG: 'en_US.UTF-8' })).toBe('zh-CN');
  });

  it('detects Chinese system locales and otherwise falls back to English', () => {
    expect(resolveCliLocale({ LC_ALL: 'zh_CN.UTF-8' })).toBe('zh-CN');
    expect(resolveCliLocale({ LC_MESSAGES: 'zh_TW.UTF-8' })).toBe('zh-CN');
    expect(resolveCliLocale({ LANG: 'de_DE.UTF-8' })).toBe('en-US');
    expect(resolveCliLocale({})).toBe('en-US');
  });
});
