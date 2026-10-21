import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsContent from '../../src/view/settings/SettingsContent.vue';
import QuickPromptSettings from '../../src/view/settings/QuickPromptSettings.vue';
import { i18n, localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import { commonMessages } from '../../src/i18n/messages.js';
import type { SettingsSection } from '../../src/model/settings.js';

const originalLocale = localePreferenceService().locale.value;
beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal('document', {
    documentElement: {
      lang: '',
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
      classList: { add: vi.fn(), remove: vi.fn() }
    }
  });
});
afterEach(() => {
  localePreferenceService().setLocale(originalLocale);
  vi.unstubAllGlobals();
});

async function render(section: SettingsSection, slots = {}) {
  const request = vi.fn(async <T>() => ({}) as T);
  const app = createSSRApp({
    render: () =>
      h(
        SettingsContent,
        {
          section,
          webVersion: 'test-version',
          sessions: [],
          newPassword: '',
          changePassword: async () => false,
          passwordValidationError: '',
          registrationToken: undefined,
          loading: false,
          formatSessionTime: String,
          request,
          quickPrompts: [],
          quickPromptsLoading: false,
          quickPromptsFailed: false,
          refreshQuickPrompts: async () => undefined
        },
        slots
      )
  });
  app.use(i18n).use(ElementPlus);
  app.provide(ID_INJECTION_KEY, { prefix: 810, current: 0 });
  app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
  return { html: await renderToString(app), request };
}

describe('Shared personal settings components', () => {
  it.each(['en-US', 'zh-CN'] as const)(
    'preserves loaded quick prompts and disables their actions during refresh: %s',
    async (locale) => {
      localePreferenceService().setLocale(locale);
      const app = createSSRApp(QuickPromptSettings, {
        prompts: [{ id: 'review', phrase: 'review', prompt: 'Review this change', updatedAt: 1 }],
        loading: true,
        failed: false,
        request: vi.fn(),
        refresh: async () => undefined
      });
      app.use(i18n).use(ElementPlus);
      app.provide(ID_INJECTION_KEY, { prefix: 811, current: 0 });
      app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
      const html = await renderToString(app);
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('#review');
      expect(html).toContain('Review this change');
      expect(html).not.toContain(commonMessages[locale].quickPrompts.empty);
      expect(html.match(/<button\b[^>]*\bdisabled/gu)).toHaveLength(3);
    }
  );

  it.each(['en-US', 'zh-CN'] as const)(
    'renders localized about, shortcuts and account without enterprise requests: %s',
    async (locale) => {
      localePreferenceService().setLocale(locale);
      const about = await render('about');
      expect(about.html).toContain('test-version');
      expect(about.html).toContain('THIRD_PARTY_NOTICES.txt');
      expect(about.html).toContain(commonMessages[locale].settings.about);
      for (const component of [
        'Vue',
        'Fastify',
        'mysql2',
        'Nodemailer',
        'Web Push',
        'node-pty',
        'node-datachannel',
        'Playwright',
        'QuickJS',
        'MCP SDK',
        'ripgrep',
        'Universal Ctags',
        'Material Icon Theme'
      ]) {
        expect(about.html).toContain(component);
      }
      expect(about.html).toContain(
        locale === 'zh-CN' ? '查看 Web 第三方许可声明' : 'View Web third-party notices'
      );
      expect(about.html).toContain(
        locale === 'zh-CN' ? '不是完整依赖清单' : 'not a complete dependency inventory'
      );
      expect(about.request).not.toHaveBeenCalled();
      const shortcuts = await render('shortcuts');
      expect(shortcuts.html).toContain(commonMessages[locale].keyboardShortcuts.saveEditor);
      expect(shortcuts.html).toContain(commonMessages[locale].keyboardShortcuts.platformHint);
      const groups = [
        ['workspace', 9, 'openNotificationCenter'],
        ['files', 10, 'quickOpenWorkspaceFile'],
        ['editing', 9, 'findInPreview'],
        ['composer', 10, 'saveQueuedMessage']
      ] as const;
      const sections = [
        ...shortcuts.html.matchAll(
          /<section class="shortcut-group" aria-labelledby="shortcut-([^"]+)"[^>]*>([\s\S]*?)<\/section>/g
        )
      ];
      expect(sections).toHaveLength(groups.length);
      for (const [index, [group, count, example]] of groups.entries()) {
        expect(sections[index]?.[1]).toBe(group);
        expect(sections[index]?.[2]).toContain(commonMessages[locale].shortcutGroups[group]);
        expect(sections[index]?.[2]).toContain(commonMessages[locale].keyboardShortcuts[example]);
        expect(sections[index]?.[2]?.match(/<dd\b[^>]*>/g)).toHaveLength(count);
      }
      for (const [key, description] of Object.entries(commonMessages[locale].keyboardShortcuts)) {
        if (key === 'platformHint') continue;
        expect(shortcuts.html).toContain(description);
      }
      const account = await render('account');
      expect(account.html).not.toContain('oauth-bindings');
      expect(account.html).toContain('utility-control');
      expect(account.html).toContain('account-actions');
      expect(account.request).not.toHaveBeenCalled();
    }
  );

  it.each(['en-US', 'zh-CN'] as const)(
    'renders the custom theme editor with localized controls: %s',
    async (locale) => {
      localePreferenceService().setLocale(locale);
      const result = await render('custom-themes');
      expect(result.html).toContain(commonMessages[locale].customThemes.title);
      expect(result.html).toContain(commonMessages[locale].customThemes.view);
      expect(result.html).toContain(commonMessages[locale].customThemes.apply);
      expect(result.html).toContain(commonMessages[locale].customThemes.copyJson);
      expect(result.html).toContain(commonMessages[locale].customThemes.expandPreview);
      expect(result.html).toContain(commonMessages[locale].customThemes.preview);
      expect(result.html).not.toContain('customThemes.');
      expect(result.request).not.toHaveBeenCalled();
    }
  );

  it('renders host identity and registration ownership only in their corresponding slots', async () => {
    const slots = {
      'account-identity': () => h('aside', 'identity-extension'),
      'registration-owner': () => h('aside', 'ownership-extension')
    };
    const account = await render('account', slots);
    expect(account.html).toContain('identity-extension');
    expect(account.html).not.toContain('ownership-extension');
    const registration = await render('registration', slots);
    expect(registration.html).toContain('ownership-extension');
    expect(registration.html).not.toContain('identity-extension');
    expect(registration.request).not.toHaveBeenCalled();
  });

  it.each(['en-US', 'zh-CN'] as const)(
    'renders quick prompt and personal instruction sections with public messages: %s',
    async (locale) => {
      localePreferenceService().setLocale(locale);
      const prompts = await render('quick-prompts');
      expect(prompts.html).toContain(commonMessages[locale].quickPrompts.title);
      const instructions = await render('personal-instructions');
      expect(instructions.html).toContain('MAR Agent');
      expect(instructions.html).not.toContain('personalInstructions.title');
    }
  );
});
