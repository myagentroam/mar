import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ID_INJECTION_KEY } from 'element-plus';
import { i18n, localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import LoginPage from '../../src/view/LoginPage.vue';
import PasswordGate from '../../src/view/PasswordGate.vue';
import SystemInformationPage from '../../src/view/SystemInformationPage.vue';

afterEach(() => vi.unstubAllGlobals());

describe('independently composed public pages', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'renders password authentication without global UI registration or identity-provider requests (%s)',
    async (locale) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      localePreferenceService().setLocale(locale);
      const app = createSSRApp({
        render: () =>
          h('main', [
            h(LoginPage, { loading: false, logoUrl: '/logo.png' }),
            h(PasswordGate, { loading: false, password: '', validationError: '' })
          ])
      });
      app.use(i18n);
      app.provide(ID_INJECTION_KEY, { prefix: 100, current: 0 });
      const html = await renderToString(app);
      expect(html).toContain('autocomplete="username"');
      expect(html).toContain('autocomplete="new-password"');
      expect(html).not.toMatch(/OAuth|License|auth\.title|passwordGate\.title/u);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('renders only system status when no product extension is installed', async () => {
    const request = vi.fn();
    localePreferenceService().setLocale('en-US');
    const app = createSSRApp(SystemInformationPage, {
      authenticated: true,
      isAdmin: true,
      logoUrl: '/logo.png',
      onlineNodeCount: 1,
      nodeCount: 2,
      serverVersion: '0.9.63',
      request
    });
    const html = await renderToString(app);
    expect(html).toContain('System Status');
    expect(html).toContain('0.9.63');
    expect(html).toContain('1/2');
    expect(html).not.toContain('License');
    expect(request).not.toHaveBeenCalled();
  });

  it('mounts only the explicitly supplied privileged system extension', async () => {
    const extension = defineComponent({
      setup: () => () => h('div', { 'data-extension': 'fixture' })
    });
    for (const isAdmin of [true, false]) {
      const app = createSSRApp(SystemInformationPage, {
        authenticated: true,
        isAdmin,
        logoUrl: '/logo.png',
        onlineNodeCount: 0,
        nodeCount: 0,
        request: vi.fn(),
        extension
      });
      expect((await renderToString(app)).includes('data-extension="fixture"')).toBe(isAdmin);
    }
  });
});
