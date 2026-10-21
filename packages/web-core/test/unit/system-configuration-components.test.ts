import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import Page from '../../src/view/settings/SystemConfigurationPage.vue';
import { createSystemConfigurationService } from '../../src/service/SystemConfigurationService.js';
import { i18n } from '../../src/service/LocalePreferenceService.js';
import { commonMessages } from '../../src/i18n/messages.js';

afterEach(() => vi.unstubAllGlobals());
describe('Public system configuration page', () => {
  it('has no audit or enterprise policy in the default catalog or page', () => {
    for (const file of [
      'service/SystemConfigurationService.ts',
      'view/settings/SystemConfigurationPage.vue'
    ]) {
      expect(readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8')).not.toMatch(
        /audit-retention|auditRetention|ENTERPRISE|ORGANIZATION|@\/|manageEnterprise|localStorage|sessionStorage/u
      );
    }
    const service = createSystemConfigurationService(vi.fn() as never);
    expect(service.settings.map(({ key }) => key)).toEqual([
      'mail-smtp',
      'web-push',
      'html-preview-origin',
      'skill-tls'
    ]);
  });
  it.each(['zh-CN', 'en-US'] as const)(
    'renders the public page with independent messages in %s',
    async (locale) => {
      vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
      i18n.global.locale.value = locale;
      const service = createSystemConfigurationService(vi.fn() as never);
      const keys = service.settings.flatMap(({ nameKey, descriptionKey }) => [
        nameKey,
        descriptionKey
      ]);
      const source = readFileSync(
        new URL('../../src/view/settings/SystemConfigurationPage.vue', import.meta.url),
        'utf8'
      );
      keys.push(
        ...[...source.matchAll(/translate\(\s*['"]([^'"]+)['"]/gu)].map((match) => match[1]!)
      );
      for (const key of keys) {
        let value: unknown = commonMessages[locale];
        for (const part of key.split('.')) value = (value as Record<string, unknown>)?.[part];
        expect(value, key).toBeTypeOf('string');
      }
      const request = vi.fn(async <T>() => ({ skillTlsVerificationDisabled: false }) as T);
      const app = createSSRApp({ render: () => h(Page, { request, writable: false }) });
      app.use(i18n).use(ElementPlus);
      app.provide(ID_INJECTION_KEY, { prefix: 922, current: 0 });
      app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
      const html = await renderToString(app);
      expect(html).toContain(commonMessages[locale].generated.systemConfigurationPage.refresh);
      expect(html).not.toContain('audit-retention');
      expect(html).not.toContain('management-key');
      expect(html).not.toContain(locale === 'zh-CN' ? '运维管理密钥' : 'Operations management key');
      expect(request).not.toHaveBeenCalled();
    }
  );

  it('renders the complete system settings snapshot without local pagination', () => {
    const source = readFileSync(
      new URL('../../src/view/settings/SystemConfigurationPage.vue', import.meta.url),
      'utf8'
    );
    expect(source).toContain(':data="rows"');
    expect(source).not.toContain('managementPageItems');
    expect(source).not.toContain('<ManagementPagination');
  });
});
