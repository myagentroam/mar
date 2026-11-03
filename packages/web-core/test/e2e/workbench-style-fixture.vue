<script setup lang="ts">
import { ref, shallowReactive } from 'vue';
import HostedComposerGestureFixture from './hosted-composer-gesture-fixture.vue';
import type { NodeSummary, Session, Workspace } from '../../src/model/workbench.js';
import Surface from '../../src/view/workbench/WorkbenchSurface.vue';
import WorkspaceTree from '../../src/view/workspace/WorkspaceTree.vue';
import WorkspaceTabs from '../../src/view/workspace/WorkspaceTabs.vue';
import WorkspaceSessionList from '../../src/view/workspace/WorkspaceSessionList.vue';
import WorkspaceRegistrationPicker from '../../src/view/workspace/WorkspaceRegistrationPicker.vue';
import WorkspaceInspector from '../../src/view/workspace/WorkspaceInspector.vue';
import TerminalDock from '../../src/view/terminal/TerminalDock.vue';

const composerFixture = new URL(location.href).searchParams.has('composer');
const gestureFixture = new URL(location.href).searchParams.has('send-gesture');
const hostedGestureFixture = new URL(location.href).searchParams.has('hosted-gesture');
const submittedIntents = ref<string[]>([]);
const offlineFixture = new URL(location.href).searchParams.has('offline');
const workspaceRecoveryFixture = new URL(location.href).searchParams.has('workspace-recovery');
const idleComposer = new URL(location.href).searchParams.has('idle-composer');
const managedSessionOnly = new URL(location.href).searchParams.has('managed-session-only');
const mobile = window.matchMedia('(max-width: 767px)').matches;
const unreadFixture = new URL(location.href).searchParams.has('unread');
const contentSearchFixture = new URL(location.href).searchParams.has('content-search');
const overlappingWatchFixture = new URL(location.href).searchParams.has('overlapping-watch');
const fileRootFixture = new URL(location.href).searchParams.has('file-root');
const listStateFixture = new URL(location.href).searchParams.has('list-state');
const reorderFixture = new URL(location.href).searchParams.has('session-reorder');
const listState = ref(new URL(location.href).searchParams.get('list-state') ?? 'ready');
const fileRootPath = ref('/home/example/my-agent-roam');
const fileFeedback = ref({ message: '', type: '' });
const inspectorFixture =
  fileRootFixture ||
  overlappingWatchFixture ||
  contentSearchFixture ||
  new URL(location.href).searchParams.has('git-previews');
const multipleTerminalProfiles = new URL(location.href).searchParams.has('multipleProfiles');
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
const sessions = ref(
  (reorderFixture
    ? ['pinned-one', 'pinned-two', 'pinned-three', 'active', 'idle']
    : ['active', 'idle', 'other']
  ).map(
    (id, index) =>
      ({
        id,
        runner: 'mar',
        status: 'READY',
        ...(reorderFixture
          ? { lastActivityAt: 1000 - index * 100, pinOrder: index < 3 ? index : null }
          : {})
      }) as Session
  )
);
function advanceSessionActivity(): void {
  const next = sessions.value.at(-1)!;
  const pinned = sessions.value.filter((session) => session.pinOrder !== null);
  const unpinned = sessions.value.filter((session) => session.pinOrder === null);
  sessions.value = [
    ...pinned,
    {
      ...next,
      lastActivityAt: Math.max(...unpinned.map((session) => session.lastActivityAt!)) + 1
    },
    ...unpinned.filter((session) => session.id !== next.id)
  ];
}
function movePinnedSession(session: Session, target: Session, position: 'before' | 'after'): void {
  const pinned = sessions.value.filter((session) => session.pinOrder !== null);
  pinned.splice(
    pinned.findIndex((candidate) => candidate.id === session.id),
    1
  );
  const targetIndex = pinned.findIndex((candidate) => candidate.id === target.id);
  pinned.splice(targetIndex + (position === 'after' ? 1 : 0), 0, session);
  sessions.value = [
    ...pinned.map((candidate, pinOrder) => ({ ...candidate, pinOrder })),
    ...sessions.value.filter((candidate) => candidate.pinOrder === null)
  ];
}
const sessionProps = {
  ...(unreadFixture
    ? {
        sessionGroup: 'MAIN' as const,
        groupState: {
          MAIN: { running: 1, unread: true },
          CHILD: { running: 0, unread: true }
        }
      }
    : {}),
  mobileViewport: mobile,
  canLoadMore: false,
  loadingMore: false,
  active: true,
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
  hasUnread: () => unreadFixture
};
const surfacePage = shallowReactive({
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
  setComposerRangeEditor() {},
  workspaceTarget: { nodeId: 'node', workspaceId: 'offline' },
  workspaceHost: { connected: false },
  selectedWorkspace: undefined,
  workspaceSelectionLoading: false,
  retryWorkspaceSelection() {
    surfacePage.workspaceSelectionLoading = true;
  },
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
});
if (workspaceRecoveryFixture) surfacePage.workspaceHost = { connected: true };
if (composerFixture) {
  Object.assign(surfacePage, {
    workspaceHost: { connected: true },
    selectedWorkspace: workspaces[0],
    activeWorkspaceTabId: 'node:plain',
    visibleWorkspaceSessions: [],
    workspaceWatchTopicStatus: { sessions: 'ready', files: 'ready', changes: 'ready' },
    workspaceKindLabel: () => 'Directory',
    workspaceBranchLabel: () => undefined,
    workspaceTabLabel: () => 'Workspace',
    sessionTitle: () => 'Session',
    runnerBrandIcon: () => '',
    sessionActivity: () => 'IDLE',
    sessionActivityLabel: () => 'Idle',
    request: async <T,>() => ({}) as T,
    composerSessionOpen: true,
    composerRunner: 'mar',
    draftSessionOpen: true,
    conversationNextCursor: null,
    conversationTurns: [],
    conversationRuns: [],
    displayedConversationTurns: [],
    followConversation: true,
    liveConnected: true,
    selectedSessionId: idleComposer ? undefined : 'active',
    sessionInput: gestureFixture ? 'Follow up on mobile layout.' : '',
    activeComposerRun:
      gestureFixture && !idleComposer && !managedSessionOnly
        ? { id: 'run-a', sessionId: 'active', status: 'RUNNING', startedAt: Date.now() }
        : undefined,
    onComposerInput: () => undefined,
    sendSessionMessage: (intent?: string) => {
      submittedIntents.value.push(intent ?? 'SEND');
      Object.assign(surfacePage, { sessionInput: '' });
    },
    stopActiveRun: () => submittedIntents.value.push('STOP'),
    workPromptCompletion: { enabled: false },
    composerWorking: !idleComposer,
    composerWorkingLabel: 'Running',
    composerWorkingBusy: !idleComposer,
    composerElapsedLabel: idleComposer ? '' : '7m 13s',
    composerSkillTokens: [],
    composerFileReferences: [],
    activeCommandStates: [],
    currentSessionQueue: { items: [], paused: false },
    newSessionAttachments: [],
    canUseComposer: true,
    newSessionRunner: 'mar',
    composerRunnerOptions: [],
    composerRunnerLabel: 'MAR Agent',
    composerModelEffortLabel: 'Model',
    composerModels: [],
    composerEfforts: [],
    newSessionAccess: 'auto',
    composerAccessLabel: 'Auto',
    composerAccessOptions: [],
    contextUsageLabel: '',
    interruptVisible: !idleComposer,
    canInterruptTurn: !idleComposer,
    effortLabel: String
  });
}
</script>

<template>
  <HostedComposerGestureFixture v-if="hostedGestureFixture" />
  <Surface
    v-else-if="composerFixture || offlineFixture || workspaceRecoveryFixture"
    :page="surfacePage as never"
  />
  <main v-else>
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
        :has-unread="() => unreadFixture"
        @activate="activeTab = $event.id"
      />
    </section>
    <section aria-label="Workspace tree fixture">
      <WorkspaceTree
        :nodes="listState === 'no-nodes' ? [] : [node]"
        :expanded-node-ids="['node']"
        :workspace-target="
          listState === 'unselected'
            ? undefined
            : { nodeId: 'node', workspaceId: selectedWorkspace }
        "
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
      <button v-if="reorderFixture" type="button" @click="advanceSessionActivity">
        Advance session activity
      </button>
      <select v-if="listStateFixture" v-model="listState" aria-label="Set fixture list state">
        <option
          v-for="state in ['ready', 'main', 'child', 'loading', 'failed', 'no-nodes', 'unselected']"
          :key="state"
        >
          {{ state }}
        </option>
      </select>
      <WorkspaceSessionList
        v-bind="sessionProps"
        :sessions="listState === 'ready' ? sessions : []"
        :watch-status="listState === 'loading' || listState === 'failed' ? listState : 'ready'"
        :session-group="
          listState === 'child'
            ? 'CHILD'
            : listState === 'main'
              ? 'MAIN'
              : sessionProps.sessionGroup
        "
        :selected-session-id="selectedSession"
        :search-query="search"
        @open="selectedSession = $event"
        @refresh="action = 'refresh'"
        @search="action = 'search:' + $event"
        @move-pin-to="movePinnedSession"
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
      <button
        v-if="fileRootFixture"
        type="button"
        @click="fileRootPath = '/home/other/my-agent-roam'"
      >
        Switch root path
      </button>
      <button v-if="fileRootFixture" type="button" @click="fileRootPath = ''">
        Clear root path
      </button>
      <WorkspaceInspector
        :node-id="inspectorFixture ? 'node' : undefined"
        :workspace-id="inspectorFixture ? 'workspace' : undefined"
        workspace-name="Workspace"
        :workspace-path="fileRootFixture ? fileRootPath : undefined"
        workspace-kind="GIT_WORKSPACE"
        csrf-token="fixture"
        :renew-csrf-token="async () => 'fixture'"
        :enabled="true"
        :mobile-viewport="mobile"
        :content-search-enabled="true"
        :code-navigation-enabled="false"
        :code-navigation-prewarm-enabled="false"
        :files-watch-status="overlappingWatchFixture ? 'loading' : 'idle'"
        changes-watch-status="idle"
        :history-capability="true"
        :file-write-enabled="false"
        @notice="(message, type) => (fileFeedback = { message, type: type ?? 'info' })"
      />
      <output
        v-if="inspectorFixture"
        aria-label="File operation feedback"
        :data-type="fileFeedback.type"
      >
        {{ fileFeedback.message }}
      </output>
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
            profiles: [
              { id: 'bash', label: 'Shell' },
              ...(multipleTerminalProfiles ? [{ id: 'other-shell', label: 'Other shell' }] : [])
            ],
            supportsConPty: false
          } as never
        "
        :direct="terminalDirect"
        :error-message="String"
      />
    </section>
  </main>
  <aside v-if="gestureFixture" class="gesture-fixture-controls">
    <output aria-label="Submitted intents">{{ submittedIntents.join(',') }}</output>
    <button
      type="button"
      @click="Object.assign(surfacePage, { activeComposerRun: { id: 'run-b', status: 'RUNNING' } })"
    >
      Change run
    </button>
    <button type="button" @click="Object.assign(surfacePage, { sessionInput: '' })">
      Clear draft
    </button>
    <button type="button" @click="Object.assign(surfacePage, { selectedSessionId: 'other' })">
      Change session
    </button>
    <button
      type="button"
      @click="
        Object.assign(surfacePage, {
          selectedWorkspace: workspaces[1],
          activeWorkspaceTabId: 'node:grouped'
        })
      "
    >
      Change workspace
    </button>
  </aside>
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
.gesture-fixture-controls {
  position: fixed;
  top: 70px;
  right: 8px;
  z-index: 100;
}
</style>
