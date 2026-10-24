import { describe, expect, it, vi } from 'vitest';
import { shallowReactive, ref } from 'vue';
import Surface from '../../src/view/workbench/WorkbenchSurface.vue?unit-render';
import { flushComponent, renderComponent, trigger } from './support/component-renderer.js';

vi.mock('../../src/service/mobile-surface-focus-service.js', () => ({
  createMobileSurfaceFocusService: () => ({ dispose: vi.fn() })
}));

const lifetime = vi.hoisted(() => ({ mounted: 0, unmounted: 0 }));
vi.mock('../../src/view/settings/SettingsContent.vue?unit-render', async () => {
  const { defineComponent, h } = await import('vue');
  return { __esModule: true, default: defineComponent(() => () => h('settings-fixture')) };
});
vi.mock('../../src/view/conversation/HostedConversationWorkspacePage.vue?unit-render', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent(() => () => h('hosted-fixture')) };
});
vi.mock('../../src/service/management-composition.js', async () => {
  const { defineComponent, h } = await import('vue');
  const component = defineComponent({
    emits: ['extensionChanged'],
    setup:
      (_, { emit }) =>
      () =>
        h(
          'button',
          { 'data-testid': 'extension', onClick: () => emit('extensionChanged') },
          'Change extension'
        )
  });
  return {
    useManagementComposition: () => ({
      resolve: () => ({ id: 'system', component, props: () => ({}) })
    })
  };
});
vi.mock('../../src/view/workbench/WorkbenchHeader.vue?unit-render', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      setup:
        (_, { slots }) =>
        () =>
          h('header', slots['workspace-tabs']?.())
    })
  };
});
vi.mock('../../src/view/workspace/WorkspaceTabs.vue?unit-render', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      setup:
        (_, { attrs }) =>
        () =>
          h('tab-strip', attrs)
    })
  };
});
vi.mock('../../src/view/workspace/WorkspaceRegistrationPicker.vue?unit-render', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      props: ['nodeReady'],
      setup: (props) => () => h('registration-picker', props)
    })
  };
});
vi.mock('../../src/view/terminal/TerminalDock.vue?unit-render', async () => {
  const { defineComponent, h, onMounted, onUnmounted } = await import('vue');
  return {
    default: defineComponent({
      props: ['errorMessage'],
      setup: (props, { attrs }) => {
        onMounted(() => lifetime.mounted++);
        onUnmounted(() => lifetime.unmounted++);
        return () => h('terminal-fixture', { ...attrs, ...props });
      }
    })
  };
});

function pageFixture() {
  const tabs = ['one', 'two'].map((id) => ({
    id,
    nodeId: 'node',
    workspaceId: id,
    label: id,
    lastActiveAt: 1
  }));
  // Preserve nested service refs: the production controller unwraps only its outer state.
  return shallowReactive({
    view: 'nodes',
    mobileViewport: false,
    sidebarCollapsed: false,
    settingsSection: 'account',
    settingsItems: [],
    loading: false,
    managementSection: 'overview',
    managementItems: [],
    hostedConversationWorkspace: {
      snapshot: ref(undefined),
      conversations: ref([]),
      selectedNodeId: ref(undefined),
      selectedConversationId: ref(undefined)
    },
    setComposerInputFocus: vi.fn(),
    refreshAdmin: vi.fn(),
    workspaceHost: { connected: false },
    workspaceTarget: { nodeId: 'node', workspaceId: 'one' },
    selectedWorkspace: undefined,
    workspaceTabs: tabs,
    activeWorkspaceTabId: 'one',
    nodeLabel: () => 'Node',
    workspaceTabNodeLabel: () => 'Node',
    workspaceDirectAvailable: () => false,
    workspaceDirectDescription: () => undefined,
    workspaceTabService: { move: vi.fn(), setPinned: vi.fn() },
    workbenchNotificationService: {
      hasActiveWorkspaceRun: () => false,
      hasUnreadWorkspace: () => false
    },
    terminalReady: true,
    terminalDocks: new Map(),
    nodes: [],
    workspaceRegistrationNodeId: undefined as string | undefined,
    workspaceRegistrationReady: false,
    mobileWorkspaceSurface: 'conversation',
    notice: vi.fn()
  });
}

describe('Workbench surface composition behavior', () => {
  it('refreshes the host after the active management extension changes', async () => {
    const page = pageFixture();
    page.view = 'management';
    const view = renderComponent(Surface, { page });
    try {
      await trigger(
        view.findAll('button').find((node) => node.props['data-testid'] === 'extension')!,
        'onClick'
      );
      expect(page.refreshAdmin).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
    }
  });
  it('passes live registration readiness to the picker', async () => {
    const page = pageFixture();
    page.workspaceRegistrationNodeId = 'node';
    const view = renderComponent(Surface, { page });
    try {
      for (const allowed of [false, true]) {
        page.workspaceRegistrationReady = allowed;
        await flushComponent();
        expect(view.findAll('registration-picker')[0]?.props).toMatchObject({ nodeReady: allowed });
      }
    } finally {
      view.unmount();
    }
  });
  it('keeps cached terminal instances alive while switching tabs and hiding unavailable terminals', async () => {
    lifetime.mounted = 0;
    lifetime.unmounted = 0;
    const page = pageFixture();
    const view = renderComponent(Surface, { page });
    try {
      expect(lifetime.mounted).toBe(2);
      const docks = () => view.findAll('terminal-fixture');
      const formatError = docks()[0]!.props.errorMessage as (error: unknown) => string;
      expect(formatError(new Error('Fixture diagnostic'))).toContain('Fixture diagnostic');
      expect(docks().map((node) => node.props.enabled)).toEqual([true, false]);
      page.activeWorkspaceTabId = 'two';
      await flushComponent();
      expect(docks().map((node) => node.props.visible)).toEqual([false, true]);
      page.terminalReady = false;
      await flushComponent();
      expect(
        docks().every((node) => node.props.enabled === false && node.props.visible === false)
      ).toBe(true);
      expect(docks().every((node) => node.parent?.style.display === 'none')).toBe(true);
      expect(lifetime).toEqual({ mounted: 2, unmounted: 0 });
      page.workspaceTabs = page.workspaceTabs.slice(1);
      await flushComponent();
      expect(lifetime.unmounted).toBe(1);
    } finally {
      view.unmount();
    }
    expect(lifetime.unmounted).toBe(2);
  });

  it('keeps Dock ownership across temporary top-level views and destroys only removed tabs', async () => {
    lifetime.mounted = 0;
    lifetime.unmounted = 0;
    const page = pageFixture();
    const view = renderComponent(Surface, { page });
    try {
      const instances = [...page.terminalDocks.values()];
      expect(instances).toHaveLength(2);
      for (const target of ['settings', 'conversations', 'management']) {
        page.view = target;
        await flushComponent();
        expect(lifetime).toEqual({ mounted: 2, unmounted: 0 });
        expect([...page.terminalDocks.values()][0]).toBe(instances[0]);
        expect(view.findAll('terminal-fixture')).toHaveLength(2);
        expect(
          view
            .findAll('terminal-fixture')
            .every(
              (node) =>
                node.props.active === false &&
                node.props.enabled === false &&
                node.props.visible === false
            )
        ).toBe(true);
        page.view = 'nodes';
        await flushComponent();
        expect(lifetime).toEqual({ mounted: 2, unmounted: 0 });
        expect(view.findAll('terminal-fixture')[0]?.props.visible).toBe(true);
      }
      page.view = 'settings';
      page.workspaceTabs = page.workspaceTabs.slice(1);
      await flushComponent();
      expect(lifetime).toEqual({ mounted: 2, unmounted: 1 });
    } finally {
      view.unmount();
    }
    expect(lifetime).toEqual({ mounted: 2, unmounted: 2 });
  });

  it('mounts exactly one workspace tab strip at the placement selected by the viewport', async () => {
    const page = pageFixture();
    const view = renderComponent(Surface, { page });
    try {
      expect(view.findAll('tab-strip').map((node) => node.props.placement)).toEqual(['header']);
      page.mobileViewport = true;
      await flushComponent();
      expect(view.findAll('tab-strip').map((node) => node.props.placement)).toEqual(['body']);
      page.mobileViewport = false;
      await flushComponent();
      expect(view.findAll('tab-strip').map((node) => node.props.placement)).toEqual(['header']);
    } finally {
      view.unmount();
    }
  });
});
