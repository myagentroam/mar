import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import Details from '../../src/view/settings/NodeDetailsDialogs.vue';
import RuntimeEnvironment from '../../src/view/settings/NodeRuntimeEnvironment.vue';
import WorkspaceGitSettings from '../../src/view/settings/WorkspaceGitSettings.vue';
import { i18n } from '../../src/service/LocalePreferenceService.js';
import { commonMessages } from '../../src/i18n/messages.js';

afterEach(() => vi.unstubAllGlobals());
describe('Public resource details', () => {
  it('provides default workbench details without requiring an enterprise slot', () => {
    const source = readFileSync(
      new URL('../../src/view/workbench/WorkbenchPage.vue', import.meta.url),
      'utf8'
    );
    expect(source).toMatch(/<slot name="resource-details"[^>]*>\s*<NodeDetailsDialogs/u);
    expect(source).toContain('@open-workspace-details="openWorkspaceDetails"');
    expect(source).toContain(
      ':workspace-secret-manageable="workspaceDetails?.workspace.manageable"'
    );
    expect(source).toContain(':node-refreshable="page.nodeDetails !== undefined"');
    expect(source).toContain('@refresh-node="refreshNodeDetails"');
    expect(source).toContain('await props.page.refreshNodes()');
  });
  it('keeps ownership policies and hosted management in the enterprise extension', () => {
    const source = readFileSync(
      new URL('../../src/view/settings/NodeDetailsDialogs.vue', import.meta.url),
      'utf8'
    );
    expect(source).not.toMatch(
      /@\/|ORGANIZATION|ENTERPRISE|ownerOrganizationId|ConversationHostingMaintenanceCard|enableHosting|disableHosting/u
    );
    expect(source).toContain('name="node-properties"');
    expect(source).toContain('name="node-sections"');
    expect(source).toContain('EnvironmentSecretManager');
    expect(source).toContain('@refresh="emit(\'refreshNode\')"');
    expect(source).toContain(':refreshable="nodeRefreshable"');
    expect(source).toContain(':refreshing="nodeRefreshing"');
  });
  it('keeps capability refresh next to the reported runtime environment', () => {
    const source = readFileSync(
      new URL('../../src/view/settings/NodeRuntimeEnvironment.vue', import.meta.url),
      'utf8'
    );
    expect(source).toContain("emit('refresh')");
    expect(source).toContain('generated.nodeDetailsDialogs.refreshCapabilities');
    expect(source).toContain('runtime-environment--refreshable');
    expect(source).toContain('position: absolute');
  });
  it('uses the standard available status for Computer Use in both locales', () => {
    expect(commonMessages['zh-CN'].generated.nodeRuntimeEnvironment.computerUseAvailable).toBe(
      '可用'
    );
    expect(commonMessages['en-US'].generated.nodeRuntimeEnvironment.computerUseAvailable).toBe(
      'Available'
    );
  });
  it('explains the npm upgrade target and Server version ceiling in both locales', () => {
    const zh =
      commonMessages['zh-CN'].generated.resourceSharingPage.upgradeToLimitedByTheLatestStable;
    const en =
      commonMessages['en-US'].generated.resourceSharingPage.upgradeToLimitedByTheLatestStable;
    expect(zh).toContain('npm 中不超过当前 Server 版本的最新稳定版本 {value0}');
    expect(en).toContain(
      'latest published stable npm version not exceeding the current Server version: {value0}'
    );
  });
  it('keeps Workspace Git settings concise without stale message keys', () => {
    const source = readFileSync(
      new URL('../../src/view/settings/WorkspaceGitSettings.vue', import.meta.url),
      'utf8'
    );
    expect(source).toContain('workspace-git-controls');
    expect(source).toContain('workspace-git-hint');
    expect(source).not.toContain('personalGit.workspaceScope');
    expect(source).not.toContain('personalGit.appliesLater');
  });
  it.each(['en-US', 'zh-CN'] as const)(
    'renders the Workspace Git save action with an icon and text in %s',
    async (locale) => {
      i18n.global.locale.value = locale;
      const app = createSSRApp({
        render: () =>
          h(WorkspaceGitSettings, {
            request: async <T>() =>
              ({ preserveGitConfig: false, includeParentRepository: true }) as T,
            nodeId: 'node-1',
            workspaceId: 'workspace-1',
            connected: true,
            writable: true
          })
      });
      app.use(ElementPlus).use(i18n);
      app.provide(ID_INJECTION_KEY, { prefix: 1, current: 0 });
      app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
      const html = await renderToString(app);
      const save = html
        .match(/<button\b[^>]*>[\s\S]*?<\/button>/gu)
        ?.find((button) => button.includes(commonMessages[locale].personalGit.save));
      expect(save).toContain('<svg');
      expect(html).toContain(commonMessages[locale].personalGit.preserveHint);
    }
  );
  it.each(['en-US', 'zh-CN'] as const)(
    'renders node, workspace and usage dialogs independently in %s',
    async (locale) => {
      vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
      i18n.global.locale.value = locale;
      for (const name of ['NodeDetailsDialogs', 'NodeRuntimeEnvironment']) {
        const source = readFileSync(
          new URL(`../../src/view/settings/${name}.vue`, import.meta.url),
          'utf8'
        );
        for (const match of source.matchAll(/translate\(\s*['"]([^'"]+)['"]/gu)) {
          let value: unknown = commonMessages[locale];
          for (const part of match[1]!.split('.'))
            value = (value as Record<string, unknown>)?.[part];
          expect(value, match[1]).toBeTypeOf('string');
        }
      }
      const request = vi.fn(async <T>() => ({}) as T);
      const app = createSSRApp({
        render: () =>
          h(Details, {
            request,
            nodeOpen: true,
            workspaceOpen: true,
            usageOpen: true,
            node: {
              id: 'node-1',
              label: 'Public Node',
              connected: true,
              manageable: false,
              nodeAppVersion: '0.9.63',
              capabilities: { codex: { available: true, version: '1.0' } }
            },
            workspace: {
              id: 'workspace-1',
              label: 'Public Workspace',
              path: '/workspace',
              kind: 'DIRECTORY'
            },
            usage: {
              runner: 'codex',
              windows: [{ id: 'five_hour', label: '5 hours', usedPercentage: 25, resetsAt: null }],
              fetchedAt: 1,
              cached: false
            },
            usageDisabledReason: () => ''
          })
      });
      app.use(i18n).use(ElementPlus);
      app.component(
        'ElDialog',
        defineComponent({
          setup(_props, { slots }) {
            return () => h('section', [slots.default?.(), slots.footer?.()]);
          }
        })
      );
      app.provide(ID_INJECTION_KEY, { prefix: 942, current: 0 });
      app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
      const context: { teleports?: Record<string, string> } = {};
      const html =
        (await renderToString(app, context)) + Object.values(context.teleports ?? {}).join('');
      expect(html).toContain('Public Node');
      expect(html).toContain('Public Workspace');
      expect(html).toContain('25%');
      expect(html).not.toMatch(/组织|企业|托管/iu);
      expect(request).not.toHaveBeenCalled();
    }
  );
  it('shows only structurally valid runtime command rows', async () => {
    const app = createSSRApp({
      render: () =>
        h(RuntimeEnvironment, {
          metadata: {
            runtimeCommands: [
              { id: 'git', command: 'git', available: true, version: '2.45', path: '/usr/bin/git' },
              { id: 'unknown', command: 'invalid-entry', available: true },
              { id: 'pip', command: 'bad-version', available: true, version: 42 }
            ]
          }
        })
    });
    app.use(i18n).use(ElementPlus);
    const html = await renderToString(app);
    expect(html).toContain('/usr/bin/git');
    expect(html).not.toContain('invalid-entry');
    expect(html).not.toContain('bad-version');
  });
});
