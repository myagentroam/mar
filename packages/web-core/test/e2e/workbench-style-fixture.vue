<script setup lang="ts">
import { createFileAccessFixture } from '../support/file-access-fixture.js';

import { computed, onBeforeUnmount, ref, shallowReactive, shallowRef, watch } from 'vue';
import HostedComposerGestureFixture from './hosted-composer-gesture-fixture.vue';
import type { AgentRun, NodeSummary, Session, Workspace } from '../../src/model/workbench.js';
import Surface from '../../src/view/workbench/WorkbenchSurface.vue';
import { registerWorkspacePaneShortcuts } from '../../src/service/workspace-session-pane-state.js';
import { createConversationStateService } from '../../src/service/conversation-state-service.js';
import { createConversationScrollService } from '../../src/service/conversation-scroll-service.js';
import { createWorkbenchPageController } from '../../src/service/workbench-page-controller.js';
import { createWorkbenchNavigationService } from '../../src/service/workbench-navigation-service.js';
import type { WorkbenchView } from '../../src/util/workbench-route.js';
import type { SettingsSection } from '../../src/model/settings.js';
import type { PromptCompletionBinding } from '../../src/service/prompt-completion-client-service.js';
import ComposerToolbar from '../../src/view/composer/ComposerToolbar.vue';
import ConversationComposer from '../../src/view/composer/ConversationComposer.vue';
import WorkspaceTree from '../../src/view/workspace/WorkspaceTree.vue';
import WorkspaceTabs from '../../src/view/workspace/WorkspaceTabs.vue';
import WorkspaceSessionList from '../../src/view/workspace/WorkspaceSessionList.vue';
import WorkspaceRegistrationPicker from '../../src/view/workspace/WorkspaceRegistrationPicker.vue';
import WorkbenchAside from '../../src/view/workbench/WorkbenchAside.vue';
import WorkspaceFilesPanel from '../../src/view/workspace/WorkspaceFilesPanel.vue';
import WorkspaceContentSearch from '../../src/view/workspace/WorkspaceContentSearch.vue';
import WorkspaceGitChanges from '../../src/view/workspace/WorkspaceGitChanges.vue';
import WorkspaceGitHistory from '../../src/view/workspace/WorkspaceGitHistory.vue';
import WorkspaceFileWorkbench from '../../src/view/workspace/WorkspaceFileWorkbench.vue';
import { createWorkspaceFileWorkbenchController } from '../../src/service/workspace-file-workbench-controller.js';
import type { WorkspaceFilePagePort } from '../../src/model/workspace-file-workbench.js';
import type { ChangeEntry, HistoryCommit, HistoryFile } from '../../src/model/workspace-git.js';
import { createScopedHttpService } from '../../src/service/scoped-http-service.js';
import { createWorkspaceFileOperationService } from '../../src/service/workspace-file-operation-service.js';
import { createWorkspaceFilesController } from '../../src/service/workspace-files-controller.js';
import { createWorkspaceContentSearchService } from '../../src/service/workspace-content-search-service.js';
import { createWorkspaceGitService } from '../../src/service/workspace-git-service.js';
import { translate } from '../../src/service/locale-preference-service.js';
import type { AsideTool } from '../../src/service/workbench-aside-service.js';
import TerminalDock from '../../src/view/terminal/TerminalDock.vue';

const gestureFixture = new URL(location.href).searchParams.has('send-gesture');
const composerFixture = new URL(location.href).searchParams.has('composer') && !gestureFixture;
const hostedGestureFixture = new URL(location.href).searchParams.has('hosted-gesture');
const submittedIntents = ref<string[]>([]);
const fixtureInput = ref(gestureFixture ? 'Follow up on mobile layout.' : '');
const offlineFixture = new URL(location.href).searchParams.has('offline');
const workspaceRecoveryFixture = new URL(location.href).searchParams.has('workspace-recovery');
const idleComposer = new URL(location.href).searchParams.has('idle-composer');
const managedSessionOnly = new URL(location.href).searchParams.has('managed-session-only');
const gestureSessionId = ref('active');
const gestureWorkspaceId = ref('plain');
const gestureActiveRun = ref<AgentRun | undefined>(
  gestureFixture && !idleComposer && !managedSessionOnly
    ? {
        id: 'run-a',
        sessionId: 'active',
        status: 'RUNNING',
        recoveryState: 'NONE',
        clientMessageId: 'fixture-run-a',
        startedAt: Date.now()
      }
    : undefined
);
const gestureContextKey = computed(() =>
  JSON.stringify([gestureWorkspaceId.value, gestureSessionId.value])
);
const gestureCompletion = computed<PromptCompletionBinding>(() => ({
  enabled: false,
  contextKey: gestureContextKey.value,
  request: async () => {
    throw new DOMException('Prompt completion is disabled in this fixture.', 'AbortError');
  }
}));
function submitGestureIntent(intent: 'SEND' | 'REPLACE_CURRENT' = 'SEND'): void {
  submittedIntents.value.push(intent);
  fixtureInput.value = '';
}
function changeGestureRun(): void {
  gestureActiveRun.value = {
    id: 'run-b',
    sessionId: gestureSessionId.value,
    workspaceId: gestureWorkspaceId.value,
    status: 'RUNNING',
    recoveryState: 'NONE',
    clientMessageId: 'fixture-run-b',
    startedAt: Date.now()
  };
}
const mobile = window.matchMedia('(max-width: 767px)').matches;
const unreadFixture = new URL(location.href).searchParams.has('unread');
const contentSearchFixture = new URL(location.href).searchParams.has('content-search');
const overlappingWatchFixture = new URL(location.href).searchParams.has('overlapping-watch');
const fileRootFixture = new URL(location.href).searchParams.has('file-root');
const lateTreeFixture = new URL(location.href).searchParams.has('late-tree');
const listStateFixture = new URL(location.href).searchParams.has('list-state');
const reorderFixture = new URL(location.href).searchParams.has('session-reorder');
const listState = ref(new URL(location.href).searchParams.get('list-state') ?? 'ready');
const fileRootPath = ref('/home/example/my-agent-roam');
const fileFeedback = ref({ message: '', type: '' });
const inspectorFixture =
  fileRootFixture ||
  overlappingWatchFixture ||
  contentSearchFixture ||
  lateTreeFixture ||
  new URL(location.href).searchParams.has('git-previews');
const toolTarget = { nodeId: 'node', workspaceId: 'workspace' };
const selectedTool = ref<AsideTool>(lateTreeFixture ? 'search' : 'files');
const toolState = computed(() => ({
  tools: ['files', 'search', 'changes', 'history'] as AsideTool[],
  sessions: [],
  active: { kind: 'tool' as const, id: selectedTool.value }
}));
const toolLabels = computed(() => [
  { id: 'files' as const, label: translate('generated.workspaceInspector.files3') },
  { id: 'search' as const, label: translate('generated.workspaceInspector.search') },
  { id: 'changes' as const, label: translate('generated.workspaceInspector.gitChanges') },
  { id: 'history' as const, label: translate('generated.workspaceInspector.gitHistory') }
]);
const toolHttp = createScopedHttpService({
  csrfToken: () => 'fixture',
  renewCsrfToken: async () => 'fixture'
});
const toolOperations = createWorkspaceFileOperationService({
  http: toolHttp,
  onWritten: async () => {}
});
const toolFiles = createWorkspaceFilesController({
  target: () => (inspectorFixture ? toolTarget : undefined),
  workspaceName: () => fileRootPath.value.split('/').filter(Boolean).at(-1) || 'Workspace',
  list: toolOperations.list,
  mutate: toolOperations.mutate,
  revealLocal: toolOperations.reveal,
  preflight: toolOperations.preflight,
  queue: () => {},
  onFailure: () => {},
  onListFailure: () => {},
  onDeletedSelection: () => {},
  onRevealSelection: async () => {},
  onMutationFailure: (error) => {
    fileFeedback.value = { message: String(error), type: 'error' };
  },
  onWorkspace: () => {}
});
if (lateTreeFixture) {
  toolFiles.tree.applyRootPage({
    entries: Array.from({ length: 500 }, (_, index) => ({
      path: `file-${String(index).padStart(3, '0')}.ts`,
      name: `file-${String(index).padStart(3, '0')}.ts`,
      kind: 'FILE' as const,
      size: 1
    })),
    nextCursor: null
  });
  toolFiles.tree.selectPath('file-450.ts');
}
const toolSearch = createWorkspaceContentSearchService({ http: toolHttp, onFailure: () => {} });
const toolGit = createWorkspaceGitService({
  http: toolHttp,
  target: () => (inspectorFixture ? toolTarget : undefined),
  gitEnabled: () => inspectorFixture,
  historyEnabled: () => inspectorFixture,
  onFailure: () => {},
  onWorkspace: () => {},
  onBranch: () => {}
});
const fixtureFilePage = shallowRef<WorkspaceFilePagePort>();
const fixtureFileWorkbench = createWorkspaceFileWorkbenchController({
  target: () => (inspectorFixture ? toolTarget : undefined),
  externalTarget: () => toolTarget,
  fileWriteEnabled: () => true,
  page: () => fixtureFilePage.value,
  prewarmEnabled: () => false,
  resolveRepositoryPath: toolGit.resolveRepositoryPath,
  comparison: toolGit.comparison,
  reveal: async () => {},
  onPopupBlocked: () => {},
  onOpenFailure: () => {},
  onRevealFailure: () => {},
  access: createFileAccessFixture({ http: toolHttp, transfers: () => ({}) }),
  preview: { onWritten: () => {} },
  navigation: { http: toolHttp, onFileTarget: () => {}, onFailure: () => {} }
});
onBeforeUnmount(() => fixtureFileWorkbench.dispose());
function openFixtureChange(entry: ChangeEntry): void {
  const intent = toolGit.changeIntent(entry);
  if (intent) void fixtureFileWorkbench.openTab(intent);
}
function openFixtureHistory(commit: HistoryCommit, file: HistoryFile): void {
  const intent = toolGit.historyIntent(commit, file);
  if (intent) void fixtureFileWorkbench.openTab(intent);
}
function registerFixtureFilePage(
  page: WorkspaceFilePagePort | undefined,
  previous?: WorkspaceFilePagePort
): void {
  if (page || fixtureFilePage.value === previous) fixtureFilePage.value = page;
}
watch(fileRootPath, (path) =>
  toolFiles.tree.setRootName(path.split('/').filter(Boolean).at(-1) || 'Workspace')
);
function selectFixtureTool(target: { id: AsideTool }): void {
  if (selectedTool.value === 'history') toolGit.cancelHistoryPending();
  selectedTool.value = target.id;
  if (target.id === 'changes') void toolGit.loadChanges(true);
  if (target.id === 'history') void toolGit.openHistory();
}
const multipleTerminalProfiles = new URL(location.href).searchParams.has('multipleProfiles');
const embeddedTerminal = new URL(location.href).searchParams.has('embedded-terminal');
const node: NodeSummary = {
  id: 'node',
  displayName: 'Node',
  registeredAddress: 'fixture.invalid',
  platform: 'linux',
  architecture: 'x64',
  nodeAppVersion: 'fixture',
  nodeVersion: 'fixture',
  connected: true,
  disabled: false,
  capabilities: {}
};
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
  setAsideSurfaceVisible() {},
  asideViewMode: () => 'compact' as const,
  asideWidth: () => undefined,
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
  mainPane: {
    registerShortcuts: registerWorkspacePaneShortcuts,
    conversation: createConversationStateService(() => undefined),
    scroll: createConversationScrollService(),
    draft: {
      input: fixtureInput,
      skillTokens: ref([]),
      references: ref([])
    },
    attachments: { attachments: ref([]) },
    draggingAttachments: ref(false),
    queue: {
      startEditing() {},
      finishEditing() {},
      editingQueueItemId: ref(),
      editingContent: ref(''),
      draggingQueueItemId: ref()
    },
    setInputFocus() {},
    setRangeEditor() {}
  },
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
  const originalFetch = window.fetch;
  window.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/api/runner-profiles?')) {
      return Promise.resolve(
        Response.json({
          profiles: [
            {
              runner: 'mar-agent',
              models: [
                { id: 'fixture-model', label: 'Fixture model', supportedEfforts: ['medium'] }
              ],
              accessOptions: [{ id: 'auto', label: 'Auto' }],
              commands: [],
              capabilities: ['turn.start']
            }
          ]
        })
      );
    }
    return originalFetch(input, init);
  };
  onBeforeUnmount(() => {
    window.fetch = originalFetch;
  });
  const panePage = createWorkbenchPageController({
    navigation: createWorkbenchNavigationService<WorkbenchView, SettingsSection, string>({
      initialView: 'nodes',
      initialSettingsSection: 'account',
      initialManagementSection: 'system',
      opensMobileSidebar: (view) => view === 'nodes'
    }),
    management: { items: () => [] },
    systemManagementSection: 'system',
    nodeManagementSection: 'system',
    webVersion: 'fixture'
  });
  panePage.nodes.value = [node];
  panePage.workspaceTarget.value = { nodeId: node.id, workspaceId: workspaces[0]!.id };
  panePage.workspaces.value = workspaces;
  panePage.nodeManifest.value = {
    manifestVersion: 1,
    observedAt: 1,
    conversation: { available: true, reasonCode: null },
    files: { available: true, reasonCode: null },
    sessionAside: { apiVersion: 1 }
  } as never;
  panePage.draftSessionOpen.value = true;
  panePage.mobileViewport.value = mobile;
  void panePage.mainPaneController.composer.loadProfiles();
  Object.assign(surfacePage, {
    mainPaneController: panePage.mainPaneController,
    fileWorkbench: fixtureFileWorkbench,
    setWorkspaceFilePage: registerFixtureFilePage,
    adjacentWorkspaceDiff: toolGit.adjacentDiff,
    loadWorkspaceDiff: toolGit.loadDiff,
    openWorkspaceFileExternal: () => {},
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
    activeComposerRun:
      gestureFixture && !idleComposer && !managedSessionOnly
        ? { id: 'run-a', sessionId: 'active', status: 'RUNNING', startedAt: Date.now() }
        : undefined,
    onComposerInput: () => undefined,
    referenceSessionAvailable: () => false,
    sendSessionMessage: (intent?: string) => {
      submittedIntents.value.push(intent ?? 'SEND');
      fixtureInput.value = '';
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
  <section v-else-if="gestureFixture" class="gesture-composer-fixture">
    <ConversationComposer
      v-model:input="fixtureInput"
      placeholder="Message"
      :working="!idleComposer"
      working-label="Running"
      :working-busy="!idleComposer"
      :elapsed-label="idleComposer ? '' : '7m 13s'"
      :readonly="false"
      :drop-target="false"
      :mobile-viewport="mobile"
      :command-states="[]"
      :loading="false"
      :skill-tokens="[]"
      :completion="gestureCompletion"
      @submit="submitGestureIntent()"
    >
      <template #toolbar>
        <ComposerToolbar
          :draft-session-open="true"
          runner="mar"
          :runner-options="[]"
          :runner-loading="false"
          runner-label="MAR Agent"
          :model-effort-selection="undefined"
          model-effort-label="Model"
          selected-model=""
          selected-effort=""
          :models="[]"
          :efforts="[]"
          access="auto"
          access-label="Auto"
          :access-options="[]"
          :configuration-disabled="false"
          :access-disabled="false"
          :fast-enabled="false"
          :context-usage="undefined"
          context-usage-label=""
          :can-compact-context="false"
          :mobile-viewport="mobile"
          :context-key="gestureContextKey"
          :active-run="gestureActiveRun"
          :can-interrupt="!idleComposer"
          :interrupt-visible="!idleComposer"
          :input-has-content="fixtureInput.trim().length > 0"
          :has-selected-command="false"
          :loading="false"
          :submitting="false"
          :attachments-pending="false"
          :effort-label="String"
          @stop="submittedIntents.push('STOP')"
          @send="submitGestureIntent()"
          @steer="submitGestureIntent('REPLACE_CURRENT')"
        />
      </template>
    </ConversationComposer>
  </section>
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
      <WorkbenchAside
        :workspace="toolTarget"
        :state="toolState"
        :tools="toolLabels"
        browser-label="Browser"
        :sessions="[]"
        tab-label="Workspace tools"
        :close-label="(title) => title"
        resize-label="Resize"
        :width="360"
        :min-width="200"
        :max-width="600"
        mode="compact"
        :mobile="mobile"
        @select-tool="selectFixtureTool"
      >
        <template #tool="{ tool, visible }">
          <WorkspaceFilesPanel
            v-if="inspectorFixture && tool === 'files'"
            :service="toolFiles"
            :visible="visible"
            :workspace-path="fileRootFixture ? fileRootPath : undefined"
            :mobile-viewport="mobile"
            :watch-status="overlappingWatchFixture ? 'loading' : 'idle'"
            @refresh="toolFiles.requestRefresh()"
            @notice="(message, type) => (fileFeedback = { message, type })"
          />
          <WorkspaceContentSearch
            v-else-if="inspectorFixture && tool === 'search'"
            :service="toolSearch"
            :enabled="true"
            node-id="node"
            workspace-id="workspace"
          />
          <WorkspaceGitChanges
            v-else-if="inspectorFixture && tool === 'changes' && visible"
            :service="toolGit"
            :target="toolTarget"
            @open="openFixtureChange"
          />
          <WorkspaceGitHistory
            v-else-if="inspectorFixture && tool === 'history' && visible"
            :service="toolGit"
            @open="openFixtureHistory"
          />
          <p v-else-if="!inspectorFixture">
            {{ translate('generated.workspaceInspector.theNodeIsOfflineOrDoesNot') }}
          </p>
        </template>
      </WorkbenchAside>
      <WorkspaceFileWorkbench
        v-if="inspectorFixture"
        node-id="node"
        workspace-id="workspace"
        :controller="fixtureFileWorkbench"
        :register-page="registerFixtureFilePage"
        :adjacent-diff="toolGit.adjacentDiff"
        :load-diff="toolGit.loadDiff"
        :open-external="() => {}"
        :enabled="true"
        :code-navigation-enabled="false"
        :file-write-enabled="true"
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
        :embedded="embeddedTerminal"
        node-id="node"
        workspace-id="workspace"
        csrf-token="fixture"
        :renew-csrf-token="async () => 'fixture'"
        :enabled="true"
        :active="true"
        :visible="embeddedTerminal"
        :mobile-mode="embeddedTerminal && mobile"
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
    <button type="button" @click="changeGestureRun">Change run</button>
    <button type="button" @click="fixtureInput = ''">Clear draft</button>
    <button type="button" @click="gestureSessionId = 'other'">Change session</button>
    <button type="button" @click="gestureWorkspaceId = 'grouped'">Change workspace</button>
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
section[aria-label='Inspector fixture'] :deep(.workbench-aside) {
  width: 100% !important;
  height: 100%;
  min-height: 280px;
}
.gesture-fixture-controls {
  position: fixed;
  top: 70px;
  right: 8px;
  z-index: 100;
}
.gesture-composer-fixture {
  display: flex;
  flex-direction: column;
  height: 100dvh;
}
.gesture-composer-fixture :deep(.composer-host) {
  margin-top: auto;
}
</style>
