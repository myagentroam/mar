import { createApp, defineComponent, h } from 'vue';
import WorkspaceTree from '../../src/view/workspace/WorkspaceTree.vue';
import type { RemoteDesktopCapability } from '@myagentroam/protocol';
import type { NodeSummary, Workspace } from '../../src/model/workbench.js';
import { i18n } from '../../src/service/locale-preference-service.js';
import '../../src/styles.css';

const capability: RemoteDesktopCapability = {
  apiVersion: 1 as const,
  available: true as const,
  nodeGeneration: 'generation-123',
  backend: 'TIGERVNC_X0' as const,
  supportsView: true as const,
  supportsControl: true,
  supportsMultiDisplay: true,
  supportsUnicodePaste: true,
  transports: ['RELAY']
};
const node = {
  id: 'node/test',
  displayName: 'Available Node',
  registeredAddress: '',
  platform: 'linux',
  architecture: 'x64',
  nodeAppVersion: '1',
  nodeVersion: '1',
  connected: true,
  disabled: false,
  usable: true,
  capabilities: { remoteDesktop: capability }
};
const fixture = defineComponent({
  render: () =>
    h(WorkspaceTree, {
      nodes: [node, { ...node, id: 'unusable', displayName: 'No Node access', usable: false }],
      expandedNodeIds: [],
      workspaceTarget: undefined,
      draggingWorkspace: undefined,
      visible: true,
      mobileViewport: false,
      loading: false,
      nodeLabel: (value: NodeSummary) => value.displayName ?? value.id,
      workspaceLabel: (value: Workspace) => value.id,
      workspaces: () => []
    })
});
createApp(fixture).use(i18n).mount('#app');
