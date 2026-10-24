import { ref, type Ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { commonMessages } from '../i18n/messages.js';
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  localeFromLanguages,
  type AppLocale
} from '../i18n/locale-config.js';

export {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  localeFromLanguages,
  type AppLocale
} from '../i18n/locale-config.js';

export function parseLocale(value: string | null | undefined): AppLocale | undefined {
  return SUPPORTED_LOCALES.find((candidate) => candidate.value === value)?.value;
}

export function localizedDocsPath(locale: AppLocale, path: string): string {
  const prefix =
    SUPPORTED_LOCALES.find((candidate) => candidate.value === locale)?.docsPrefix ??
    SUPPORTED_LOCALES.find((candidate) => candidate.value === DEFAULT_LOCALE)!.docsPrefix;
  return `${prefix}/${path}`;
}

export function resolveInitialLocale(input: {
  readonly stored: string | null;
  readonly languages: readonly string[];
}): AppLocale {
  return parseLocale(input.stored) ?? localeFromLanguages(input.languages);
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}

const initialLocale = resolveInitialLocale({
  stored: typeof localStorage === 'undefined' ? null : localStorage.getItem(LOCALE_STORAGE_KEY),
  languages: browserLanguages()
});

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale,
  fallbackLocale: DEFAULT_LOCALE,
  messages: commonMessages,
  missingWarn: false,
  fallbackWarn: false
});

export interface LocaleMessageCatalog {
  readonly [key: string]: string | LocaleMessageCatalog;
}

export function registerLocaleMessages(
  messages: Readonly<Record<AppLocale, LocaleMessageCatalog>>
): void {
  for (const { value } of SUPPORTED_LOCALES) i18n.global.mergeLocaleMessage(value, messages[value]);
}

export interface LocalePreferenceService {
  readonly locale: Ref<AppLocale>;
  setLocale(locale: AppLocale): void;
}

function applyLocale(locale: AppLocale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

export function createLocalePreferenceService(
  localeValue: AppLocale = currentLocale()
): LocalePreferenceService {
  const locale = ref<AppLocale>(localeValue);
  i18n.global.locale.value = locale.value;
  applyLocale(locale.value);
  return {
    locale,
    setLocale(next) {
      locale.value = next;
      i18n.global.locale.value = next;
      if (typeof localStorage !== 'undefined') localStorage.setItem(LOCALE_STORAGE_KEY, next);
      applyLocale(next);
    }
  };
}

const shared = createLocalePreferenceService();

if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key !== LOCALE_STORAGE_KEY) return;
    const next = parseLocale(event.newValue);
    if (next !== undefined && next !== shared.locale.value) shared.setLocale(next);
  });

export function localePreferenceService(): LocalePreferenceService {
  return shared;
}

export function currentLocale(): AppLocale {
  return parseLocale(i18n.global.locale.value) ?? DEFAULT_LOCALE;
}

export function translate(key: string, parameters?: Record<string, string | number>): string {
  return i18n.global.t(key, parameters ?? {});
}
