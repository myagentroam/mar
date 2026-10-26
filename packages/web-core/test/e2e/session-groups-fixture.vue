<script setup lang="ts">
import { computed, ref } from 'vue';
import type { SessionGroup } from '@myagentroam/protocol';
import type { Session } from '../../src/model/workbench.js';
import WorkspaceSessionList from '../../src/view/workspace/WorkspaceSessionList.vue';
import WorkspaceTabs from '../../src/view/workspace/WorkspaceTabs.vue';
import ConversationHeader from '../../src/view/conversation/ConversationHeader.vue';
import WorkbenchRecentSessions from '../../src/view/workbench/WorkbenchRecentSessions.vue';
import { createWorkbenchNotificationService } from '../../src/service/workbench-notification-service.js';
import { createWorkbenchEntityService } from '../../src/service/workbench-entity-service.js';
import { showMessage } from '../../src/service/message-feedback-service.js';
import { translate } from '../../src/service/locale-preference-service.js';

const mobile = matchMedia('(max-width: 767px)').matches;
const group = ref<SessionGroup>('MAIN');
const selected = ref('main');
const sessions = ref<Session[]>([
  {
    id: 'main',
    externalSessionId: 'main',
    sessionGroup: 'MAIN',
    runner: 'mar-agent',
    status: 'READY'
  },
  { id: 'child', sessionGroup: 'CHILD', runner: 'mar-agent', status: 'READY' }
] as Session[]);
const service = createWorkbenchNotificationService(ref(undefined));
const now = Date.now();
service.recentRuns.value = Array.from({ length: 103 }, (_, index) => ({
  nodeId: 'node',
  workspaceId: 'workspace',
  sessionId: index === 0 ? 'main' : `child-${index}`,
  sessionGroup: index === 0 ? 'MAIN' : 'CHILD',
  sessionTitle: index === 0 ? 'Main project conversation' : `Child collaboration ${index}`,
  workspaceName: 'Project',
  runner: 'mar-agent',
  status: index === 1 ? 'SUCCEEDED' : 'RUNNING',
  runId: `run-${index}`,
  createdAt: now,
  startedAt: now,
  completedAt: index === 1 ? now : null,
  sortAt: now,
  updatedAt: now,
  version: 1
}));
if (new URL(location.href).searchParams.has('stop-statuses')) {
  service.recentRuns.value = [
    {
      ...service.recentRuns.value[0]!,
      status: 'INTERRUPTED',
      interruptionReason: 'USER_STOP',
      completedAt: now
    },
    {
      ...service.recentRuns.value[1]!,
      sessionGroup: 'MAIN',
      status: 'INTERRUPTED',
      completedAt: now
    }
  ];
}
service.notifications.value = ['MAIN', 'CHILD'].map((sessionGroup) => ({
  id: sessionGroup,
  source: 'server',
  sourceId: sessionGroup,
  kind: 'run',
  title: 'Completed',
  createdAt: now,
  updatedAt: now,
  expiresAt: now + 60_000,
  read: false,
  target: {
    targetType: 'WORKSPACE_SESSION',
    nodeId: 'node',
    workspaceId: 'workspace',
    sessionId: sessionGroup,
    sessionGroup,
    sessionTitle: 'Project'
  }
})) as typeof service.notifications.value;
const groupState = computed(() => service.sessionGroupState('node', 'workspace'));
const shown = computed(() =>
  sessions.value.filter((session) => session.sessionGroup === group.value)
);
const actions = createWorkbenchEntityService({
  loading: ref(false),
  workspaceTarget: ref({ nodeId: 'node', workspaceId: 'workspace' }),
  renewCsrfToken: async () => 'fixture',
  sessionPathId: encodeURIComponent,
  nodeLabel: () => 'Node',
  sessionTitle: (session) => session.id,
  errorMessage: String,
  notice: (text, type) => showMessage(text, type),
  request: async <T,>(path: string, init?: RequestInit) => {
    if (path.includes('/metadata') && JSON.parse(String(init?.body)).clearParent === true) {
      const session = { ...sessions.value[1]!, sessionGroup: 'MAIN' as const };
      return { session } as T;
    }
    return {} as T;
  }
});
async function move(session: Session) {
  const updated = await actions.moveSessionToMain(session);
  if (updated)
    sessions.value = sessions.value.map((item) => (item.id === updated.id ? updated : item));
}
const props = {
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
  title: (session: Session) =>
    session.id === 'main'
      ? 'Main project conversation'
      : 'Child collaboration with a long descriptive title',
  runnerIcon: () => '',
  activity: () => 'MANAGED_ACTIVE',
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
  searchQuery: '',
  searching: false,
  refreshing: false,
  workspaceManageable: false,
  request: async <T,>() => ({}) as T,
  hasUnread: () => true
};
</script>

<template>
  <main class="fixture">
    <aside>
      <WorkspaceSessionList
        v-bind="props"
        :sessions="shown"
        :selected-session-id="selected"
        :session-group="group"
        :group-state="groupState"
        @select-group="group = $event"
        @open="selected = $event"
        @move-to-main="move"
      />
    </aside>
    <section class="conversation">
      <WorkspaceTabs
        :placement="mobile ? 'body' : 'header'"
        :tabs="[
          {
            id: 'workspace',
            nodeId: 'node',
            workspaceId: 'workspace',
            label: 'Project',
            lastActiveAt: now
          }
        ]"
        active-tab-id="workspace"
        :node-label="() => 'Node'"
        :direct-available="() => false"
        :direct-description="() => undefined"
        :has-active-run="() => true"
        :has-unread="() => false"
      />
      <ConversationHeader
        :session="sessions[0]"
        runner="mar-agent"
        :files-ready="false"
        :terminal-ready="false"
        :content-search-ready="false"
        :runner-icon="props.runnerIcon"
        :session-title="props.title"
      />
      <p>{{ selected }}</p>
      <p>{{ translate('sessionGroups.main') }}</p>
    </section>
    <div class="recent-host">
      <WorkbenchRecentSessions
        :service="service"
        :mobile-mode="mobile"
        mobile-panel-target="#recent-mobile"
        :mobile-presented="mobile"
        @open-recent-run="selected = $event.sessionId"
      />
    </div>
  </main>
</template>

<style scoped>
.fixture {
  display: flex;
  gap: 1rem;
  padding: 1rem;
  min-height: 95vh;
  background: var(--mar-bg-page);
  color: var(--mar-text-primary);
}
aside {
  width: 320px;
  flex: none;
  background: var(--mar-bg-panel);
}
.conversation {
  flex: 1;
  min-width: 0;
}
.recent-host {
  width: 2.5rem;
  flex: none;
}
@media (max-width: 767px) {
  .fixture {
    display: block;
    padding: 0.5rem;
    min-height: 0;
  }
  aside {
    width: 100%;
  }
  .conversation {
    min-height: 3rem;
  }
}
:global(#recent-mobile) {
  max-height: 420px;
  overflow-y: auto;
}
</style>
