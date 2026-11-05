import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ElMessage, ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import RuntimeEnvironment from '../../src/view/settings/NodeRuntimeEnvironment.vue';
import WorkspaceGitSettings from '../../src/view/settings/WorkspaceGitSettings.vue';
import UnitDetails from '../../src/view/settings/NodeDetailsDialogs.vue?unit-render';
import UnitRuntimeEnvironment from '../../src/view/settings/NodeRuntimeEnvironment.vue?unit-render';
import UnitWorkspaceGitSettings from '../../src/view/settings/WorkspaceGitSettings.vue?unit-render';
import { i18n } from '../../src/service/locale-preference-service.js';
import { commonMessages } from '../../src/i18n/messages.js';
import {
  flushComponent,
  renderComponent,
  textContent,
  trigger
} from './support/component-renderer.js';

const originalLocale = i18n.global.locale.value;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  i18n.global.locale.value = originalLocale;
});
describe('Public resource details', () => {
  it('keeps ownership policies and hosted management in the enterprise extension', () => {
    const source = readFileSync(
      new URL('../../src/view/settings/NodeDetailsDialogs.vue', import.meta.url),
      'utf8'
    );
    expect(source).not.toMatch(
      /@\/|ORGANIZATION|ENTERPRISE|ownerOrganizationId|ConversationHostingMaintenanceCard|enableHosting|disableHosting/u
    );
  });
  it('renders public detail extension slots and forwards capability refresh', async () => {
    vi.stubGlobal('HTMLElement', class {});
    vi.stubGlobal('window', {
      location: { search: '', href: 'http://fixture/console' },
      history: { replaceState() {} },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      addEventListener() {},
      removeEventListener() {}
    });
    i18n.global.locale.value = 'en-US';
    const request = vi.fn(
      async <T>() => ({ secrets: [], page: 1, pageSize: 20, total: 0, hasMore: false }) as T
    );
    const refreshNode = vi.fn();
    const view = renderComponent(
      UnitDetails,
      {
        request,
        nodeOpen: true,
        workspaceOpen: false,
        usageOpen: false,
        node: {
          id: 'node-1',
          label: 'Fixture Node',
          connected: true,
          manageable: true,
          nodeAppVersion: '0.10.1',
          metadata: {
            runtimeCommands: [
              { id: 'git', command: 'git', available: true, version: '2.45', path: '/usr/bin/git' }
            ]
          }
        },
        nodeRefreshable: true,
        nodeRefreshing: true,
        usageDisabledReason: () => '',
        onRefreshNode: refreshNode
      },
      {
        'node-properties': ({ node }: { node: { id: string } }) =>
          h('p', `Host node property ${node.id}`),
        'node-sections': ({ node }: { node: { id: string } }) =>
          h('p', `Host node section ${node.id}`)
      }
    );
    try {
      await flushComponent();
      expect(textContent(view.root)).toContain('Host node property node-1');
      expect(textContent(view.root)).toContain('Host node section node-1');
      expect(textContent(view.root)).toContain('/usr/bin/git');
      expect(request).toHaveBeenCalledWith('/api/environment-secrets?nodeId=node-1');
      const refresh = view
        .findAll('ElButton')
        .find((button) => textContent(button).trim() === 'Refresh capabilities')!;
      expect(refresh.props['loading']).toBe(true);
      await trigger(refresh, 'onClick');
      expect(refreshNode).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
    }
  });
  it('renders capability refresh independently of reported command rows', async () => {
    i18n.global.locale.value = 'en-US';
    const refresh = vi.fn();
    const view = renderComponent(UnitRuntimeEnvironment, {
      refreshable: true,
      refreshing: true,
      onRefresh: refresh
    });
    try {
      await flushComponent();
      expect(textContent(view.root)).toContain(
        commonMessages['en-US'].generated.nodeRuntimeEnvironment.theNodeHasNotReportedItsEnvironment
      );
      const root = view.findAll('div')[0]!;
      expect(root.props['class']).toContain('runtime-environment--refreshable');
      const action = view
        .findAll('ElButton')
        .find((button) => textContent(button).trim() === 'Refresh capabilities')!;
      expect(action.props['loading']).toBe(true);
      await trigger(action, 'onClick');
      expect(refresh).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
    }
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
  it('keeps Workspace Git settings concise without stale message keys', async () => {
    i18n.global.locale.value = 'en-US';
    vi.spyOn(ElMessage, 'success').mockImplementation(() => ({ close() {} }));
    const request = vi.fn(
      async <T>() => ({ preserveGitConfig: false, includeParentRepository: true }) as T
    );
    const view = renderComponent(UnitWorkspaceGitSettings, {
      request,
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      connected: true,
      writable: true
    });
    try {
      await flushComponent();
      expect(textContent(view.root)).toContain(commonMessages['en-US'].personalGit.workspaceTitle);
      expect(textContent(view.root)).toContain(commonMessages['en-US'].personalGit.preserveHint);
      expect(textContent(view.root)).toContain(
        commonMessages['en-US'].personalGit.includeParentHint
      );
      expect(textContent(view.root)).not.toContain('personalGit.workspaceScope');
      expect(textContent(view.root)).not.toContain('personalGit.appliesLater');
      expect(view.findAll('ElCheckbox')).toHaveLength(2);
      const controls = view
        .findAll('div')
        .find((element) => element.props['class'] === 'workspace-git-controls');
      expect(controls).toBeDefined();
      await trigger(view.findAll('ElCheckbox')[0]!, 'onUpdate:modelValue', true);
      await trigger(view.findAll('ElCheckbox')[1]!, 'onUpdate:modelValue', false);
      const save = view
        .findAll('ElButton')
        .find((button) => textContent(button).trim() === commonMessages['en-US'].personalGit.save)!;
      await trigger(save, 'onClick');
      expect(request).toHaveBeenLastCalledWith(
        '/api/workspaces/workspace-1/git-policy?nodeId=node-1',
        {
          method: 'PUT',
          cache: 'no-store',
          body: JSON.stringify({ preserveGitConfig: true, includeParentRepository: false })
        }
      );
    } finally {
      view.unmount();
    }
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
      // Tooltip layout is browser-only; SSR has no tooltip output.
      app.directive('tooltip', {});
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
      const request = vi.fn(async () => ({}));
      const view = renderComponent(UnitDetails, {
        request: async <T>() => (await request()) as T,
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
      });
      try {
        const text = textContent(view.root);
        expect(view.findAll('ElDialog')).toHaveLength(3);
        expect(text).toContain('Public Node');
        expect(text).toContain('Public Workspace');
        expect(text).toContain('25%');
        expect(text).not.toMatch(/组织|企业|托管/iu);
        expect(request).not.toHaveBeenCalled();
      } finally {
        view.unmount();
      }
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
    app.directive('tooltip', {});
    app.use(i18n).use(ElementPlus);
    const html = await renderToString(app);
    expect(html).toContain('/usr/bin/git');
    expect(html).not.toContain('invalid-entry');
    expect(html).not.toContain('bad-version');
  });
});
