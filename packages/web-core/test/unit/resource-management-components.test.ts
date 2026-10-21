import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import NodePage from '../../src/view/settings/NodeManagementPage.vue';
import WorkspacePage from '../../src/view/settings/WorkspaceManagementPage.vue';
import { i18n } from '../../src/service/LocalePreferenceService.js';
import { commonMessages } from '../../src/i18n/messages.js';
afterEach(() => vi.unstubAllGlobals());
describe('Public resource management', () => {
  it('owns resource and hosting flows without enterprise ownership policy', () => {
    const source = readFileSync(
      new URL('../../src/view/settings/ResourceManagementPanel.vue', import.meta.url),
      'utf8'
    );
    expect(source).not.toMatch(
      /@\/|props\.role|props\.edition|ORGANIZATION|ENTERPRISE|ownerOrganizationId|\/api\/resource-grants|enableConversationHosting/u
    );
    for (const operation of [
      'registerNode',
      'saveEdit',
      'removeResource',
      'pushUpgrade',
      'cancelUpgrade',
      'openDetails',
      'refreshNodeDetails'
    ])
      expect(source).toContain(operation);
    expect(source).toContain('await refreshNodeDetails(row)');
    expect(source).toContain('@refresh-node="refreshNodeDetails()"');
  });
  it('separates the registration form from the successful token receipt', () => {
    const source = readFileSync(
      new URL('../../src/view/settings/ResourceManagementPanel.vue', import.meta.url),
      'utf8'
    );
    const form = source.slice(
      source.indexOf('v-if="registrationOpen"'),
      source.indexOf('v-if="registrationToken"')
    );
    const receipt = source.slice(source.indexOf('v-if="registrationToken"'));
    expect(form).toContain(':loading="creatingRegistrationToken"');
    expect(form).not.toContain('registration-help-link');
    expect(form).not.toContain('{{ registrationToken }}');
    expect(receipt).toContain('registrationTokenCreated');
    expect(receipt).toContain('registrationTokenInstructions');
    expect(receipt).toContain('{{ registrationToken }}');
    expect(receipt).toContain('registration-help-link');
    expect(receipt).toContain('v-if="documentationAvailable"');
    expect(receipt).toContain('registrationToken =');
  });
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
