import { afterEach, describe, expect, it } from 'vitest';
import { commonMessages } from '../../src/i18n/messages.js';
import {
  workbenchCompositionEnUS,
  workbenchCompositionZhCN
} from '../../src/i18n/workbench-composition.js';
import { localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import { noticePresentation } from '../../src/util/workbench-presentation.js';

function leaves(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') return { [prefix]: value };
  if (typeof value !== 'object' || value === null) return {};
  return Object.assign(
    {},
    ...Object.entries(value).map(([key, nested]) =>
      leaves(nested, prefix === '' ? key : `${prefix}.${key}`)
    )
  );
}

const originalLocale = localePreferenceService().locale.value;
afterEach(() => localePreferenceService().setLocale(originalLocale));

describe('Workbench composition message ownership', () => {
  it('keeps the same keys and interpolation contracts across supported locales', () => {
    const english = leaves(workbenchCompositionEnUS);
    const chinese = leaves(workbenchCompositionZhCN);
    expect(Object.keys(english).sort()).toEqual(Object.keys(chinese).sort());
    for (const [key, value] of Object.entries(english)) {
      expect((value.match(/\{[^}]+\}/gu) ?? []).sort()).toEqual(
        (chinese[key]!.match(/\{[^}]+\}/gu) ?? []).sort()
      );
    }
  });

  it.each([
    ['en-US', workbenchCompositionEnUS],
    ['zh-CN', workbenchCompositionZhCN]
  ] as const)(
    'includes every composition message in the standalone runtime: %s',
    (locale, messages) => {
      const merged = leaves(commonMessages[locale]);
      for (const [key, value] of Object.entries(leaves(messages))) {
        expect(merged[key], key).toBe(value);
      }
    }
  );

  it.each([
    ['en-US', 'Commit ID copied.'],
    ['zh-CN', '已复制 Commit ID。']
  ] as const)('keeps copy notices neutral: %s', (locale, message) => {
    localePreferenceService().setLocale(locale);
    expect(noticePresentation(message)).toBe('info');
  });
});
