import { MarMessageBox } from '../../src/service/message-box-service.js';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import SkillPage from '../../src/view/skill/SkillSourceManagementPage.vue?unit-render';
import McpPage from '../../src/view/skill/McpSourceManagementPage.vue?unit-render';
import { i18n } from '../../src/service/locale-preference-service.js';
import { commonMessages } from '../../src/i18n/messages.js';
import {
  flushComponent,
  renderComponent,
  textContent,
  trigger
} from './support/component-renderer.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Public source discovery and catalog management', () => {
  it('keeps organization policy outside both complete source pages', () => {
    for (const name of ['SkillSourceManagementPage', 'McpSourceManagementPage']) {
      const source = readFileSync(
        new URL(`../../src/view/skill/${name}.vue`, import.meta.url),
        'utf8'
      );
      expect(source).not.toMatch(
        /@\/|ORGANIZATION|ENTERPRISE|organizationId|\/api\/organizations/u
      );
    }
  });
  it.each(['en-US', 'zh-CN'] as const)(
    'renders both public entry points with complete messages in %s',
    async (locale) => {
      vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
      i18n.global.locale.value = locale;
      for (const [name, component] of [
        ['SkillSourceManagementPage', SkillPage],
        ['McpSourceManagementPage', McpPage]
      ] as const) {
        const source = readFileSync(
          new URL(`../../src/view/skill/${name}.vue`, import.meta.url),
          'utf8'
        );
        for (const match of source.matchAll(/translate\(\s*['"]([^'"]+)['"]/gu)) {
          let value: unknown = commonMessages[locale];
          for (const key of match[1]!.split('.')) value = (value as Record<string, unknown>)?.[key];
          expect(value, `${name}: ${match[1]}`).toBeTypeOf('string');
        }
        const request = vi.fn(async <T>() => ({}) as T);
        const app = createSSRApp({ render: () => h(component, { request, writable: false }) });
        app.use(i18n);
        app.directive('tooltip', { getSSRProps: () => ({}) });
        const html = await renderToString(app);
        expect(html).toContain('mar-management-page');
        expect(html).not.toMatch(/organization|enterprise|组织|企业/iu);
        expect(request).not.toHaveBeenCalled();
      }
    }
  );

  it.each([
    ['Skill', SkillPage, '/api/skill-sources', '/api/skill-favorites'],
    ['MCP', McpPage, '/api/mcp-sources', '/api/mcp-catalog']
  ] as const)(
    'initializes %s source controls and host extension even if the catalog read fails',
    async (name, component, sourcePath, catalogPath) => {
      vi.stubGlobal('window', {
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
      });
      vi.stubGlobal('Document', class {});
      vi.stubGlobal('ShadowRoot', class {});
      i18n.global.locale.value = 'en-US';
      feedback.error.mockClear();
      const loadExtension = vi.fn(async () => {});
      const request = vi.fn(async (path: string) => {
        if (path === sourcePath)
          return {
            sources: [
              {
                id: 'source',
                name: 'Complete source',
                locator: 'https://example.com/source',
                scope: 'PERSONAL',
                enabled: true,
                kind: 'REPOSITORY',
                manageable: true
              }
            ]
          };
        if (path === `${sourcePath}/source/skills`) return { skills: [] };
        if (path.startsWith(`${catalogPath}?`)) throw new Error('Catalog unavailable');
        throw new Error(`Unexpected GET ${path}`);
      });
      const view = renderComponent(component, { request, writable: true, loadExtension });
      try {
        await flushComponent();
        expect(loadExtension).toHaveBeenCalledOnce();
        if (name === 'Skill') expect(request).toHaveBeenCalledWith(`${sourcePath}/source/skills`);
        const search = view
          .findAll('MarButton')
          .find((node) => textContent(node).trim() === 'Search');
        expect(search?.props.disabled).toBe(false);
        expect(feedback.error).toHaveBeenCalledExactlyOnceWith('Catalog unavailable');
      } finally {
        view.unmount();
      }
    }
  );

  it.each([
    ['Skill', SkillPage, '/api/skill-sources', '/api/skill-favorites'],
    ['MCP', McpPage, '/api/mcp-sources', '/api/mcp-catalog']
  ] as const)(
    'renders %s source extensions and requires confirmation before disabling a source',
    async (_name, component, sourcePath, catalogPath) => {
      vi.stubGlobal('window', {
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
      });
      vi.stubGlobal('Document', class {});
      vi.stubGlobal('ShadowRoot', class {});
      i18n.global.locale.value = 'en-US';

      const confirm = vi
        .spyOn(MarMessageBox, 'confirm')
        .mockRejectedValueOnce('cancel')
        .mockResolvedValue('confirm' as Awaited<ReturnType<typeof MarMessageBox.confirm>>);
      const source = {
        id: 'source/id',
        name: 'Complete source',
        locator: 'https://example.com/source',
        scope: 'PERSONAL',
        enabled: true,
        builtIn: false,
        kind: 'REPOSITORY',
        status: 'READY',
        manageable: true
      };
      const candidate = {
        id: 'candidate',
        name: 'Candidate skill',
        serverName: 'candidate-mcp',
        displayName: 'Candidate MCP',
        version: '1.0.0',
        description: 'Visible candidate description',
        source: 'source/id',
        skillPath: 'skills/candidate',
        installs: null,
        runtime: { transport: 'stdio', command: 'fixture-mcp' }
      };
      const request = vi.fn(async (path: string, init?: RequestInit) => {
        if (path === sourcePath) return { sources: [source] };
        if (path === `${sourcePath}/source%2Fid`) {
          source.enabled = false;
          return {};
        }
        if (path.startsWith(catalogPath))
          return { favorites: [], entries: [], page: 1, pageSize: 20, total: 0, hasMore: false };
        if (path.startsWith(`${sourcePath}/source%2Fid/`))
          return { skills: [candidate], servers: [candidate] };
        throw new Error(`Unexpected ${init?.method ?? 'GET'} ${path}`);
      });
      const view = renderComponent(
        component,
        { request, writable: true },
        {
          'source-ownership': () => h('p', 'Host source ownership'),
          'catalog-ownership': () => h('p', 'Host catalog ownership')
        }
      );
      const button = (label: string) =>
        view
          .findAll('MarButton')
          .find((node) => textContent(node).trim().toLowerCase() === label.toLowerCase())!;
      try {
        await flushComponent();
        await trigger(button(_name === 'Skill' ? 'Add skill source' : 'Add MCP source'), 'onClick');
        expect(textContent(view.root)).toContain('Host source ownership');
        const sourceDialog = view.findAll('MarDialog')[0]!;
        await trigger(sourceDialog, 'onUpdate:modelValue', false);
        if (_name === 'MCP') await trigger(button('Search'), 'onClick');
        expect(textContent(view.root)).toContain('Visible candidate description');
        const add = view
          .findAll('MarButton')
          .find((node) => /Add to (?:catalog|MCP)/iu.test(textContent(node)))!;
        await trigger(add, 'onClick');
        expect(textContent(view.root)).toContain('Host catalog ownership');
        await trigger(view.findAll('MarDialog')[0]!, 'onUpdate:modelValue', false);
        await trigger(button('Disable'), 'onClick');
        expect(confirm).toHaveBeenCalledOnce();
        expect(request.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
        await trigger(button('Disable'), 'onClick');
        expect(request).toHaveBeenCalledWith(
          `${sourcePath}/source%2Fid`,
          expect.objectContaining({
            method: 'PATCH',
            body: JSON.stringify({ enabled: false })
          })
        );
      } finally {
        view.unmount();
      }
    }
  );
});

const feedback = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn()
}));
vi.mock('../../src/service/mar-message-presenter.js', () => ({
  presentMessage: (message: string, type: keyof typeof feedback) => feedback[type](message),
  dismissMessages: vi.fn()
}));
