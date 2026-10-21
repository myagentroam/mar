import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import CompactSettings from '../../src/view/settings/MarAgentCompactSettings.vue';
import { createMarAgentCompactService } from '../../src/service/MarAgentCompactService.js';
import { i18n } from '../../src/service/LocalePreferenceService.js';
import { commonMessages } from '../../src/i18n/messages.js';
import type { MarAgentCompactConfiguration } from '@myagentroam/protocol';

const configuration: MarAgentCompactConfiguration = {
  enabled: true,
  modelId: 'coding-compact',
  reasoningEffort: 'high'
};

describe('MAR Agent compact web service', () => {
  it('loads configuration and the managed model directory from fixed management routes', async () => {
    const calls = vi.fn();
    const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls(path, init);
      if (path === '/api/admin/mar-agent/compact') return { configuration } as T;
      return { models: [{ id: 'coding-compact', enabled: true }] } as T;
    };
    const signal = new AbortController().signal;
    const service = createMarAgentCompactService(request);
    await expect(service.load(signal)).resolves.toEqual({
      configuration,
      models: [{ id: 'coding-compact', enabled: true }]
    });
    expect(calls).toHaveBeenNthCalledWith(1, '/api/admin/mar-agent/compact', { signal });
    expect(calls).toHaveBeenNthCalledWith(2, '/api/admin/mar-agent/models', { signal });
  });

  it('saves a schema-normalised payload and parses the server response', async () => {
    const calls = vi.fn();
    const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls(path, init);
      return { configuration } as T;
    };
    const signal = new AbortController().signal;
    const service = createMarAgentCompactService(request);
    await expect(
      service.save({ enabled: false, modelId: null, reasoningEffort: null }, signal)
    ).resolves.toEqual(configuration);
    expect(calls).toHaveBeenCalledWith('/api/admin/mar-agent/compact', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, modelId: null, reasoningEffort: null }),
      signal
    });
  });

  it.each([
    ['settings', { models: [] } as never],
    ['save response', { configuration: { enabled: true, modelId: null } } as never]
  ])('rejects malformed %s payloads', async (_kind, payload) => {
    const request = async (): Promise<unknown> => payload;
    const service = createMarAgentCompactService(request as never);
    if (_kind === 'settings')
      await expect(service.load(new AbortController().signal)).rejects.toThrow();
    else await expect(service.save(configuration, new AbortController().signal)).rejects.toThrow();
  });
});

describe('MAR Agent compact settings form', () => {
  it('keeps complete bilingual copy for the dedicated compaction model', () => {
    expect(commonMessages['en-US'].marAgentModels.compactSave).toBe('Save');
    expect(commonMessages['zh-CN'].marAgentModels.compactSave).toBe('保存');
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const messages = commonMessages[locale].marAgentModels;
      for (const key of [
        'compactTab',
        'compactHint',
        'compactEnabled',
        'compactModel',
        'compactEffort',
        'compactModelRequired',
        'compactEffortRequired',
        'compactSave',
        'compactSaved'
      ] as const)
        expect(typeof messages[key]).toBe('string');
    }
  });

  it('renders the disabled form shell before data is ready in both locales', async () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      i18n.global.locale.value = locale;
      const app = createSSRApp({
        render: () =>
          h(CompactSettings, { request: (async () => ({}) as never) as never, writable: true })
      });
      app.use(i18n).use(ElementPlus);
      app.provide(ID_INJECTION_KEY, { prefix: 947, current: 0 });
      app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
      const html = await renderToString(app);
      expect(html).toContain(commonMessages[locale].marAgentModels.compactHint);
      expect(html).toContain(commonMessages[locale].marAgentModels.compactSave);
      expect(html).toContain('el-form');
    }
  });

  it('gates writes, resets effort on model change and aborts the load lifetime', () => {
    const source = readFileSync(
      new URL('../../src/view/settings/MarAgentCompactSettings.vue', import.meta.url),
      'utf8'
    );
    expect(source).toContain('createMarAgentCompactService(props.request)');
    expect(source).toContain('if (!props.writable || busy.value || !ready.value || !form.value)');
    expect(source).toContain('@change="modelChanged"');
    expect(source).toContain('resolveMarAgentDefaultReasoningEffort');
    expect(source).toContain("translate('marAgentModels.compactModelRequired')");
    expect(source).toContain("translate('marAgentModels.compactEffortRequired')");
    expect(source).toContain(':disabled="!writable || busy || !ready"');
    expect(source).toContain('onBeforeUnmount(() => lifetime.abort())');
  });

  it('lives in MAR Agent management, not in the system configuration page', () => {
    const modelPage = readFileSync(
      new URL('../../src/view/settings/MarAgentModelManagementPage.vue', import.meta.url),
      'utf8'
    );
    const systemPage = readFileSync(
      new URL('../../src/view/settings/SystemConfigurationPage.vue', import.meta.url),
      'utf8'
    );
    expect(modelPage).toContain(
      "import MarAgentCompactSettings from './MarAgentCompactSettings.vue'"
    );
    expect(modelPage).toContain('<MarAgentCompactSettings');
    expect(modelPage).toContain("translate('promptCompletion.advanced')");
    expect(modelPage).toContain("translate('promptCompletion.compact')");
    expect(systemPage).not.toContain('MarAgentCompact');
    expect(systemPage).not.toContain('compactTab');
  });
});
