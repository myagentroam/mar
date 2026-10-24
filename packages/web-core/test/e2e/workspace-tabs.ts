import { createTooltipApp as createApp } from './tooltip-app.js';
import { h, ref } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import '../../src/styles.css';
import WorkspaceTabs from '../../src/view/workspace/WorkspaceTabs.vue';
import type { WorkspaceTab } from '../../src/model/workbench.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';

const activeTabId = ref('node-1:workspace-1');
const connected = ref(true);
const parameters = new URLSearchParams(location.search);
const locale = parameters.get('locale');
const dynamicLayout = parameters.get('layout') === 'dynamic';
const hasStatus = ref(!dynamicLayout);
localePreferenceService().setLocale(locale === 'en-US' ? 'en-US' : 'zh-CN');
const tabs = [
  {
    id: 'node-1:workspace-1',
    nodeId: 'node-1',
    workspaceId: 'workspace-1',
    label: 'Workspace one',
    lastActiveAt: 1,
    pinned: dynamicLayout
  },
  {
    id: 'node-1:workspace-2',
    nodeId: 'node-1',
    workspaceId: 'workspace-2',
    label: 'Workspace two',
    lastActiveAt: 2,
    pinned: dynamicLayout
  }
];
if (dynamicLayout) {
  tabs.push({
    id: 'node-1:workspace-3',
    nodeId: 'node-1',
    workspaceId: 'workspace-3',
    label: 'Workspace three',
    lastActiveAt: 3,
    pinned: false
  });
}
createApp({
  render: () =>
    h('main', { style: { maxWidth: dynamicLayout ? '640px' : '350px' } }, [
      h(
        'button',
        {
          onClick: () => {
            connected.value = !connected.value;
          }
        },
        'Toggle connection'
      ),
      h('button', { onClick: () => (hasStatus.value = !hasStatus.value) }, 'Toggle status'),
      h(WorkspaceTabs, {
        placement: 'body',
        tabs,
        activeTabId: activeTabId.value,
        nodeLabel: () =>
          dynamicLayout
            ? 'Medium Node display'
            : 'A very long Node name that must truncate before status indicators',
        directAvailable: () => connected.value,
        directDescription: () => 'Peer-to-peer connection available (Private network IPv4 UDP)',
        hasActiveRun: (_nodeId: string, workspaceId: string) =>
          hasStatus.value && workspaceId === 'workspace-1',
        hasUnread: (_nodeId: string, workspaceId: string) =>
          !dynamicLayout && hasStatus.value && workspaceId === 'workspace-1',
        onActivate: (tab: WorkspaceTab) => {
          activeTabId.value = tab.id;
        }
      })
    ])
})
  .use(i18n)
  .use(ElementPlus)
  .mount('#app');
