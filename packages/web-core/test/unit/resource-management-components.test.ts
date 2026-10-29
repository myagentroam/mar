import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, h, provide } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import NodePage from '../../src/view/settings/NodeManagementPage.vue?unit-render';
import WorkspacePage from '../../src/view/settings/WorkspaceManagementPage.vue?unit-render';
import { i18n } from '../../src/service/locale-preference-service.js';
import { commonMessages } from '../../src/i18n/messages.js';
import { DOCUMENTATION_AVAILABLE_KEY } from '../../src/service/documentation-availability.js';
import {
  flushComponent,
  renderComponent,
  textContent,
  trigger
} from './support/component-renderer.js';
afterEach(() => vi.unstubAllGlobals());
describe('Public resource management', () => {
  it.each(['en-US', 'zh-CN'] as const)(
    'renders upgrade facts without claiming unconfirmed acceptance in %s',
    async (locale) => {
      vi.stubGlobal('window', {
        matchMedia: () => ({ matches: false }),
        location: { search: '', href: 'http://localhost/console' }
      });
      i18n.global.locale.value = locale;
      const messages = commonMessages[locale].generated.resourceSharingPage;
      const now = Date.now();
      const base = {
        attemptId: 'attempt',
        targetVersion: '1.2.3',
        installed: false,
        targetOnline: false,
        createdAt: now,
        updatedAt: now
      };
      const rows = [
        {
          nodeId: 'a',
          upgradeProgress: { ...base, state: 'WAITING_FOR_RUNS', requestAccepted: false }
        },
        {
          nodeId: 'b',
          upgradeProgress: {
            ...base,
            state: 'UPGRADING',
            step: 'WAITING_FOR_ONLINE',
            installed: true,
            lastReportReceivedAt: now
          }
        },
        { nodeId: 'c', upgradeProgress: { ...base, state: 'UPGRADING', step: 'INSTALLING' } },
        { nodeId: 'd', upgradeProgress: { ...base, state: 'WAITING_FOR_RUNS' } },
        {
          nodeId: 'e',
          connected: true,
          metadata: { upgrade: { state: 'WAITING_FOR_RUNS', activeRunCount: 123 } }
        },
        {
          nodeId: 'f',
          connected: true,
          upgradeProgress: null,
          metadata: { upgrade: { state: 'WAITING_FOR_RUNS', activeRunCount: 456 } }
        }
      ];
      const app = createSSRApp({
        render: () =>
          h(NodePage, {
            request: async () => ({}),
            writable: true,
            nodeUpgradeProgress: { d: { ...base, state: 'SUCCEEDED', updatedAt: now + 1 }, e: null }
          })
      });
      app.use(i18n).use(ElementPlus);
      app.provide(ID_INJECTION_KEY, { prefix: 944, current: 0 });
      app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
      app.component(
        'el-table',
        defineComponent({
          setup:
            (_, { slots }) =>
            () =>
              h('div', slots.default?.())
        })
      );
      app.component(
        'el-table-column',
        defineComponent({
          props: ['label'],
          setup:
            (props, { slots }) =>
            () =>
              h(
                'section',
                props.label === messages.upgradeStatus
                  ? rows.map((row) => h('span', slots.default?.({ row })))
                  : []
              )
        })
      );
      const html = await renderToString(app);
      expect(html).toContain(messages.upgradePendingConfirmation);
      expect(html).toContain(messages.upgradeInProgressOnline);
      expect(html).not.toContain(messages.upgradeWaitingLong);
      expect(html).toContain(messages.upgradeProgressInterrupted);
      expect(html).toContain(messages.upgradeCompleted);
      expect(html).toContain('1.2.3');
      expect(html).not.toContain('123');
      expect(html).toContain('456');
    }
  );
  it('owns resource and hosting flows without enterprise ownership policy', () => {
    const source = readFileSync(
      new URL('../../src/view/settings/ResourceManagementPanel.vue', import.meta.url),
      'utf8'
    );
    expect(source).not.toMatch(
      /@\/|props\.role|props\.edition|ORGANIZATION|ENTERPRISE|ownerOrganizationId|\/api\/resource-grants|enableConversationHosting/u
    );
  });
  it.each([false, true])(
    'shows a busy registration form and a key receipt with documentation=%s',
    async (documentationAvailable) => {
      vi.stubGlobal('window', {
        location: { href: 'https://console.example.com/console' },
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
      });
      i18n.global.locale.value = 'en-US';
      let complete!: (result: { token: string }) => void;
      const registration = new Promise<{ token: string }>((resolve) => {
        complete = resolve;
      });
      const request = vi.fn(async (path: string) => {
        if (path === '/api/node-registration-tokens') return registration;
        if (path.startsWith('/api/resources?'))
          return { nodes: [], workspaces: [], page: 1, pageSize: 20, total: 0, hasMore: false };
        throw new Error(`Unexpected request: ${path}`);
      });
      const view = renderComponent(
        defineComponent({
          setup() {
            provide(DOCUMENTATION_AVAILABLE_KEY, documentationAvailable);
            return () => h(NodePage, { request, writable: true });
          }
        })
      );
      const buttons = (label: string) =>
        view
          .findAll('ElButton')
          .find((node) => textContent(node).trim().toLowerCase() === label.toLowerCase())!;
      try {
        await flushComponent();
        await trigger(buttons('Register Node'), 'onClick');
        const form = view.findAll('ElForm')[0]!;
        const input = view.findAll('ElInput').find((node) => node.props['maxlength'] === '128')!;
        await trigger(input, 'onUpdate:modelValue', '  Fixture Node  ');
        expect(view.findAll('ElDialog')).toHaveLength(1);
        expect(view.findAll('ElLink')).toHaveLength(0);
        const submit = buttons('Create registration key');
        const saving = trigger(submit, 'onClick');
        await flushComponent();
        expect(submit.props['loading']).toBe(true);
        expect(form.props['disabled']).toBe(true);
        expect(request).toHaveBeenCalledWith('/api/node-registration-tokens', {
          method: 'POST',
          body: JSON.stringify({ displayName: 'Fixture Node' })
        });
        complete({ token: 'fixture-registration-key' });
        await saving;
        expect(view.findAll('ElForm')).toHaveLength(0);
        expect(textContent(view.root)).toContain('fixture-registration-key');
        expect(textContent(view.root)).toContain(
          commonMessages['en-US'].generated.resourceSharingPage.registrationTokenInstructions
        );
        expect(view.findAll('ElLink')).toHaveLength(documentationAvailable ? 1 : 0);
        if (documentationAvailable)
          expect(view.findAll('ElLink')[0]?.props['href']).toContain(
            '/deployment/node-installation'
          );
        await trigger(view.findAll('ElDialog')[0]!, 'onUpdate:modelValue', false);
        expect(view.findAll('ElDialog')).toHaveLength(0);
        expect(textContent(view.root)).not.toContain('fixture-registration-key');
      } finally {
        complete({ token: 'fixture-registration-key' });
        view.unmount();
      }
    }
  );
  it.each(['en-US', 'zh-CN'] as const)(
    'uses consistent user-facing registration wording in %s',
    (locale) => {
      const messages = commonMessages[locale].generated.resourceSharingPage;
      const label = locale === 'zh-CN' ? '注册密钥' : 'Registration key';
      expect(messages.registrationTokenLabel).toBe(label);
      expect(messages.registrationTokenCreated).toContain(label);
      expect(messages.registrationTokenInstructions).not.toMatch(
        /registrationToken|\bNode\b|\bKey\b|令牌/u
      );
      expect(messages.createOneTimeRegistrationToken).not.toMatch(/一次性|one-time|token/u);
    }
  );
  it.each(['en-US', 'zh-CN'] as const)(
    'renders the current Node application version and unknown fallback only for Nodes in %s',
    async (locale) => {
      vi.stubGlobal('window', {
        matchMedia: () => ({ matches: false }),
        location: { search: '', href: 'http://localhost/console' }
      });
      i18n.global.locale.value = locale;
      const messages = commonMessages[locale].generated;
      const rows = [
        { nodeAppVersion: '0.10.24', nodeVersion: 'v22.20.0' },
        { nodeVersion: 'v22.20.0' }
      ];
      for (const component of [NodePage, WorkspacePage]) {
        const request = vi.fn(async <T>() => ({}) as T);
        const app = createSSRApp({ render: () => h(component, { request, writable: true }) });
        app.use(i18n).use(ElementPlus);
        app.provide(ID_INJECTION_KEY, { prefix: 944, current: 0 });
        app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
        // Render column slots with representative rows without mounting a browser table.
        app.component(
          'el-table',
          defineComponent({
            setup:
              (_, { slots }) =>
              () =>
                h('div', slots.default?.())
          })
        );
        app.component(
          'el-table-column',
          defineComponent({
            props: ['prop', 'label'],
            setup:
              (props, { slots }) =>
              () =>
                h('section', [
                  h('h3', props.label),
                  ...(props.prop === 'nodeAppVersion'
                    ? rows.map((row) => h('span', slots.default?.({ row })))
                    : [])
                ])
          })
        );
        const html = await renderToString(app);
        if (component === NodePage) {
          expect(html).toContain(messages.resourceSharingPage.currentVersion);
          expect(html).toContain('0.10.24');
          expect(html).toContain(messages.nodeDetailsDialogs.unknown);
          expect(html.indexOf(messages.resourceSharingPage.currentVersion)).toBeLessThan(
            html.indexOf(messages.resourceSharingPage.upgradeStatus)
          );
        } else {
          expect(html).not.toContain(messages.resourceSharingPage.currentVersion);
          expect(html).not.toContain('0.10.24');
        }
        expect(html).not.toContain('v22.20.0');
        expect(request).not.toHaveBeenCalled();
      }
    }
  );
  it.each(['en-US', 'zh-CN'] as const)(
    'renders personal node and workspace entry points in %s',
    async (locale) => {
      vi.stubGlobal('window', {
        matchMedia: () => ({ matches: false }),
        location: { search: '', href: 'http://localhost/console' }
      });
      i18n.global.locale.value = locale;
      for (const name of ['ResourceManagementPanel', 'ResourceManagementFilters']) {
        const source = readFileSync(
          new URL(`../../src/view/settings/${name}.vue`, import.meta.url),
          'utf8'
        );
        for (const match of source.matchAll(/translate\(\s*['"]([^'"]+)['"]/gu)) {
          let value: unknown = commonMessages[locale];
          for (const key of match[1]!.split('.')) value = (value as Record<string, unknown>)?.[key];
          expect(value, match[1]).toBeTypeOf('string');
        }
      }
      for (const component of [NodePage, WorkspacePage]) {
        const request = vi.fn(async <T>() => ({}) as T);
        const app = createSSRApp({ render: () => h(component, { request, writable: true }) });
        app.use(i18n).use(ElementPlus);
        app.provide(ID_INJECTION_KEY, { prefix: 943, current: 0 });
        app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
        const html = await renderToString(app);
        expect(html).toContain('resource-management-panel');
        expect(html).not.toMatch(/organization|enterprise|组织|企业|授权/u);
        expect(request).not.toHaveBeenCalled();
      }
    }
  );
});
