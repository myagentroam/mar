import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createManagementComposition,
  type ManagementPageDefinition
} from '../../src/service/ManagementComposition.js';
import {
  currentLocale,
  localePreferenceService,
  parseLocale,
  registerLocaleMessages,
  resolveInitialLocale,
  translate
} from '../../src/service/LocalePreferenceService.js';

afterEach(() => vi.unstubAllGlobals());

describe('public locale composition', () => {
  it('accepts supported locale identifiers and honors saved preferences', () => {
    expect(parseLocale('en-US')).toBe('en-US');
    expect(parseLocale('zh-CN')).toBe('zh-CN');
    expect(parseLocale('en')).toBeUndefined();
    expect(resolveInitialLocale({ stored: 'en-US', languages: ['zh-CN'] })).toBe('en-US');
    expect(resolveInitialLocale({ stored: 'bad', languages: ['zh-TW'] })).toBe('zh-CN');
    expect(resolveInitialLocale({ stored: null, languages: ['en-GB', 'zh-CN'] })).toBe('en-US');
  });

  it('shares one locale between presentation, DOM and persisted preference', () => {
    const setItem = vi.fn();
    const documentElement = { lang: '' };
    vi.stubGlobal('document', { documentElement });
    vi.stubGlobal('localStorage', { setItem });
    localePreferenceService().setLocale('en-US');
    expect(currentLocale()).toBe('en-US');
    expect(documentElement.lang).toBe('en-US');
    expect(setItem).toHaveBeenCalledWith('mar.locale.v2', 'en-US');
    expect(translate('auth.login')).not.toBe('auth.login');
  });

  it('adds product messages without discarding common nested messages or another language', () => {
    registerLocaleMessages({
      'en-US': { compositionFixture: { title: 'Additional page' } },
      'zh-CN': { compositionFixture: { title: '附加页面' } }
    });
    for (const [locale, title] of [
      ['en-US', 'Additional page'],
      ['zh-CN', '附加页面']
    ] as const) {
      localePreferenceService().setLocale(locale);
      expect(translate('compositionFixture.title')).toBe(title);
      expect(translate('auth.login')).not.toBe('auth.login');
      expect(translate('generated.settingsContent.systemStatus')).not.toBe(
        'generated.settingsContent.systemStatus'
      );
    }
  });
});

describe('public management registry', () => {
  const admin = { authenticated: true, mustChangePassword: false };
  const system: ManagementPageDefinition = {
    id: 'system',
    order: 100,
    labelKey: 'system.title',
    component: {},
    visible: () => true,
    props: ({ request }) => ({ request })
  };
  const extension: ManagementPageDefinition = {
    ...system,
    id: 'extra-page',
    order: 20,
    labelKey: 'extra.title',
    visible: (user) => user.authenticated
  };

  it('uses the same ordered, current visibility for navigation and resolution', () => {
    const registry = createManagementComposition([system, extension]);
    expect(registry.items(admin).map(({ id }) => id)).toEqual(['extra-page', 'system']);
    expect(registry.resolve('extra-page', admin).id).toBe('extra-page');
    expect(registry.resolve('extra-page', { ...admin, authenticated: false }).id).toBe('system');
    expect(registry.resolve('unregistered', admin).id).toBe('system');
  });

  it('rejects duplicate IDs, a missing fallback and an inaccessible fallback', () => {
    expect(() => createManagementComposition([system, system])).toThrow(
      'WEB_MANAGEMENT_PAGE_DUPLICATE'
    );
    expect(() => createManagementComposition([extension])).toThrow(
      'WEB_MANAGEMENT_SYSTEM_PAGE_REQUIRED'
    );
    const registry = createManagementComposition([{ ...system, visible: () => false }]);
    expect(() => registry.resolve('missing', admin)).toThrow(
      'WEB_MANAGEMENT_SYSTEM_PAGE_UNAVAILABLE'
    );
  });
});
