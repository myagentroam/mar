import { createSSRApp, h, ref, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { commonMessages } from '../../src/i18n/messages.js';
import { MANAGEMENT_COMPOSITION_KEY } from '../../src/service/management-composition.js';
import type { WorkbenchNotificationService } from '../../src/service/workbench-notification-service.js';
import { createWebPerformanceDiagnostics } from '../../src/service/web-performance-diagnostic-service.js';
import WorkbenchHeader from '../../src/view/workbench/WorkbenchHeader.vue';
import { MarPanelResizeHandle } from '@myagentroam/mar-ui/panel-resize-handle';
import WorkbenchNavigation from '../../src/view/workbench/WorkbenchNavigation.vue';
import WorkbenchSurface from '../../src/view/workbench/WorkbenchSurface.vue';
import WorkspaceTree from '../../src/view/workspace/WorkspaceTree.vue';
import WorkspaceSessionList from '../../src/view/workspace/WorkspaceSessionList.vue';
import WorkspaceTabs from '../../src/view/workspace/WorkspaceTabs.vue';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import type { NodeSummary } from '../../src/model/workbench.js';

vi.mock('../../src/view/workbench/WorkbenchActivityCenter.vue', () => ({
  default: { setup: () => () => null }
}));

const originalLocale = localePreferenceService().locale.value;
afterEach(() => localePreferenceService().setLocale(originalLocale));

async function renderComponent(component: Component, props: Record<string, unknown>) {
  const app = createSSRApp({ render: () => h(component, props) });
  app.use(i18n);
  app.directive('tooltip', { getSSRProps: () => ({}) });
  return renderToString(app);
}

async function renderOfflineSurface() {
  const page = {
    application: {
      view: 'nodes',
      settingsSection: 'account',
      settingsItems: [],
      managementSection: 'overview',
      managementItems: []
    },
    identity: { admin: {} },
    layout: { mobileViewport: false, sidebarCollapsed: true },
    browser: { destination: undefined },
    registration: { workspaceRegistrationNodeId: undefined },
    hosted: {
      hostedConversationWorkspace: {
        snapshot: ref({ conversation: undefined }),
        conversations: ref([] as { nodeId: string; id: string }[]),
        selectedNodeId: ref(undefined as string | undefined),
        selectedConversationId: ref(undefined as string | undefined)
      }
    },
    aside: {
      asideViewMode: () => 'none',
      asideWidth: () => undefined,
      terminalTabOpen: () => false,
      setAsideSessionFits: vi.fn(),
      setAsideSurfaceVisible: vi.fn()
    },
    files: {},
    selection: {
      workspaceTarget: { nodeId: 'node-1', workspaceId: 'workspace-1' },
      workspaceTabs: [],
      workspaceTabNodeLabel: () => 'Node'
    },
    resources: {
      workspaceHost: { connected: false },
      selectedWorkspace: undefined,
      nodeLabel: () => 'Node',
      workspaceDirectAvailable: () => false,
      workspaceDirectDescription: () => undefined
    },
    notifications: {
      workspaceRunActivity: () => undefined,
      hasUnreadWorkspace: () => false
    }
  };
  const app = createSSRApp({ render: () => h(WorkbenchSurface, { page: page as never }) });
  app.use(i18n);
  app.directive('tooltip', { getSSRProps: () => ({}) });
  app.provide(MANAGEMENT_COMPOSITION_KEY, {} as never);
  return renderToString(app);
}

describe('Shared workbench shell', () => {
  it('keeps resize layout attributes on the interactive separator', async () => {
    const html = await renderComponent(MarPanelResizeHandle, {
      target: undefined,
      label: 'Resize sidebar',
      min: 180,
      max: 420,
      width: 280,
      direction: 1,
      class: 'workbench-sidebar-resize',
      'aria-controls': 'workbench-secondary-sidebar',
      style: { left: '280px' }
    });
    const separator = html.match(/<div\b[^>]*role="separator"[^>]*>/u)?.[0];
    expect(separator).toContain('workbench-sidebar-resize');
    expect(separator).toContain('left:280px');
    expect(separator).toContain('aria-label="Resize sidebar"');
    expect(separator).toContain('aria-controls="workbench-secondary-sidebar"');
    expect(separator).toContain('aria-valuenow="280"');
  });

  it.each([
    ['en-US', 'Node offline. Waiting for reconnection.'],
    ['zh-CN', '节点离线，等待重新连接。']
  ] as const)('owns the offline Workspace placeholder message: %s', async (locale, message) => {
    expect(commonMessages[locale].generated.workbenchSurface.offlineWorkspace).toBe(message);
    localePreferenceService().setLocale(locale);
    const html = await renderOfflineSurface();
    const placeholder =
      /<section\b(?=[^>]*class="[^"]*\bworkspace-offline-placeholder\b)(?=[^>]*role="status")[^>]*>([\s\S]*?)<\/section>/u.exec(
        html
      );
    expect(placeholder).toBeDefined();
    expect(placeholder?.[1]).toContain(message);
    expect(placeholder?.[1]).toMatch(/<svg\b(?=[^>]*aria-hidden="true")/u);
    expect(placeholder?.[1]).toContain('data-mar-icon="connection-off"');
    expect(placeholder?.[1]).not.toContain('data-mar-icon="connection"');
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
    ['en-US', 'Chat', 'MyAgentRoam menu'],
    ['zh-CN', '对话', 'MyAgentRoam 菜单']
  ] as const)(
    'renders the mobile brand menu trigger with an accessible label: %s',
    async (locale, label, brandLabel) => {
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
              load: async () => undefined,
              unreadCount: ref(0),
              notificationRevision: ref(0),
              previewNotificationId: ref(undefined),
              webUpdatePreviewId: ref(undefined),
              takeWebUpdatePreview: () => false,
              notifications: ref([]),
              hasUnreadSession: () => false
            } as unknown as WorkbenchNotificationService,
            performanceDiagnostics: createWebPerformanceDiagnostics(),
            uploads: [],
            uploadStatusLabel: () => ''
          })
      });
      app.use(i18n);
      app.directive('tooltip', { getSSRProps: () => ({}) });

      const html = await renderToString(app);
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).not.toContain(`title="${label}"`);
      const navigationButtons = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gsu)].filter(
        (match) => match[1]!.includes('nav-menu-button')
      );
      expect(navigationButtons).toHaveLength(5);
      expect(navigationButtons.map((match) => match[1]!.includes('utility'))).toEqual([
        false,
        false,
        false,
        true,
        true
      ]);
      expect(navigationButtons[2]![1]).toContain('aria-current="page"');
      for (const button of navigationButtons) {
        expect(button[1]).toMatch(/aria-label="[^"]+"/u);
        expect(button[1]).not.toMatch(/title="[^"]+"/u);
        expect(button[2]).not.toContain('rail-label');
      }
      const brandButton = /<button\b(?=[^>]*\bbrand-menu-trigger\b)([^>]*)>(.*?)<\/button>/su.exec(
        html
      );
      expect(brandButton?.[1]).toContain(`aria-label="${brandLabel}"`);
      expect(brandButton?.[1]).toContain('aria-haspopup="menu"');
      expect(brandButton?.[2]).toMatch(/^<img\b/u);
      expect(brandButton?.[2]).not.toContain('<svg');
      expect(html).not.toContain('documentation-link');
    }
  );

  it.each([
    ['en-US', 'Unread', 'Workspace has an active task'],
    ['zh-CN', '未读', '工作区有活动任务']
  ] as const)(
    'shows independent state on an inactive Workspace tab and direct context only on the selected tab: %s',
    async (locale, unread, running) => {
      localePreferenceService().setLocale(locale);
      const directDescription = 'Peer-to-peer connection available (Private network IPv4 UDP)';
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
            directDescription: () => directDescription,
            runActivity: (nodeId: string, workspaceId: string) =>
              nodeId === 'node-1' && workspaceId === 'a' ? 'running' : undefined,
            hasUnread: (nodeId: string, workspaceId: string) =>
              nodeId === 'node-1' && workspaceId === 'a'
          })
      });
      app.use(i18n);
      app.directive('tooltip', {
        getSSRProps: (binding) => {
          const value = binding.value as string | { readonly content?: string } | null | undefined;
          const content = typeof value === 'string' ? value : value?.content;
          return content === undefined ? {} : { 'data-tooltip-content': content };
        }
      });

      const html = await renderToString(app);
      expect(html.match(/class="workspace-tab-node direct-available-node[^"\n]*"/gu)).toHaveLength(
        1
      );
      expect(html.match(/\bworkspace-tab-direct-icon\b/gu)).toHaveLength(1);
      expect(
        html.match(/class="workspace-tab-running mar-session-activity running/gu)
      ).toHaveLength(1);
      expect(html.match(/class="workspace-tab-unread\b[^"]*"/gu)).toHaveLength(1);
      expect(html).toContain(`aria-description="${running}"`);
      expect(html).toContain(`data-tooltip-content="${running}"`);
      expect(html).not.toContain(`title="${running}"`);
      expect(html).toContain('>' + unread + '</span>');
      const directNode = html.match(
        /<[a-z][a-z\d-]*\b(?=[^>]*class="[^"]*\bworkspace-tab-node direct-available-node\b[^"]*")[^>]*>/u
      )?.[0];
      expect(directNode).toContain(`aria-description="${directDescription}"`);
      expect(directNode).toContain(`data-tooltip-content="${directDescription}"`);
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
          runActivity: () => 'running',
          hasUnread: () => true
        })
    });
    app.use(i18n);
    app.directive('tooltip', { getSSRProps: () => ({}) });

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
          runActivity: () => undefined,
          hasUnread: () => false
        })
    });
    app.use(i18n);
    app.directive('tooltip', { getSSRProps: () => ({}) });

    expect(await renderToString(app)).toBe('<!---->');
  });

  it('keeps directory actions visible and consistently iconified on narrow Workspace pickers', async () => {
    localePreferenceService().setLocale('en-US');
  });

  it('uses the Workspace search action to refresh when empty and search when populated', async () => {
    localePreferenceService().setLocale('en-US');
    const props: Record<string, unknown> = {
      sessions: [],
      selectedSessionId: undefined,
      mobileViewport: false,
      canLoadMore: false,
      loadingMore: false,
      active: true,
      watchStatus: 'ready',
      nodeReady: true,
      loading: false,
      workspaceKind: undefined,
      workspaceKindLabel: '',
      workspaceBranch: undefined,
      title: () => '',
      runnerIcon: () => '',
      activity: () => '',
      activityLabel: () => '',
      activityDateTime: () => undefined,
      activityTitle: () => undefined,
      relativeActivity: () => '',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      skillSupported: false,
      mcpSupported: false,
      cleanupSessionsSupported: false,
      searchSupported: true,
      searchQuery: '',
      searching: false,
      refreshing: false,
      workspaceManageable: true,
      request: async () => undefined,
      hasUnread: () => false
    };
    const findSearchButton = (html: string) => {
      const button = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gu)].find((match) =>
        match[1]!.includes('session-search-button')
      );
      expect(button).toBeDefined();
      return button!;
    };
    const searchLabel = i18n.global.t('workspaceSessions.searchLabel');
    const searchActionLabel = i18n.global.t('workspaceSessions.searchAction');
    const refreshActionLabel = i18n.global.t(
      'generated.workspaceSessionList.refreshWorkspaceSessions'
    );
    const emptyHtml = await renderComponent(WorkspaceSessionList, props);
    expect(emptyHtml).toMatch(/<form\b(?=[^>]*role="search")[^>]*>/u);
    expect(emptyHtml).toContain('<input');
    expect(emptyHtml).toContain(`aria-label="${searchLabel}"`);
    expect(emptyHtml).toContain('data-mar-icon="search"');
    const emptyButton = findSearchButton(emptyHtml);
    expect(emptyButton[1]).toContain(`aria-label="${refreshActionLabel}"`);
    expect(emptyButton[1]).toContain('type="submit"');
    expect(emptyButton[1]).not.toMatch(/\sdisabled(?:[\s=>])/u);
    expect(emptyButton[1]).not.toContain('aria-busy');
    expect(emptyButton[2]).toMatch(/<svg\b(?=[^>]*data-mar-icon="refresh")/u);

    const query = 'Existing session';
    const populatedHtml = await renderComponent(WorkspaceSessionList, {
      ...props,
      searchQuery: query
    });
    expect(findSearchButton(populatedHtml)[1]).toContain(`aria-label="${searchActionLabel}"`);

    const unavailableHtml = await renderComponent(WorkspaceSessionList, {
      ...props,
      nodeReady: false
    });
    const unavailableButton = findSearchButton(unavailableHtml);
    expect(unavailableButton[1]).toMatch(/\sdisabled(?:[\s=>])/u);
    expect(unavailableButton[1]).not.toContain('aria-busy');

    for (const state of ['searching', 'refreshing'] as const) {
      const loadingHtml = await renderComponent(WorkspaceSessionList, {
        ...props,
        searchQuery: query,
        searchReady: true,
        [state]: true
      });
      const loadingButton = findSearchButton(loadingHtml);
      expect(loadingButton[1]).toContain('aria-busy="true"');
      expect(loadingButton[1]).toMatch(/\sdisabled(?:[\s=>])/u);
      expect(loadingButton[2]).toMatch(/<svg\b(?=[^>]*data-mar-icon="loading-action")/u);
    }
    const firstSearch = await renderComponent(WorkspaceSessionList, {
      ...props,
      searchQuery: query,
      searchReady: false,
      searching: true
    });
    expect(findSearchButton(firstSearch)[1]).not.toContain('aria-busy');
    expect(firstSearch).toMatch(
      /<div\b(?=[^>]*watch-status)(?=[^>]*role="status")[^>]*><i\b[^>]*mar-read-loading-indicator/u
    );
  });

  it.each([
    ['en-US', false],
    ['en-US', true],
    ['zh-CN', false],
    ['zh-CN', true]
  ] as const)(
    'renders the sidebar panel toggle in %s with collapsed=%s',
    async (locale, sidebarCollapsed) => {
      localePreferenceService().setLocale(locale);
      const html = await renderComponent(WorkbenchHeader, {
        mobileViewport: false,
        view: 'nodes',
        sidebarCollapsed,
        settingsSection: 'account',
        managementSection: 'overview',
        settingsItems: [],
        managementItems: [],
        conversationTitle: undefined
      });
      const label =
        commonMessages[locale].navigation[sidebarCollapsed ? 'expandSidebar' : 'collapseSidebar'];
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain(`aria-expanded="${!sidebarCollapsed}"`);
      expect(html).toContain(
        `data-mar-icon="${sidebarCollapsed ? 'sidebar' : 'sidebar-expanded'}"`
      );
      expect(html).not.toContain('data-mar-icon="menu"');
    }
  );

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
            managementItems: [{ id: 'host-extension', label: 'Host extension', icon: 'info' }],
            conversationTitle: undefined
          })
      });
      app.use(i18n);
      app.directive('tooltip', { getSSRProps: () => ({}) });
      const html = await renderToString(app);
      expect(html).toContain('Host extension');
      expect(html).toContain('data-mar-icon="chevron-right"');
      expect(html).toContain('aria-expanded="true"');
      expect(html).not.toContain('navigation.management');
    }
  );

  it('leaves the shared header out of the mobile Work surface', async () => {
    const html = await renderComponent(WorkbenchHeader, {
      mobileViewport: true,
      view: 'nodes',
      sidebarCollapsed: false,
      settingsSection: 'account',
      managementSection: 'overview',
      settingsItems: [],
      managementItems: [],
      conversationTitle: undefined
    });
    expect(html).not.toContain('workbench-header');
    expect(html).not.toContain('workspace-tabs-slot');
  });

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
              { id: 'workspace', path: '/workspace', kind: 'DIRECTORY' as const },
              { id: 'grouped', path: '/grouped', kind: 'DIRECTORY' as const, groupName: 'Product' }
            ]
          })
      });
      app.use(i18n);
      app.directive('tooltip', { getSSRProps: () => ({}) });
      const html = await renderToString(app);
      expect(html).toContain('Visible node');
      expect(html).toContain('Visible workspace');
      expect(html).toContain('class="selected"');
      expect(html).toContain('tree-node-icon');
      expect(html).toMatch(/class="state-dot\s+[^"\n]*\bready\b[^"\n]*"/u);
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
