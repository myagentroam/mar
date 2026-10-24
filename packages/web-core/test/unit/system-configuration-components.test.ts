import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ElMessage, ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import Page from '../../src/view/settings/SystemConfigurationPage.vue?unit-render';
import { createSystemConfigurationService } from '../../src/service/system-configuration-service.js';
import { i18n } from '../../src/service/locale-preference-service.js';
import { commonMessages } from '../../src/i18n/messages.js';
import {
  flushComponent,
  renderComponent,
  textContent,
  trigger
} from './support/component-renderer.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('Public system configuration page', () => {
  it('has no audit or enterprise policy in the default catalog or page', () => {
    for (const file of [
      'service/system-configuration-service.ts',
      'view/settings/SystemConfigurationPage.vue'
    ]) {
      expect(readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8')).not.toMatch(
        /audit-retention|auditRetention|ENTERPRISE|ORGANIZATION|@\/|manageEnterprise/u
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

  it('renders the complete configuration and never persists its snapshot in browser storage', async () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    const storage = {
      getItem: vi.fn().mockReturnValue('stale-browser-fixture'),
      setItem: vi.fn(),
      removeItem: vi.fn()
    };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);
    const settings = Array.from({ length: 25 }, (_, index) => ({
      key: `extension-${index}`,
      field: `field-${index}`,
      payloadField: 'enabled',
      nameKey: 'common.save',
      descriptionKey: 'common.cancel',
      type: 'boolean' as const,
      initialValue: false
    }));
    const request = vi.fn().mockResolvedValue({
      smtpConfiguration: '{}',
      skillTlsVerificationDisabled: true,
      htmlPreviewOrigin: 'https://preview.example.com',
      webPushEnabled: true,
      ...Object.fromEntries(settings.map(({ field }) => [field, true]))
    });
    const view = renderComponent(Page, { request, writable: false, settings });
    try {
      await flushComponent();
      const tableRows = view.findAll('ElTable')[0]?.props['data'] as { key: string }[];
      expect(tableRows.map(({ key }) => key)).toEqual([
        ...settings.map(({ key }) => key),
        'mail-smtp',
        'web-push',
        'html-preview-origin',
        'skill-tls'
      ]);
      expect(textContent(view.root)).toContain('https://preview.example.com');
      expect(view.findAll('ElPagination')).toHaveLength(0);
      expect(request).toHaveBeenCalledWith('/api/system-settings');
      expect(storage.getItem).not.toHaveBeenCalled();
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });
  it('cancels without writing and retains failed drafts before applying the authoritative saved snapshot', async () => {
    i18n.global.locale.value = 'en-US';
    const storage = {
      getItem: vi.fn().mockReturnValue('stale-browser-fixture'),
      setItem: vi.fn(),
      removeItem: vi.fn()
    };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);
    vi.spyOn(ElMessage, 'success').mockImplementation(() => ({ close() {} }));
    const error = vi.spyOn(ElMessage, 'error').mockImplementation(() => ({ close() {} }));
    let failSave = true;
    const snapshot = {
      smtpConfiguration: '{}',
      extensionValue: true,
      skillTlsVerificationDisabled: false,
      webPushEnabled: false,
      htmlPreviewOrigin: ''
    };
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        if (failSave) throw new Error('Fixture save unavailable');
        return { ...snapshot, extensionValue: false };
      }
      return snapshot;
    });
    const settings = [
      {
        key: 'extension/setting',
        field: 'extensionValue',
        payloadField: 'value',
        nameKey: 'common.save',
        descriptionKey: 'common.cancel',
        type: 'boolean' as const,
        initialValue: false
      }
    ];
    const view = renderComponent(Page, { request, writable: true, settings });
    const button = (label: string) =>
      view.findAll('ElButton').find((node) => textContent(node).trim() === label)!;
    try {
      await flushComponent();
      await trigger(button('Edit'), 'onClick');
      await trigger(view.findAll('ElSwitch')[0]!, 'onUpdate:modelValue', false);
      await trigger(button('Cancel'), 'onClick');
      expect(request).toHaveBeenCalledTimes(1);
      expect(view.findAll('ElSwitch')[0]?.props['modelValue']).toBe(true);
      await trigger(button('Edit'), 'onClick');
      await trigger(view.findAll('ElSwitch')[0]!, 'onUpdate:modelValue', false);
      await trigger(button('Save'), 'onClick');
      expect(error).toHaveBeenCalledOnce();
      expect(view.findAll('ElSwitch')[0]?.props['modelValue']).toBe(false);
      failSave = false;
      await trigger(button('Save'), 'onClick');
      expect(request).toHaveBeenLastCalledWith('/api/system-settings/extension%2Fsetting', {
        method: 'PATCH',
        body: JSON.stringify({ value: false })
      });
      expect(view.findAll('ElButton').some((node) => textContent(node).trim() === 'Save')).toBe(
        false
      );
      expect(view.findAll('ElSwitch')[0]?.props['modelValue']).toBe(false);
      expect(storage.getItem).not.toHaveBeenCalled();
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });
});
