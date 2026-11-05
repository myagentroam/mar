import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, reactive } from 'vue';
import Page from '../../src/view/workbench/WorkbenchPage.vue?unit-render';
import { renderComponent, flushComponent, trigger } from './support/component-renderer.js';

vi.mock('../../src/view/workbench/WorkbenchNavigation.vue?unit-render', () => ({
  default: defineComponent({
    emits: ['open-workspace-details'],
    setup(_, { emit }) {
      return () =>
        h(
          'button',
          {
            onClick: () =>
              emit('open-workspace-details', 'node', {
                id: 'workspace',
                path: '/workspace',
                displayName: 'Project',
                manageable: true
              })
          },
          'Open workspace'
        );
    }
  })
}));
vi.mock('../../src/view/workbench/WorkbenchSurface.vue?unit-render', () => ({
  default: { render: () => null }
}));
vi.mock('../../src/view/workspace/QuickOpenDialog.vue?unit-render', () => ({
  default: { render: () => null }
}));
vi.mock('../../src/view/conversation/ImagePreviewDialogs.vue?unit-render', () => ({
  default: { render: () => null }
}));
vi.mock('../../src/view/settings/NodeDetailsDialogs.vue?unit-render', () => ({
  default: defineComponent({
    props: [
      'node',
      'nodeRefreshable',
      'nodeRefreshing',
      'workspace',
      'workspaceOpen',
      'workspaceSecretManageable'
    ],
    emits: ['refresh-node'],
    setup(props, { emit }) {
      return () =>
        h('resource-details', { ...props }, [
          h('button', { onClick: () => emit('refresh-node') }, 'Refresh node')
        ]);
    }
  })
}));

describe('Workbench default resource details wiring', () => {
  it('projects workspace permissions and refreshes live Node details without duplicate requests', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshNodes = vi.fn(async () => {
      await pending;
      page.resources.nodes = [{ id: 'node', label: 'New capability snapshot', connected: true }];
    });
    const page = reactive({
      identity: {
        adminLoaded: true,
        admin: { authenticated: true },
        locked: false,
        loading: false
      },
      application: { view: 'nodes' },
      layout: { panelWidths: {} },
      tree: { orderedNodes: [], expandedNodeIds: [] },
      selection: { workspaceTabs: [] },
      sessionList: { sessions: [] },
      files: {},
      hosted: {},
      uploads: {},
      interactions: {},
      resources: {
        workspaceTreeService: {},
        nodes: [{ id: 'node', label: 'Initial snapshot', connected: true }],
        nodeDetails: { id: 'node', label: 'Cached details' },
        nodeDetailsDialogOpen: true,
        nodeLabel: (node: { label: string }) => node.label,
        refreshNodes
      }
    });
    const opened = vi.fn();
    const view = renderComponent(Page, { page, onOpenWorkspaceDetails: opened });
    try {
      await flushComponent();
      const details = () => view.findAll('resource-details')[0]!;
      expect(details().props.node).toMatchObject({ label: 'Initial snapshot' });
      expect(details().props.nodeRefreshable).toBe(true);
      await trigger(view.findAll('button')[0]!, 'onClick');
      expect(opened).toHaveBeenCalledWith('node', expect.objectContaining({ id: 'workspace' }));
      expect(details().props.workspace).toMatchObject({ id: 'workspace', label: 'Project' });
      expect(details().props.workspaceOpen).toBe(true);
      expect(details().props.workspaceSecretManageable).toBe(true);
      const refresh = view.findAll('button').at(-1)!;
      const first = trigger(refresh, 'onClick');
      await flushComponent();
      expect(details().props.nodeRefreshing).toBe(true);
      await trigger(refresh, 'onClick');
      expect(refreshNodes).toHaveBeenCalledOnce();
      release();
      await first;
      await flushComponent();
      expect(details().props.node).toMatchObject({ label: 'New capability snapshot' });
      expect(details().props.nodeRefreshing).toBe(false);
    } finally {
      release();
      view.unmount();
    }
  });
});
