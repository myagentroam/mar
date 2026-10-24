import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import CompactSettings from '../../src/view/settings/MarAgentCompactSettings.vue';
import UnitCompactSettings from '../../src/view/settings/MarAgentCompactSettings.vue?unit-render';
import { renderComponent, flushComponent, trigger } from './support/component-renderer.js';
import { createMarAgentCompactService } from '../../src/service/mar-agent-compact-service.js';
import { i18n } from '../../src/service/locale-preference-service.js';
import { commonMessages } from '../../src/i18n/messages.js';
import type { MarAgentCompactConfiguration } from '@myagentroam/protocol';

vi.mock('../../src/service/message-feedback-service.js', () => ({ showMessage: vi.fn() }));

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

  it.each([false, true])(
    'gates saves and resets effort through the model control (writable=%s)',
    async (writable) => {
      const request = vi.fn(async (path: string, init?: RequestInit) => {
        if (path.endsWith('/models'))
          return {
            models: [
              {
                id: 'coding-compact',
                enabled: true,
                reasoningEfforts: ['high'],
                defaultReasoningEffort: 'high'
              },
              {
                id: 'other-model',
                enabled: true,
                reasoningEfforts: ['low', 'medium'],
                defaultReasoningEffort: 'medium'
              }
            ]
          };
        return {
          configuration: init?.method === 'PUT' ? JSON.parse(String(init.body)) : configuration
        };
      });
      const view = renderComponent(UnitCompactSettings, { request, writable });
      try {
        expect(view.findAll('ElForm')[0]!.props.disabled).toBe(true);
        await flushComponent();
        expect(view.findAll('ElForm')[0]!.props.disabled).toBe(!writable);
        const model = view.findAll('ElSelect')[0]!;
        await trigger(model, 'onUpdate:modelValue', 'other-model');
        await trigger(model, 'onChange', 'other-model');
        expect(view.findAll('ElSelect')[1]!.props.modelValue).toBe('medium');
        const save = view.findAll('ElButton').find((button) => button.props.type === 'primary')!;
        await trigger(save, 'onClick');
        const writes = request.mock.calls.filter(([, init]) => init?.method === 'PUT');
        expect(writes).toHaveLength(writable ? 1 : 0);
        if (writable)
          expect(JSON.parse(String(writes[0]![1]!.body))).toEqual({
            enabled: true,
            modelId: 'other-model',
            reasoningEffort: 'medium'
          });
      } finally {
        view.unmount();
      }
      expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    }
  );

  it.each(['modelId', 'reasoningEffort'])('rejects a missing %s without saving', async (field) => {
    const request = vi.fn(async (_path: string, _init?: RequestInit) => ({
      configuration,
      models: [
        {
          id: 'coding-compact',
          enabled: true,
          reasoningEfforts: ['high'],
          defaultReasoningEffort: 'high'
        }
      ]
    }));
    const validate = vi.fn(async () => false);
    const view = renderComponent(
      UnitCompactSettings,
      { request, writable: true },
      {},
      { validate }
    );
    try {
      await flushComponent();
      await trigger(
        view.findAll('ElSelect')[field === 'modelId' ? 0 : 1]!,
        'onUpdate:modelValue',
        null
      );
      const rules = view.findAll('ElForm')[0]!.props.rules as Record<
        string,
        Array<{
          validator: (rule: unknown, value: unknown, done: (error?: Error) => void) => void;
        }>
      >;
      const done = vi.fn();
      rules[field]![0]!.validator({}, null, done);
      expect(done).toHaveBeenCalledWith(
        new Error(
          i18n.global.t(
            field === 'modelId'
              ? 'marAgentModels.compactModelRequired'
              : 'marAgentModels.compactEffortRequired'
          )
        )
      );
      await trigger(
        view.findAll('ElButton').find((button) => button.props.type === 'primary')!,
        'onClick'
      );
      expect(validate).toHaveBeenCalledOnce();
      expect(request.mock.calls.every(([, init]) => init?.method !== 'PUT')).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it('aborts a pending load on unmount without admitting a save', async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const request = vi.fn((_path: string, _init?: RequestInit) => pending);
    const view = renderComponent(UnitCompactSettings, { request, writable: true });
    const signal = request.mock.calls[0]![1]!.signal!;
    await trigger(
      view.findAll('ElButton').find((button) => button.props.type === 'primary')!,
      'onClick'
    );
    expect(request).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(signal.aborted).toBe(true);
    release({ configuration, models: [] });
    await flushComponent();
    expect(request.mock.calls.every(([, init]) => init?.method !== 'PUT')).toBe(true);
  });

  it('keeps compact model policy outside system configuration', () => {
    const systemPage = readFileSync(
      new URL('../../src/view/settings/SystemConfigurationPage.vue', import.meta.url),
      'utf8'
    );
    expect(systemPage).not.toContain('MarAgentCompact');
    expect(systemPage).not.toContain('compactTab');
  });
});
