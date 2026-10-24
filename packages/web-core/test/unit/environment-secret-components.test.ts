import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, h, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ElMessage, ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import SecretPage from '../../src/view/settings/SecretManagementPage.vue?unit-render';
import Details from '../../src/view/settings/NodeDetailsDialogs.vue?unit-render';
import SecretManager from '../../src/view/settings/EnvironmentSecretManager.vue?unit-render';
import {
  flushComponent,
  renderComponent,
  textContent,
  trigger
} from './support/component-renderer.js';
import { i18n } from '../../src/service/locale-preference-service.js';
import { commonMessages } from '../../src/i18n/messages.js';
import { AuthenticationContextChangedError } from '../../src/service/workbench-http-service.js';

const originalLocale = i18n.global.locale.value;
beforeEach(() => vi.stubGlobal('HTMLElement', class {}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  i18n.global.locale.value = originalLocale;
});

describe('Public environment secret management', () => {
  it.each([
    [new AuthenticationContextChangedError(), 0],
    [new DOMException('Request aborted', 'AbortError'), 1],
    [new Error('Request failed'), 1]
  ] as const)('reports only current pagination failures (%s)', async (cause, expectedMessages) => {
    vi.stubGlobal('window', {
      location: { search: '', href: 'http://fixture/console' },
      history: { replaceState: vi.fn() },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
    });
    const error = vi.spyOn(ElMessage, 'error').mockImplementation(() => ({ close() {} }));
    const request = vi.fn().mockRejectedValue(cause);
    const view = renderComponent(SecretManager, { request, scopes: ['PERSONAL'], writable: true });
    try {
      await flushComponent();
      expect(request).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledTimes(expectedMessages);
    } finally {
      view.unmount();
    }
  });

  it.each([undefined, false, true])(
    'reads only the permitted Workspace scope (permission=%s) and resets on target change',
    async (manageable) => {
      vi.stubGlobal('window', {
        location: { search: '' },
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
      });
      const workspaceId = ref('workspace/one');
      const request = vi.fn(async () => ({
        secrets: [
          {
            id: 'node-secret',
            scope: 'NODE',
            nodeId: 'node/id',
            workspaceId: null,
            name: 'WRONG_NODE',
            value: 'node-only'
          },
          {
            id: 'other-workspace',
            scope: 'WORKSPACE',
            nodeId: 'node/id',
            workspaceId: 'workspace/other',
            name: 'WRONG_WORKSPACE',
            value: 'other-only'
          },
          {
            id: 'target',
            scope: 'WORKSPACE',
            nodeId: 'node/id',
            workspaceId: workspaceId.value,
            name: 'TARGET_WORKSPACE',
            value: workspaceId.value
          }
        ]
      }));
      const view = renderComponent(
        defineComponent({
          setup: () => () =>
            h(Details, {
              request,
              nodeOpen: false,
              workspaceOpen: true,
              usageOpen: false,
              workspace: { id: workspaceId.value, label: 'Workspace fixture', path: '/fixture' },
              workspaceNodeId: 'node/id',
              workspaceSecretManageable: manageable,
              secretWritable: true
            })
        })
      );
      try {
        await flushComponent();
        if (manageable !== true) {
          expect(request).not.toHaveBeenCalled();
          expect(textContent(view.root)).not.toContain('TARGET_WORKSPACE');
          return;
        }
        expect(request).toHaveBeenCalledWith(
          '/api/environment-secrets?nodeId=node%2Fid&workspaceId=workspace%2Fone'
        );
        expect(textContent(view.root)).toContain('TARGET_WORKSPACE');
        expect(textContent(view.root)).not.toMatch(/WRONG_NODE|WRONG_WORKSPACE/u);
        const add = view.findAll('ElButton').find((node) => node.props['type'] === 'primary')!;
        await trigger(add, 'onClick');
        expect(view.findAll('ElForm')).toHaveLength(1);
        workspaceId.value = 'workspace/two';
        await flushComponent();
        expect(request).toHaveBeenLastCalledWith(
          '/api/environment-secrets?nodeId=node%2Fid&workspaceId=workspace%2Ftwo'
        );
        expect(view.findAll('ElForm')).toHaveLength(0);
        expect(textContent(view.root)).not.toContain('workspace/one');
      } finally {
        view.unmount();
      }
    }
  );
  it('does not import enterprise ownership policy', () => {
    const source = readFileSync(
      new URL('../../src/view/settings/EnvironmentSecretManager.vue', import.meta.url),
      'utf8'
    );
    expect(source).not.toMatch(/@\/|ORGANIZATION|ENTERPRISE|organizationId/u);
  });

  it('passes host form context, saves through the API, and reports failures without browser persistence', async () => {
    i18n.global.locale.value = 'en-US';
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: { search: '', href: 'http://fixture/console' },
      history: { replaceState },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
    });
    const storage = {
      getItem: vi.fn().mockReturnValue('stale-browser-fixture'),
      setItem: vi.fn(),
      removeItem: vi.fn()
    };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);
    const error = vi.spyOn(ElMessage, 'error').mockImplementation(() => ({ close() {} }));
    vi.spyOn(ElMessage, 'success').mockImplementation(() => ({ close() {} }));
    let failSave = true;
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'POST' && failSave) throw new Error('Fixture save failure');
      return { secrets: [], page: 1, pageSize: 20, total: 0, hasMore: false };
    });
    const validate = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const view = renderComponent(
      SecretManager,
      { request, scopes: ['PERSONAL'], writable: true, formContext: { fixtureOwner: 27 } },
      {
        'create-fields': () => h('p', 'Host owner fields')
      },
      { validate }
    );
    try {
      await flushComponent();
      const keyword = view.findAll('ElInput')[0]!;
      await trigger(keyword, 'onUpdate:modelValue', 'fixture-filter');
      expect(replaceState.mock.calls.at(-1)?.[2]).toContain('secrets.keyword=fixture-filter');
      await trigger(
        view
          .findAll('ElButton')
          .find(
            (node) =>
              textContent(node).trim() ===
              commonMessages['en-US'].generated.environmentSecretManager.addSecret
          )!,
        'onClick'
      );
      expect(textContent(view.root)).toContain('Host owner fields');
      expect(view.findAll('ElForm')[0]?.props['model']).toMatchObject({ fixtureOwner: 27 });
      const inputs = view.findAll('ElInput').filter((node) => node !== keyword);
      await trigger(inputs[0]!, 'onUpdate:modelValue', 'FIXTURE_VALUE');
      await trigger(inputs[1]!, 'onUpdate:modelValue', 'fixture-only-value');
      await trigger(
        view.findAll('ElButton').find((node) => textContent(node).trim() === 'Save')!,
        'onClick'
      );
      expect(validate).toHaveBeenCalledOnce();
      expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
      await trigger(
        view.findAll('ElButton').find((node) => textContent(node).trim() === 'Save')!,
        'onClick'
      );
      expect(request).toHaveBeenCalledWith('/api/environment-secrets', {
        method: 'POST',
        body: JSON.stringify({
          scope: 'PERSONAL',
          name: 'FIXTURE_VALUE',
          value: 'fixture-only-value'
        })
      });
      expect(error).toHaveBeenCalledOnce();
      expect(view.findAll('ElForm')).toHaveLength(1);
      failSave = false;
      await trigger(
        view.findAll('ElButton').find((node) => textContent(node).trim() === 'Save')!,
        'onClick'
      );
      expect(view.findAll('ElForm')).toHaveLength(0);
      expect(storage.getItem).not.toHaveBeenCalled();
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });

  it.each(['en-US', 'zh-CN'] as const)(
    'has complete independent messages and read-only rendering in %s',
    async (locale) => {
      for (const file of [
        'view/settings/EnvironmentSecretManager.vue',
        'view/settings/SecretManagementPage.vue',
        'service/environment-secret-service.ts'
      ]) {
        const source = readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8');
        for (const match of source.matchAll(/translate\(\s*['"]([^'"]+)['"]/gu)) {
          let value: unknown = commonMessages[locale];
          for (const key of match[1]!.split('.')) value = (value as Record<string, unknown>)?.[key];
          expect(value, match[1]).toBeTypeOf('string');
        }
      }
      vi.stubGlobal('window', { location: { search: '' }, matchMedia: () => ({ matches: false }) });
      i18n.global.locale.value = locale;
      const request = vi.fn(async <T>() => ({ secrets: [] }) as T);
      const app = createSSRApp({
        render: () => h(SecretPage, { request, writable: false })
      });
      app.use(i18n).use(ElementPlus);
      app.provide(ID_INJECTION_KEY, { prefix: 921, current: 0 });
      app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
      const html = await renderToString(app);
      expect(html).toContain(
        commonMessages[locale].generated.environmentSecretManager.environmentSecrets
      );
      expect(html).not.toContain(
        commonMessages[locale].generated.environmentSecretManager.addSecret
      );
      expect(request).not.toHaveBeenCalled();
    }
  );
});
