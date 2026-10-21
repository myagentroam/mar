export const LOCALE_STORAGE_KEY = 'mar.locale.v2';
export const DEFAULT_LOCALE = 'zh-CN';

export const SUPPORTED_LOCALES = [
  {
    value: 'zh-CN',
    nativeLabel: '简体中文',
    docsPrefix: '/docs',
    browserPrefixes: ['zh']
  },
  {
    value: 'en-US',
    nativeLabel: 'English',
    docsPrefix: '/docs/en-US',
    browserPrefixes: ['en']
  }
] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number]['value'];

export function localeFromLanguages(languages: readonly string[]): AppLocale {
  for (const language of languages) {
    const normalized = language.toLowerCase();
    const locale = SUPPORTED_LOCALES.find((candidate) =>
      candidate.browserPrefixes.some((prefix) => normalized.startsWith(prefix))
    );
    if (locale !== undefined) return locale.value;
  }
  return DEFAULT_LOCALE;
}
