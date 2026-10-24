<script setup lang="ts">
import { ref } from 'vue';
import type { NodeSummary, Session, Workspace } from '../../src/model/workbench.js';
import Surface from '../../src/view/workbench/WorkbenchSurface.vue';
import WorkspaceTree from '../../src/view/workspace/WorkspaceTree.vue';
import WorkspaceTabs from '../../src/view/workspace/WorkspaceTabs.vue';
import WorkspaceSessionList from '../../src/view/workspace/WorkspaceSessionList.vue';
import WorkspaceRegistrationPicker from '../../src/view/workspace/WorkspaceRegistrationPicker.vue';
import WorkspaceInspector from '../../src/view/workspace/WorkspaceInspector.vue';
import TerminalDock from '../../src/view/terminal/TerminalDock.vue';

const mobile = window.matchMedia('(max-width: 680px)').matches;
const node = { id: 'node', name: 'Node', connected: true, disabled: false } as NodeSummary;
const workspaces: Workspace[] = [
  { id: 'plain', path: '/plain', kind: 'DIRECTORY' },
  { id: 'grouped', path: '/grouped', kind: 'DIRECTORY', groupName: 'Team' }
];
const selectedWorkspace = ref('plain');
const tabs = Array.from({ length: 8 }, (_, index) => ({
  id: String(index),
  nodeId: 'node',
  workspaceId: String(index),
  label: `Workspace ${index}`,
  lastActiveAt: index
}));
const activeTab = ref('0');
const search = ref('');
const action = ref('');
// Keep transport pending while the real dock and xterm render their presentation.
const terminalDirect = { attach: () => new Promise<never>(() => undefined) };
const selectedSession = ref('active');
const sessions = ['active', 'idle', 'other'].map(
  (id) => ({ id, runner: 'mar', status: 'READY' }) as Session
);
const sessionProps = {
  sessions,
  mobileViewport: mobile,
  canLoadMore: false,
  loadingMore: false,
  active: false,
  watchStatus: 'ready' as const,
  nodeReady: true,
  loading: false,
  workspaceKind: 'DIRECTORY' as const,
  workspaceKindLabel: 'Directory',
  workspaceBranch: undefined,
  title: (session: Session) => session.id,
  runnerIcon: () => '',
  activity: (session: Session) => (session.id === 'active' ? 'MANAGED_ACTIVE' : 'IDLE'),
  activityLabel: () => 'Working',
  activityDateTime: () => undefined,
  activityTitle: () => undefined,
  relativeActivity: () => '',
  nodeId: 'node',
  workspaceId: 'workspace',
  skillSupported: false,
  mcpSupported: false,
  cleanupSessionsSupported: false,
  searchSupported: true,
  searching: false,
  refreshing: false,
  workspaceManageable: false,
  request: async <T,>() => ({}) as T,
  hasUnread: () => false
};
const surfacePage = {
  view: 'nodes',
  mobileViewport: mobile,
  sidebarCollapsed: false,
  settingsSection: 'account',
  settingsItems: [],
  managementSection: 'overview',
  managementItems: [],
  hostedConversationWorkspace: {
    snapshot: ref(undefined),
    conversations: ref([]),
    selectedNodeId: ref(undefined),
    selectedConversationId: ref(undefined)
  },
  setComposerInputFocus() {},
  workspaceTarget: { nodeId: 'node', workspaceId: 'offline' },
  workspaceHost: { connected: false },
  selectedWorkspace: undefined,
  workspaceTabs: [],
  nodes: [],
  workspaceTabNodeLabel: () => 'Node',
  nodeLabel: () => 'Node',
  workspaceDirectAvailable: () => false,
  workspaceDirectDescription: () => undefined,
  workspaceTabService: { move() {}, setPinned() {} },
  workbenchNotificationService: {
    hasActiveWorkspaceRun: () => false,
    hasUnreadWorkspace: () => false
  },
  mobileWorkspaceSurface: 'conversation'
};
</script>

<template>
  <main>
    <section aria-label="Offline workspace" class="surface-fixture">
      <Surface :page="surfacePage as never" />
    </section>
    <section aria-label="Workspace tab fixture">
      <WorkspaceTabs
        placement="body"
        :tabs="tabs"
        :active-tab-id="activeTab"
        :node-label="() => 'Node'"
        :direct-available="() => false"
        :direct-description="() => undefined"
        :has-active-run="() => false"
        :has-unread="() => false"
        @activate="activeTab = $event.id"
      />
    </section>
    <section aria-label="Workspace tree fixture">
      <WorkspaceTree
        :nodes="[node]"
        :expanded-node-ids="['node']"
        :workspace-target="{ nodeId: 'node', workspaceId: selectedWorkspace }"
        :dragging-workspace="undefined"
        :mobile-viewport="mobile"
        :loading="false"
        :node-label="() => 'Node'"
        :workspace-label="(workspace) => workspace.id"
        :workspaces="() => workspaces"
        @open-workspace="(_node, workspace) => (selectedWorkspace = workspace)"
      />
    </section>
    <section aria-label="Session fixture">
      <WorkspaceSessionList
        v-bind="sessionProps"
        :selected-session-id="selectedSession"
        :search-query="search"
        @open="selectedSession = $event"
        @refresh="action = 'refresh'"
        @search="action = 'search:' + $event"
      />
      <input v-model="search" aria-label="Set fixture search" />
      <output aria-label="Session action">{{ action }}</output>
    </section>
    <section aria-label="Workspace picker fixture">
      <WorkspaceRegistrationPicker
        :model-value="['register']"
        :directory="{
          currentPath: '/home',
          parentPath: '/',
          browseRoots: ['/'],
          selectable: true,
          entries: [],
          truncated: false
        }"
        selected-path="/home"
        pending-directory-name=""
        :loading-directory="false"
        :loading="false"
        :node-ready="true"
        :selected-path-valid="true"
      />
    </section>
    <section aria-label="Inspector fixture">
      <WorkspaceInspector
        :node-id="undefined"
        :workspace-id="undefined"
        workspace-name="Workspace"
        workspace-kind="GIT_WORKSPACE"
        csrf-token="fixture"
        :renew-csrf-token="async () => 'fixture'"
        :enabled="true"
        :mobile-viewport="mobile"
        :content-search-enabled="true"
        :code-navigation-enabled="false"
        :code-navigation-prewarm-enabled="false"
        files-watch-status="idle"
        changes-watch-status="idle"
        :history-capability="true"
        :file-write-enabled="false"
      />
    </section>
    <section aria-label="Terminal fixture">
      <TerminalDock
        node-id="node"
        workspace-id="workspace"
        csrf-token="fixture"
        :renew-csrf-token="async () => 'fixture'"
        :enabled="true"
        :active="true"
        :visible="false"
        :mobile-mode="false"
        :node-os-release="undefined"
        :capability="
          {
            available: true,
            profiles: [{ id: 'bash', label: 'User Shell' }],
            supportsConPty: false
          } as never
        "
        :direct="terminalDirect"
        :error-message="String"
      />
    </section>
  </main>
</template>

<style scoped>
main {
  padding: 12px;
  display: grid;
  gap: 24px;
}
main > section {
  min-width: 0;
}
.surface-fixture {
  height: 260px;
  overflow: hidden;
}
.surface-fixture :deep(.session-layout) {
  height: 260px;
}
</style>
