import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ElMessage, ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import SettingsContent from '../../src/view/settings/SettingsContent.vue?unit-render';
import QuickPromptSettings from '../../src/view/settings/QuickPromptSettings.vue?unit-render';
import PersonalInstructionsSettings from '../../src/view/settings/PersonalInstructionsSettings.vue?unit-render';
import { i18n, localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import {
  flushComponent,
  renderComponent,
  textContent,
  trigger
} from './support/component-renderer.js';

const locale = localePreferenceService().locale.value;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localePreferenceService().setLocale(locale);
});

describe('Public personal settings ownership', () => {
  it('leaves identity and organization policy outside public personal settings', () => {
    const source = readFileSync('src/view/settings/SettingsContent.vue', 'utf8');
    expect(source).not.toMatch(
      /oauth-bindings|\/api\/organizations|EnterpriseManagement|ORGANIZATION/
    );
  });

  it.each([
    ['account', 'Account security'],
    ['appearance', 'Theme'],
    ['shortcuts', 'Shortcuts'],
    ['registration', 'Node registration'],
    ['about', '3.7.9-fixture'],
    ['quick-prompts', 'Quick Prompts'],
    ['personal-instructions', 'Personal Instructions']
  ] as const)(
    'renders the %s section and host-owned extension content',
    async (section, content) => {
      vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
      vi.stubGlobal('document', {
        documentElement: {
          setAttribute() {},
          removeAttribute() {},
          classList: { add() {}, remove() {} },
          style: { setProperty() {}, removeProperty() {} }
        }
      });
      localePreferenceService().setLocale('en-US');
      const request = vi.fn();
      const app = createSSRApp({
        render: () =>
          h(
            SettingsContent,
            {
              section,
              webVersion: '3.7.9-fixture',
              sessions: [],
              newPassword: '',
              passwordValidationError: '',
              registrationToken: undefined,
              loading: false,
              changePassword: async () => true,
              formatSessionTime: String,
              request,
              quickPrompts: [],
              quickPromptsLoading: false,
              quickPromptsFailed: false,
              refreshQuickPrompts: async () => undefined
            },
            {
              'account-identity': () => h('p', 'Host identity extension'),
              'registration-owner': () => h('p', 'Host registration extension')
            }
          )
      });
      app.use(i18n).use(ElementPlus);
      app.provide(ID_INJECTION_KEY, { prefix: 951, current: 0 });
      app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
      const html = await renderToString(app);
      expect(html.toLowerCase()).toContain(content.toLowerCase());
      expect(html.includes('Host identity extension')).toBe(section === 'account');
      expect(html.includes('Host registration extension')).toBe(section === 'registration');
      expect(request).not.toHaveBeenCalled();
    }
  );

  it('loads and saves personal instructions through the API without persisting their contents', async () => {
    vi.stubGlobal('Document', class {});
    vi.stubGlobal('ShadowRoot', class {});
    const storage = {
      getItem: vi.fn().mockReturnValue('stale-browser-fixture'),
      setItem: vi.fn(),
      removeItem: vi.fn()
    };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);
    vi.spyOn(ElMessage, 'success').mockImplementation(() => ({ close() {} }));
    const error = vi.spyOn(ElMessage, 'error').mockImplementation(() => ({ close() {} }));
    const instructions = {
      common: 'API-only private instructions',
      codex: 'Codex draft',
      claudeCode: '',
      openCode: '',
      marAgent: 'MAR Agent draft'
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ instructions })
      .mockRejectedValueOnce(new Error('Fixture save unavailable'))
      .mockResolvedValue({ instructions });
    const view = renderComponent(PersonalInstructionsSettings, { request });
    try {
      await flushComponent();
      expect(request).toHaveBeenCalledWith('/api/personal-instructions');
      const editor = view.findAll('textarea')[0]!;
      expect(editor).toMatchObject({ value: instructions.common });
      await trigger(editor, 'onUpdate:modelValue', 'Changed API-only instructions');
      const save = view.findAll('ElButton').find((node) => node.props['type'] === 'primary')!;
      await trigger(save, 'onClick');
      expect(error).toHaveBeenCalledOnce();
      expect(view.findAll('textarea')[0]).toMatchObject({ value: 'Changed API-only instructions' });
      await trigger(save, 'onClick');
      expect(request).toHaveBeenLastCalledWith('/api/personal-instructions/COMMON', {
        method: 'PUT',
        body: JSON.stringify({ content: 'Changed API-only instructions' })
      });
      expect(storage.getItem).not.toHaveBeenCalled();
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });

  it('saves quick prompts through the API and refreshes without browser persistence', async () => {
    localePreferenceService().setLocale('en-US');
    const storage = {
      getItem: vi.fn().mockReturnValue('stale-browser-fixture'),
      setItem: vi.fn(),
      removeItem: vi.fn()
    };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);
    vi.spyOn(ElMessage, 'success').mockImplementation(() => ({ close() {} }));
    const request = vi.fn().mockResolvedValue({});
    const refresh = vi.fn().mockResolvedValue(undefined);
    const view = renderComponent(QuickPromptSettings, {
      request,
      refresh,
      prompts: [],
      loading: false,
      failed: false
    });
    try {
      await flushComponent();
      await trigger(view.findAll('ElButton')[0]!, 'onClick');
      const inputs = view.findAll('ElInput');
      await trigger(inputs[0]!, 'onUpdate:modelValue', 'private-prompt');
      await trigger(inputs[1]!, 'onUpdate:modelValue', 'API-only quick prompt body');
      const save = view.findAll('ElButton').find((node) => textContent(node).trim() === 'Save')!;
      await trigger(save, 'onClick');
      expect(request).toHaveBeenCalledWith('/api/quick-prompts', {
        method: 'POST',
        body: JSON.stringify({ phrase: 'private-prompt', prompt: 'API-only quick prompt body' })
      });
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(view.findAll('ElDialog')).toHaveLength(0);
      expect(storage.getItem).not.toHaveBeenCalled();
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });
});
