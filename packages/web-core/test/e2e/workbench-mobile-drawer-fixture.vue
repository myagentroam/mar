<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../src/service/mobile-dialog-return-service.js';
import { ElMessageBox } from '../../src/service/message-box-service.js';
import ImagePreviewDialogs from '../../src/view/conversation/ImagePreviewDialogs.vue';
import WorkbenchNavigation from '../../src/view/workbench/WorkbenchNavigation.vue';
import QuickOpenDialog from '../../src/view/workspace/QuickOpenDialog.vue';
import WorkspaceTabs from '../../src/view/workspace/WorkspaceTabs.vue';
import { createWorkspaceTreeService } from '../../src/service/workspace-tree-service.js';
import { createWorkbenchNavigationService } from '../../src/service/workbench-navigation-service.js';
import { captureMobileLayerRoute } from '../../src/service/mobile-layer-history-service.js';
import { createMobileMenuHistoryService } from '../../src/service/mobile-menu-history-service.js';
import { createWorkbenchNotificationService } from '../../src/service/workbench-notification-service.js';
import type { WorkspaceUploadTask } from '../../src/service/workspace-upload-service.js';
import { createWebPerformanceDiagnostics } from '../../src/service/web-performance-diagnostic-service.js';
import type { WorkbenchView } from '../../src/util/workbench-route.js';
import type {
  ComposerAttachment,
  NodeSummary,
  WorkspaceTarget
} from '../../src/model/workbench.js';
import { translate } from '../../src/service/locale-preference-service.js';

const navigation = createWorkbenchNavigationService({
  initialView: 'nodes' as WorkbenchView,
  initialSettingsSection: 'account' as const,
  initialManagementSection: 'system',
  opensMobileSidebar: (view) => view !== 'conversations'
});
navigation.start();
function syncRoute(): void {
  const url = new URL(location.href);
  url.searchParams.set('view', navigation.view.value);
  history.replaceState(history.state, '', url);
  captureMobileLayerRoute();
}
const menuHistory = createMobileMenuHistoryService({
  isOpen: () => navigation.mobileViewport.value && navigation.mobileSidebarOpen.value,
  close: navigation.closeMobileSidebar,
  syncRoute
});
syncRoute();
menuHistory.start();
const notification = {
  id: 'notification-1',
  kind: 'run',
  title: 'Workspace: Session',
  message: 'Task completed',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  expiresAt: Date.now() + 600_000,
  read: false,
  target: {
    targetType: 'WORKSPACE_SESSION',
    nodeId: 'node',
    workspaceId: 'workspace',
    sessionId: 'session'
  }
};
const params = new URL(location.href).searchParams;
const startedAt = Date.now() - 138_000;
let notificationsRead = params.has('read');
const service = createWorkbenchNotificationService(ref('fixture-user'), {
  request: async <T,>(path: string, init?: RequestInit) => {
    if (path === '/api/notifications/read-all' && init?.method === 'POST') notificationsRead = true;
    return {
      notifications: Array.from(
        { length: params.has('many-notifications') ? 120 : 30 },
        (_, index) => ({
          ...notification,
          id: `notification-${index}`,
          read: notificationsRead
        })
      ),
      recentRuns: Array.from({ length: 30 }, (_, index) => ({
        nodeId: 'node',
        runId: `run-${index}`,
        workspaceId: 'workspace',
        workspaceName: 'Project',
        sessionId: `session-${index}`,
        sessionTitle: `Session ${index}`,
        userMessage: `Review task ${index}`,
        runner: 'mar',
        status: index === 0 && !params.has('stopped') ? 'RUNNING' : 'SUCCEEDED',
        createdAt: startedAt,
        startedAt,
        updatedAt: startedAt,
        completedAt: index === 0 && !params.has('stopped') ? null : startedAt + 40_000,
        sortAt: startedAt,
        version: 1
      }))
    } as T;
  }
});
void service.load();
const diagnostics = createWebPerformanceDiagnostics();
const opened = ref('');
const uploads: WorkspaceUploadTask[] = params.has('uploads')
  ? (['FAILED', 'UPLOADING'] as const).map((status) => ({
      id: status,
      nodeId: 'node',
      workspaceId: 'workspace',
      directory: '.',
      overwrite: false,
      file: new File(['fixture'], 'report.txt'),
      name: 'report.txt',
      size: 7,
      receivedBytes: 0,
      status,
      cancelled: false
    }))
  : [];
const quickOpen = ref(false);
const detailsOpen = ref(false);
const imageOpen = ref(false);
const draft = ref('Keep this draft');
const previewQuery = new URLSearchParams(location.search);
const treeRevealFixture = previewQuery.has('tree-reveal');
const tree = createWorkspaceTreeService({ persist: () => undefined });
const treeTarget = ref<WorkspaceTarget>({ nodeId: 'node', workspaceId: 'plain' });
const treeNodes = ['node', 'other'].map(
  (id) => ({ id, connected: true, disabled: false }) as NodeSummary
);
tree.cacheWorkspaces('node', [
  { id: 'plain', path: '/plain', kind: 'DIRECTORY' },
  ...Array.from({ length: 35 }, (_, index) => ({
    id: `folder-${index}`,
    path: `/folder-${index}`,
    kind: 'DIRECTORY' as const
  })),
  { id: 'shared', path: '/target', kind: 'DIRECTORY', groupName: 'Team' },
  { id: 'second', path: '/second-target', kind: 'DIRECTORY', groupName: 'Second team' }
]);
tree.cacheWorkspaces('other', [
  { id: 'shared', path: '/remote', kind: 'DIRECTORY', groupName: 'Other team' }
]);
const treeTabs = [
  { id: 'plain', nodeId: 'node', workspaceId: 'plain', label: 'Plain', lastActiveAt: 0 },
  { id: 'target', nodeId: 'node', workspaceId: 'shared', label: 'Target', lastActiveAt: 0 },
  { id: 'remote', nodeId: 'other', workspaceId: 'shared', label: 'Remote', lastActiveAt: 0 },
  { id: 'second', nodeId: 'node', workspaceId: 'second', label: 'Second', lastActiveAt: 0 }
];
function activateTreeTarget(target: WorkspaceTarget): void {
  treeTarget.value = { nodeId: target.nodeId, workspaceId: target.workspaceId };
  tree.revealWorkspace(target);
}
const attachmentPreview = previewQuery.has('attachment');
const imageSize = previewQuery.get('image');
const [imageWidth, imageHeight] =
  imageSize === 'landscape' ? [1600, 900] : imageSize === 'portrait' ? [200, 2000] : [40, 40];
const image = {
  name: 'Sample image',
  url: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidth}" height="${imageHeight}"><rect width="100%" height="100%" fill="blue"/></svg>`)}`
};
const imageAttachment: ComposerAttachment = {
  id: 'preview-image',
  file: new File([], image.name, { type: 'image/svg+xml' }),
  previewUrl: image.url,
  nodeId: 'node',
  workspaceId: 'workspace',
  receivedBytes: 0,
  status: 'COMPLETED'
};
async function closeDetails(done: () => void): Promise<void> {
  try {
    await ElMessageBox.confirm('Discard draft?', 'Confirm discard');
    done();
  } catch {
    /* Cancellation retains the draft. */
  }
}
async function messageBox(variant: 'alert' | 'prompt'): Promise<void> {
  try {
    await ElMessageBox[variant]('Message', 'Notice');
    opened.value = 'confirmed';
  } catch {
    opened.value = 'cancelled';
  }
}
function selectView(view: WorkbenchView): void {
  const collapse =
    navigation.view.value === view &&
    navigation.mobileSidebarOpen.value &&
    navigation.mobileUtilityPanel.value === undefined;
  navigation.selectView(view);
  if (collapse) navigation.closeMobileSidebar();
  syncRoute();
}
function preview(): void {
  service.notify({
    id: 'preview',
    kind: 'web-update',
    title: 'New version',
    message: 'Reload to update',
    action: 'RELOAD_PAGE'
  });
}
onBeforeUnmount(() => {
  menuHistory.dispose();
  navigation.dispose();
  service.dispose();
});
</script>

<template>
  <main class="console-shell">
    <WorkbenchNavigation
      web-version="fixture"
      :view="navigation.view.value"
      :navigation-items="[
        { id: 'nodes', label: translate('navigation.nodes') },
        { id: 'conversations', label: translate('navigation.conversations') },
        { id: 'management', label: translate('navigation.management') },
        { id: 'settings', label: translate('navigation.settings') }
      ]"
      settings-section="account"
      :settings-items="[{ id: 'account', label: 'Account' }]"
      management-section="system"
      :management-items="[{ id: 'system', label: 'System' }]"
      :sidebar-collapsed="navigation.sidebarCollapsed.value"
      :mobile-sidebar-open="navigation.mobileSidebarOpen.value"
      :mobile-utility-panel="navigation.mobileUtilityPanel.value"
      :sidebar-content-visible="
        !navigation.sidebarCollapsed.value || navigation.mobileSidebarOpen.value
      "
      :nodes="treeRevealFixture ? treeNodes : []"
      :expanded-node-ids="tree.expandedNodeIds.value"
      :workspace-target="treeRevealFixture ? treeTarget : undefined"
      :workspace-tree-reveal-target="tree.revealTarget.value"
      :dragging-workspace="undefined"
      :loading="false"
      :node-label="(node) => node.id"
      :workspace-label="(workspace) => workspace.path"
      :workspaces="tree.workspacesForNode"
      :mobile-viewport="navigation.mobileViewport.value"
      :notification-service="service"
      :performance-diagnostics="diagnostics"
      :uploads="uploads"
      :upload-status-label="() => ''"
      @select-navigation="selectView"
      @select-mobile-utility-panel="navigation.selectMobileUtilityPanel"
      @close-mobile-sidebar="navigation.closeMobileSidebar"
      @open-recent-run="opened = $event.sessionId"
      @open-notification="opened = $event.id"
      @retry-upload="opened = `retry:${$event.id}`"
      @remove-upload="opened = `remove:${$event.id}`"
      @cancel-upload="opened = `cancel:${$event.id}`"
      @toggle-node="tree.toggleNode"
    />
    <section class="fixture-workspace" :class="{ 'tree-reveal-fixture': treeRevealFixture }">
      <template v-if="treeRevealFixture">
        <WorkspaceTabs
          placement="body"
          :tabs="treeTabs"
          :active-tab-id="
            treeTabs.find(
              (tab) =>
                tab.nodeId === treeTarget.nodeId && tab.workspaceId === treeTarget.workspaceId
            )?.id
          "
          :node-label="(tab) => tab.nodeId"
          :direct-available="() => false"
          :direct-description="() => undefined"
          :has-active-run="() => false"
          :has-unread="() => false"
          @activate="activateTreeTarget"
        />
        <button
          type="button"
          @click="navigation.sidebarCollapsed.value = !navigation.sidebarCollapsed.value"
        >
          Toggle resource sidebar
        </button>
        <button
          type="button"
          @click="
            activateTreeTarget(treeTabs[1]!);
            activateTreeTarget(treeTabs[2]!);
          "
        >
          Switch targets quickly
        </button>
        <button type="button" @click="tree.cacheWorkspaces('other', [])">
          Unload remote resources
        </button>
        <button
          type="button"
          @click="
            tree.cacheWorkspaces('other', [
              { id: 'shared', path: '/remote', kind: 'DIRECTORY', groupName: 'Other team' }
            ])
          "
        >
          Load remote resources
        </button>
      </template>
      <input aria-label="Background input" />
      <button type="button" @click="preview">Preview notification</button>
      <button type="button" @click="quickOpen = true">Open quick open</button>
      <button type="button" @click="detailsOpen = true">Open guarded details</button>
      <button type="button" @click="imageOpen = true">Open image preview</button>
      <button type="button" @click="messageBox('alert')">Open alert</button>
      <button type="button" @click="messageBox('prompt')">Open prompt</button>
      <output aria-label="Opened target">{{ opened }}</output>
    </section>
    <el-dialog
      v-if="detailsOpen"
      v-model="detailsOpen"
      title="Guarded details"
      :before-close="closeDetails"
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
    >
      <input v-model="draft" aria-label="Draft" />
    </el-dialog>
    <ImagePreviewDialogs
      :attachment-open="attachmentPreview && imageOpen"
      :attachment="attachmentPreview ? imageAttachment : undefined"
      :conversation="image"
      :conversation-open="!attachmentPreview && imageOpen"
      @update:attachment-open="imageOpen = $event"
      @update:conversation-open="imageOpen = $event"
    />
    <QuickOpenDialog
      v-if="quickOpen"
      :open="quickOpen"
      :node-id="undefined"
      :workspace-id="undefined"
      :files-ready="false"
      :symbols-ready="false"
      :nodes="[]"
      :sessions="[]"
      :session-title="(session) => session.id"
      :open-session="async () => undefined"
      :open-workspace="async () => false"
      :workspace-tabs="[]"
      @close="quickOpen = false"
    />
  </main>
</template>

<style scoped>
.fixture-workspace {
  margin: 96px 72px;
}
@media (min-width: 768px) {
  .tree-reveal-fixture {
    margin-left: calc(var(--mar-workbench-sidebar-total-width) + 24px);
  }
}
.sidebar-scrim {
  position: fixed;
  z-index: 7;
  inset: var(--sidebar-header-height) 0 0;
  border: 0;
  background: var(--mar-overlay-backdrop);
}
</style>
