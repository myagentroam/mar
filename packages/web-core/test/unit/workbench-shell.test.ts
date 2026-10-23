import { createSSRApp, h, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { commonMessages } from '../../src/i18n/messages.js';
import type { WorkbenchNotificationService } from '../../src/service/WorkbenchNotificationService.js';
import type { createWebPerformanceDiagnostics } from '../../src/service/WebPerformanceDiagnosticService.js';
import WorkbenchHeader from '../../src/view/workbench/WorkbenchHeader.vue';
import WorkbenchNavigation from '../../src/view/workbench/WorkbenchNavigation.vue';
import WorkspaceTree from '../../src/view/workspace/WorkspaceTree.vue';
import WorkspaceTabs from '../../src/view/workspace/WorkspaceTabs.vue';
import { i18n, localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import type { NodeSummary } from '../../src/model/workbench.js';

vi.mock('../../src/view/workbench/WorkbenchNotificationCenter.vue', () => ({
  default: { setup: () => () => null }
}));

const originalLocale = localePreferenceService().locale.value;
afterEach(() => localePreferenceService().setLocale(originalLocale));

describe('Shared workbench shell', () => {
  it.each([
    ['en-US', 'Node offline. Waiting for reconnection.'],
    ['zh-CN', '节点离线，等待重新连接。']
  ] as const)('owns the offline Workspace placeholder message: %s', (locale, message) => {
    expect(commonMessages[locale].generated.workbenchSurface.offlineWorkspace).toBe(message);
    const surface = readFileSync(
      new URL('../../src/view/workbench/WorkbenchSurface.vue', import.meta.url),
      'utf8'
    );
    expect(surface).toContain(
      'v-if="page.workspaceHost?.connected === false"\n          class="workspace-offline-placeholder"'
    );
    expect(surface).toContain('class="workspace-offline-placeholder"\n          role="status"');
    expect(surface).toContain("translate('generated.workbenchSurface.offlineWorkspace')");
    expect(surface).toContain('aria-hidden="true"><Connection /></el-icon>');
  });

  it('keeps offline placeholders compact across desktop and mobile viewports', () => {
    const surface = readFileSync(
      new URL('../../src/view/workbench/WorkbenchSurface.vue', import.meta.url),
      'utf8'
    );
    const messageStyle = surface.match(/\.workspace-offline-message \{([^}]+)\}/u)?.[1];
    const iconStyle = surface.match(/\.workspace-offline-icon \{([^}]+)\}/u)?.[1];
    const textStyle = surface.match(/\.workspace-offline-message p \{([^}]+)\}/u)?.[1];
    expect(messageStyle).toContain('gap: 0.5rem;');
    expect(iconStyle).toContain('font-size: 1.75rem;');
    expect(textStyle).toContain('font-size: var(--mar-font-size-meta);');
    expect(textStyle).toContain('line-height: 1.5;');
    expect(surface).toContain(
      '@media (max-width: 767px) {\n  .workspace-offline-icon {\n    font-size: 1.5rem;\n  }\n\n  .workspace-offline-message p {\n    font-size: var(--mar-font-size-body);\n  }\n}'
    );
  });

  it('hides unavailable Terminal docks without unmounting cached Workspace terminals', () => {
    const surface = readFileSync(
      new URL('../../src/view/workbench/WorkbenchSurface.vue', import.meta.url),
      'utf8'
    );
    expect(surface).toContain(
      'v-show="tab.id === page.activeWorkspaceTabId && page.terminalReady"'
    );
    expect(surface).toContain(
      ':visible="\n              tab.id === page.activeWorkspaceTabId &&\n              page.terminalReady &&'
    );
    expect(surface).toContain('v-for="tab in page.workspaceTabs"');
  });

  it.each(['en-US', 'zh-CN'] as const)('owns every static shell message: %s', (locale) => {
    expect(commonMessages[locale].navigation.help).toBe(locale === 'en-US' ? 'Help' : '帮助');
    expect(commonMessages[locale].navigation.conversations).toBe(
      locale === 'en-US' ? 'Chat' : '对话'
    );
    expect(commonMessages[locale].navigation.conversationTemplates).toBe(
      locale === 'en-US' ? 'Chat Templates' : '对话模板'
    );
    expect(commonMessages[locale].hostedConversations.historyTitle).toBe(
      locale === 'en-US' ? 'Chat history' : '对话历史'
    );
    expect(commonMessages[locale].hostedConversations.create).toBe(
      locale === 'en-US' ? 'New chat' : '新建对话'
    );
    expect(commonMessages[locale].hostedConversations.start).toBe(
      locale === 'en-US' ? 'Start chat' : '开始对话'
    );
    expect(commonMessages[locale].hostedConversations.temporaryTitle).toBe(
      locale === 'en-US' ? 'New conversation' : '新建对话'
    );
    expect(commonMessages[locale].navigation).not.toHaveProperty('docs');
    expect(commonMessages[locale].navigation).not.toHaveProperty('docsShort');
    for (const name of [
      'workbench/WorkbenchHeader',
      'workbench/WorkbenchNavigation',
      'workbench/WebPerformanceIndicator',
      'workspace/WorkspaceTree',
      'workspace/WorkspaceTabs',
      'workspace/WorkspaceSessionList',
      'workspace/WorkspaceSessionCleanupDialog',
      'workspace/WorkspaceRegistrationPicker'
    ]) {
      const source = readFileSync(new URL(`../../src/view/${name}.vue`, import.meta.url), 'utf8');
      for (const match of source.matchAll(/(?:translate|\$t|\bt)\(\s*['"]([^'"]+)['"]/gu)) {
        const key = match[1]!;
        let value: unknown = commonMessages[locale];
        for (const part of key.split('.')) {
          value =
            typeof value === 'object' && value !== null
              ? (value as Record<string, unknown>)[part]
              : undefined;
        }
        expect(value, `${name}: ${key}`).toBeTypeOf('string');
      }
    }
  });

  it.each([
    ['en-US', 'Help'],
    ['zh-CN', '帮助']
  ] as const)(
    'renders the mobile Help icon with an accessible label: %s',
    async (locale, label) => {
      localePreferenceService().setLocale(locale);
      const app = createSSRApp({
        render: () =>
          h(WorkbenchNavigation, {
            webVersion: 'test',
            view: 'conversations',
            navigationItems: [
              { id: 'nodes', label: 'Work' },
              { id: 'conversations', label },
              { id: 'management', label: 'Management' },
              { id: 'settings', label: 'Settings' }
            ],
            settingsSection: 'account',
            settingsItems: [],
            managementSection: 'overview',
            managementItems: [],
            sidebarCollapsed: true,
            mobileSidebarOpen: true,
            sidebarContentVisible: false,
            nodes: [],
            expandedNodeIds: [],
            workspaceTarget: undefined,
            draggingWorkspace: undefined,
            loading: false,
            nodeLabel: () => '',
            workspaceLabel: () => '',
            workspaces: () => [],
            mobileViewport: true,
            notificationService: {
              recentRuns: ref([]),
              load: async () => undefined
            } as unknown as WorkbenchNotificationService,
            performanceDiagnostics: {} as ReturnType<typeof createWebPerformanceDiagnostics>,
            uploads: [],
            uploadStatusLabel: () => ''
          })
      });
      app.use(i18n).use(ElementPlus);
      app.provide(ID_INJECTION_KEY, { prefix: 80, current: 0 });
      app.provide(ZINDEX_INJECTION_KEY, { current: 0 });

      const html = await renderToString(app);
      const source = readFileSync(
        new URL('../../src/view/workbench/WorkbenchNavigation.vue', import.meta.url),
        'utf8'
      );
      const iconSource = readFileSync(
        new URL('../../src/view/common/MarIcon.vue', import.meta.url),
        'utf8'
      );

      expect(html).toContain(`aria-label="${label}"`);
      expect(html).not.toContain(`title="${label}"`);
      const navigationButtons = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gsu)].filter(
        (match) => match[1]!.includes('nav-menu-button')
      );
      expect(navigationButtons).toHaveLength(4);
      expect(navigationButtons.map((match) => match[1]!.includes('utility'))).toEqual([
        false,
        false,
        true,
        true
      ]);
      expect(navigationButtons[1]![1]).toContain('aria-current="page"');
      for (const button of navigationButtons) {
        expect(button[1]).toMatch(/aria-label="[^"]+"/u);
        expect(button[1]).not.toMatch(/title="[^"]+"/u);
        expect(button[1]).toContain('el-tooltip__trigger');
        expect(button[2]).not.toContain('rail-label');
      }
      expect(html).toContain('documentation-icon');
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain('viewbox="0 0 24 24"');
      expect(html).toContain('fill="currentColor"');
      expect(html).toContain('fill-rule="evenodd"');
      expect(source).toContain('<MarIcon name="help" />');
      expect(iconSource).toContain(`readonly name: 'help' | 'info'`);
      expect(iconSource).toContain('viewBox="0 0 24 24"');
      expect(source).toContain('.documentation-icon {\n    display: inline-flex;');
      expect(source).not.toContain('documentation-mobile-label');
      expect(source).not.toContain('documentation-desktop-label');
      expect(source).not.toContain('import { ChatDotRound, Help, Monitor, SetUp, Setting }');
      expect(source).not.toContain('<Help />');
      expect(source).not.toContain('<circle cx="12" cy="12" r="10" />');
      expect(source).toContain(
        '.activity-rail nav .nav-menu-button .nav-item-content {\n    min-height: 18px;\n    grid-template-rows: 18px;'
      );
      expect(source).toContain('flex: 0 0 auto;\n    min-height: 0;\n    min-width: 0;');
      expect(source).not.toContain('min-height: 44px;');
      expect(source).not.toContain('min-width: 44px;');
      expect(source).toContain('padding: 4px 0 5px;');
      expect(source).toContain('margin: 0 1px;');
      expect(source).not.toContain('margin: 5px 1px;');
      expect(source).toContain(
        '.activity-rail nav .nav-menu-button .el-icon {\n    display: grid;\n    width: 18px;\n    height: 18px;\n    place-items: center;\n    font-size: 1.125rem;\n    line-height: 18px;'
      );
      expect(source).toContain(
        '.activity-rail nav .nav-menu-button .rail-label {\n    display: none;'
      );
      expect(source).toContain('class="nav-menu-button documentation-link"');
      expect(source).not.toContain('class="nav-menu-button documentation-link utility-control"');
      expect(source).toContain('<el-link');
      expect(source).toContain('underline="never"');
      expect(source).toContain('--el-link-text-color: var(--mar-text-secondary);');
      expect(source).toContain('--el-link-hover-text-color: var(--mar-color-brand-text);');
      expect(source).not.toContain('.documentation-link.el-link:hover');
      expect(source).not.toContain('.documentation-link.el-link:focus-visible');
    }
  );

  it('keeps the active Workspace direct-connection explanation on the Node name', () => {
    const source = readFileSync(
      new URL('../../src/view/workspace/WorkspaceTabs.vue', import.meta.url),
      'utf8'
    );
    expect(source).toContain('v-bind="tooltipOptions"');
    expect(source).toContain('activeTabId === tab.id && directAvailable(tab.nodeId)');
    expect(source).toContain(':content="directDescription(tab.nodeId)"');
    expect(source).toContain(':aria-description="directDescription(tab.nodeId)"');
    expect(source).not.toContain('direct-available-dot');
  });

  it.each([
    ['en-US', 'Unread', 'Workspace has an active task'],
    ['zh-CN', '未读', '工作区有正在运行的任务']
  ] as const)(
    'shows independent state on an inactive Workspace tab and direct context only on the selected tab: %s',
    async (locale, unread, running) => {
      localePreferenceService().setLocale(locale);
      const tabs = [
        { id: 'node-1:a', nodeId: 'node-1', workspaceId: 'a', label: 'A', lastActiveAt: 1 },
        { id: 'node-1:b', nodeId: 'node-1', workspaceId: 'b', label: 'B', lastActiveAt: 2 }
      ];
      const app = createSSRApp({
        render: () =>
          h(WorkspaceTabs, {
            placement: 'body',
            tabs,
            activeTabId: 'node-1:b',
            nodeLabel: () => 'Node 1',
            directAvailable: () => true,
            directDescription: () => 'Peer-to-peer connection available (Private network IPv4 UDP)',
            hasActiveRun: (nodeId: string, workspaceId: string) =>
              nodeId === 'node-1' && workspaceId === 'a',
            hasUnread: (nodeId: string, workspaceId: string) =>
              nodeId === 'node-1' && workspaceId === 'a'
          })
      });
      app.use(i18n).use(ElementPlus);

      const html = await renderToString(app);
      expect(html.match(/class="workspace-tab-node direct-available-node[^"\n]*"/gu)).toHaveLength(
        1
      );
      expect(html.match(/\bworkspace-tab-direct-icon\b/gu)).toHaveLength(1);
      expect(
        html.match(/class="workspace-tab-running session-activity managed_active/gu)
      ).toHaveLength(1);
      expect(html.match(/class="workspace-tab-unread\b[^"]*"/gu)).toHaveLength(1);
      expect(html).toContain('aria-label="' + running + '"');
      expect(html).not.toContain(
        'title="' + i18n.global.t('generated.sessionPresentation.managed') + '"'
      );
      expect(html).toContain('>' + unread + '</span>');
      expect(html).toContain(
        'aria-description="Peer-to-peer connection available (Private network IPv4 UDP)"'
      );
    }
  );

  it.each([
    ['New tab', 'Select a workspace to begin'],
    ['Node 1', 'Select a workspace to begin']
  ])('renders a non-closable desktop Workspace placeholder tab: %s', async (label, context) => {
    const app = createSSRApp({
      render: () =>
        h(WorkspaceTabs, {
          placement: 'header',
          tabs: [],
          activeTabId: undefined,
          emptyLabel: label,
          emptyContext: context,
          nodeLabel: () => '',
          directAvailable: () => false,
          directDescription: () => undefined,
          hasActiveRun: () => true,
          hasUnread: () => true
        })
    });
    app.use(i18n).use(ElementPlus);

    const html = await renderToString(app);
    expect(html).toContain('workspace-tab-placeholder active');
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain(label);
    expect(html).toContain(context);
    expect(html).not.toContain('tab-close');
    expect(html).not.toContain('workspace-tab-running');
    expect(html).not.toContain('workspace-tab-unread');
  });

  it('does not render an empty Workspace placeholder in the mobile body strip', async () => {
    const app = createSSRApp({
      render: () =>
        h(WorkspaceTabs, {
          placement: 'body',
          tabs: [],
          activeTabId: undefined,
          emptyLabel: 'New tab',
          emptyContext: 'Select a workspace to begin',
          nodeLabel: () => '',
          directAvailable: () => false,
          directDescription: () => undefined,
          hasActiveRun: () => false,
          hasUnread: () => false
        })
    });
    app.use(i18n).use(ElementPlus);

    expect(await renderToString(app)).toBe('<!---->');
  });

  it('keeps directory actions visible and consistently iconified on narrow Workspace pickers', () => {
    const source = readFileSync(
      new URL('../../src/view/workspace/WorkspaceRegistrationPicker.vue', import.meta.url),
      'utf8'
    );
    expect(source).toContain('class="workspace-picker-toolbar-actions"');
    expect(source).toContain(':icon="Refresh"');
    expect(source).toContain(':icon="FolderAdd"');
    expect(source).toContain(':icon="Check"');
    expect(source).toContain('@media (max-width: 767px)');
    expect(source).toContain('flex-basis: 100%');
    expect(source).not.toContain('min-height: 36px');
  });

  it('uses the Workspace search action to refresh when empty and search when populated', () => {
    const source = readFileSync(
      new URL('../../src/view/workspace/WorkspaceSessionList.vue', import.meta.url),
      'utf8'
    );
    expect(source).toContain(':prefix-icon="Search"');
    expect(source).toContain('@submit.prevent="submitSessionSearch"');
    expect(source).toContain("if (props.searchQuery !== '') emit('search', '');");
    expect(source).toContain("emit('refresh');");
    expect(source).toContain("@clear=\"emit('search', '')\"");
    expect(source).toContain('class="session-search-button utility-control"');
    expect(source).toContain("'workspaceSessions.searchAction'");
    expect(source).toContain("'generated.workspaceSessionList.refreshWorkspaceSessions'");
    expect(source).toContain(':aria-busy="searching || refreshing || undefined"');
    expect(source).toContain(':disabled="!nodeReady || searching || refreshing"');
    expect(source).toContain('type="submit"');
    expect(source).toContain('<el-icon v-else><Refresh /></el-icon>');
    const surface = readFileSync(
      new URL('../../src/view/workbench/WorkbenchSurface.vue', import.meta.url),
      'utf8'
    );
    expect(surface).toContain('@refresh="page.refreshWorkspaceSessions"');
    expect(source).toContain(
      '.session-search .session-search-button,\n.new-session-form .workspace-more-button {\n  display: inline-grid;'
    );
    expect(source).toContain('width: var(--mar-compact-control-size);');
    expect(source).not.toContain('@click="emit(\'refresh\')"');
    expect(source).toContain('v-if="sessionActionsVisible(session.id)"');
    expect(source).toContain('@contextmenu="openSessionActions(session.id, $event)"');
    expect(source).toContain(':draggable="pinnedDragEnabled(session)"');
    expect(source).toContain('return !props.mobileViewport && pinned(session) && !props.loading;');
    expect(source).toContain('-webkit-touch-callout: none;');
  });

  it('shows a session activity dot only for managed active runs', () => {
    const source = readFileSync(
      new URL('../../src/view/workspace/WorkspaceSessionList.vue', import.meta.url),
      'utf8'
    );
    expect(source).toContain('v-if="nodeReady && activity(session) === \'MANAGED_ACTIVE\'"');
    expect(source).toContain(':aria-label="activityLabel(session)"');
    expect(source).not.toContain("'node-offline'");
  });

  it('uses a fixed Workspace tree indent for each nested level', () => {
    const source = readFileSync(
      new URL('../../src/view/workspace/WorkspaceTree.vue', import.meta.url),
      'utf8'
    );
    expect(source).toContain('--workspace-tree-indent: 16px;');
    expect(source).toContain('--workspace-tree-icon: 16px;');
    expect(source).toContain('var(--workspace-tree-leading) + var(--workspace-tree-indent) * 2');
    expect(source).toContain(
      'var(--workspace-tree-control) + var(--workspace-tree-arrow-content-gap)'
    );
    expect(source).toContain('.workspace-group-toggle.expanded .tree-chevron');
    const groupStyle = source.match(/\.workspace-group-toggle \{([^}]+)\}/u)?.[1];
    expect(groupStyle).toContain('width: calc(100% - 12px);');
    expect(groupStyle).toContain('margin: 2px 6px;');
    expect(groupStyle).toContain('border-radius: var(--mar-radius-selection);');
    expect(source).not.toContain('.workspace-group-toggle.expanded :deep(.el-icon)');
    expect(source).toContain('.workspace-branch-button:focus-visible');
    expect(source).not.toContain('min-height: 36px;');
    expect(source).toMatch(/\.tree-node\s*\{[^}]*font-weight:\s*400;/u);
    expect(source).not.toContain('font-weight: 500;');
    expect(source).not.toContain('font-weight: 650;');
    expect(source).toContain('@contextmenu="openNodeActions($event, result.node.id)"');
    expect(source).toContain(
      '@contextmenu="openWorkspaceActions($event, result.node.id, workspace.id)"'
    );
    expect(source).toContain('v-if="nodeActionsVisible(result.node.id)"');
    expect(source).toContain('v-if="workspaceActionsVisible(result.node.id, workspace.id)"');
    expect(source.match(/:draggable="nodeDragEnabled"/gu)).toHaveLength(3);
    expect(source).toContain(
      'const nodeDragEnabled = computed(() => !props.mobileViewport && !filterActive.value);'
    );
    expect(source).toContain('.tree-node-row.actions-visible {');
    expect(source).toContain('-webkit-touch-callout: none;');
  });

  it('keeps a Workspace tab context in the desktop header and mounts real tabs once per breakpoint', () => {
    const surface = readFileSync(
      new URL('../../src/view/workbench/WorkbenchSurface.vue', import.meta.url),
      'utf8'
    );
    const header = readFileSync(
      new URL('../../src/view/workbench/WorkbenchHeader.vue', import.meta.url),
      'utf8'
    );
    const tabs = readFileSync(
      new URL('../../src/view/workspace/WorkspaceTabs.vue', import.meta.url),
      'utf8'
    );

    expect(surface.match(/<WorkspaceTabs/gu)).toHaveLength(2);
    expect(surface).toContain('v-if="page.view === \'nodes\' && !page.mobileViewport"');
    expect(surface).toContain('v-if="page.mobileViewport"\n          placement="body"');
    expect(surface).toContain('placement="header"');
    expect(surface).toContain("translate('workspaceTabs.newTab')");
    expect(surface).toContain(':empty-context="translate(\'navigation.selectWorkspace\')"');
    expect(header).toContain('v-else-if="view === \'nodes\'" class="workspace-tabs-slot"');
    expect(header).toContain('<slot name="workspace-tabs"></slot>');
    expect(header).toContain("'workspace-tabs-active': view === 'nodes'");
    expect(header).not.toContain('hasWorkspaceTabs');
    expect(header).toContain('.workbench-header.workspace-tabs-active {');
    expect(header).toContain('gap: 0;\n  padding-left: 0;');
    expect(header).toContain('overflow: visible;');
    expect(tabs).toContain("readonly placement: 'header' | 'body';");
    expect(tabs).toContain('readonly emptyLabel?: string;');
    expect(tabs).toContain(
      "tabs.length > 0 || (placement === 'header' && emptyLabel !== undefined)"
    );
    expect(tabs).toContain('class="workspace-tab workspace-tab-placeholder active"');
    expect(tabs).toContain('aria-selected="true"');
    expect(tabs).toContain('.workspace-tab-placeholder {');
    expect(tabs).toContain('workspace-tab-strip-${placement}');
    expect(tabs).toContain('.workspace-tab-strip-header {');
    expect(tabs).toContain('v-if="hasOverflow"');
    expect(tabs).toContain(':disabled="!canScrollLeft"');
    expect(tabs).toContain(':disabled="!canScrollRight"');
    expect(tabs).toContain('flex: 0 0 auto;\n  position: relative;\n  z-index: 1;');
  });

  it.each(['en-US', 'zh-CN'] as const)(
    'renders host-provided management labels without private page IDs: %s',
    async (locale) => {
      localePreferenceService().setLocale(locale);
      const app = createSSRApp({
        render: () =>
          h(WorkbenchHeader, {
            mobileViewport: false,
            view: 'management',
            sidebarCollapsed: false,
            hasWorkspaceTabs: false,
            selectedNodeLabel: undefined,
            selectedWorkspaceLabel: undefined,
            settingsSection: 'account',
            managementSection: 'host-extension',
            settingsItems: [],
            managementItems: [{ id: 'host-extension', label: 'Host extension' }],
            conversationTitle: undefined
          })
      });
      app.use(i18n).use(ElementPlus);
      const html = await renderToString(app);
      expect(html).toContain('Host extension');
      expect(html).toContain('aria-expanded="true"');
      expect(html).not.toContain('navigation.management');
    }
  );

  it.each([false, true])(
    'renders supplied resource names and selection without ownership policy: mobile=%s',
    async (mobileViewport) => {
      const node = { id: 'node', connected: true, capabilities: {} } as NodeSummary;
      const app = createSSRApp({
        render: () =>
          h(WorkspaceTree, {
            nodes: [node],
            expandedNodeIds: ['node'],
            workspaceTarget: { nodeId: 'node', workspaceId: 'workspace' },
            draggingWorkspace: undefined,
            mobileViewport,
            loading: false,
            nodeLabel: () => 'Visible node',
            workspaceLabel: () => 'Visible workspace',
            workspaces: () => [
              { id: 'workspace', path: '/workspace', kind: 'DIRECTORY' },
              { id: 'grouped', path: '/grouped', kind: 'DIRECTORY', groupName: 'Product' }
            ]
          })
      });
      app.use(i18n).use(ElementPlus);
      app.provide(ID_INJECTION_KEY, { prefix: 400, current: 0 });
      app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
      const html = await renderToString(app);
      expect(html).toContain('Visible node');
      expect(html).toContain('Visible workspace');
      expect(html).toContain('class="selected"');
      expect(html).toContain('tree-node-icon');
      expect(html).toContain('state-dot ready');
      expect(html.match(/tree-type-icon/g)).toHaveLength(2);
      expect(html).not.toMatch(/workspace-branch-content[^>]*>\s*<i/);
      expect(html).toContain('aria-expanded="false"');
      expect(html).not.toContain('class="tree-foot"');
      expect(html).not.toContain('generated.workspaceTree.');
      const workspaceRows = html.match(/<li\b[^>]*draggable="[^"]+"[^>]*>/gu);
      expect(workspaceRows).toHaveLength(1);
      expect(workspaceRows?.[0]).toContain(`draggable="${!mobileViewport}"`);
    }
  );
});
