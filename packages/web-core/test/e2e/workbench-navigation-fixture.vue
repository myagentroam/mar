<script setup lang="ts">
// Real navigation and content components with deterministic, local-only presentation data.
import { computed, ref } from 'vue';
import type { SessionGroup } from '@myagentroam/protocol';
import type { Session } from '../../src/model/workbench.js';
import { runnerBrandIcon } from '../../src/util/runner-brand-icon.js';
import WorkspaceTabs from '../../src/view/workspace/WorkspaceTabs.vue';
import WorkspaceSessionList from '../../src/view/workspace/WorkspaceSessionList.vue';
import ConversationHeader from '../../src/view/conversation/ConversationHeader.vue';
import ConversationComposer from '../../src/view/composer/ConversationComposer.vue';
import AgentMarkdown from '../../src/view/common/AgentMarkdown.vue';

const mobile = new URLSearchParams(location.search).has('mobile');
const wideContent = new URLSearchParams(location.search).has('wide-content');
const activeTab = ref('workbench');
const tabs = ref([
  {
    id: 'workbench',
    nodeId: 'node',
    workspaceId: 'workbench',
    label: 'MyAgentRoam',
    lastActiveAt: 3
  },
  { id: 'protocol', nodeId: 'node', workspaceId: 'protocol', label: 'Protocol', lastActiveAt: 2 },
  { id: 'docs', nodeId: 'node', workspaceId: 'docs', label: 'Documentation', lastActiveAt: 1 }
]);
const sessionNames = [
  'Review workspace navigation',
  'Validate protocol compatibility',
  'Polish conversation layout',
  'Document keyboard shortcuts',
  'Investigate a long session title that should remain readable without shifting actions'
];
const sessions: Session[] = sessionNames.map((title, index) => ({
  id: `session-${index + 1}`,
  workspaceId: 'workbench',
  runner: 'mar-agent',
  externalSessionId: `session-${index + 1}`,
  title
}));
const selectedId = ref('session-1');
const selected = computed(() => sessions.find((session) => session.id === selectedId.value));
const group = ref<SessionGroup>('MAIN');
const search = ref('');
const input = ref('');
const filtered = computed(() =>
  sessions.filter((session) => session.title!.toLowerCase().includes(search.value.toLowerCase()))
);
const title = (session: Session) => session.title ?? session.id;
async function request<T>(path: string): Promise<T> {
  throw new Error(`Unexpected navigation fixture request: ${path}`);
}
const overview = [
  '## Workspace navigation review',
  'Keep the working context clear. Navigation should stay easy to scan without competing with the conversation.',
  '### Review scope',
  '- Preserve workspace and session selection.',
  '- Keep running status and unread notifications visible.',
  '- Verify keyboard focus, long titles, and touch controls.',
  '### Verification',
  '| Surface | Coverage |\n| --- | --- |\n| Workspace tabs | Selected · hover · keyboard focus |\n| Session list | Search · selection · status |\n| Themes | Dark · light · custom colors |',
  'No changes to execution, permissions, or workspace persistence.'
].join('\n\n');
const response = wideContent
  ? [
      '## Content layout review',
      'Normal prose keeps its reading origin. Wide data and code stay inside the available work surface.',
      '| Package | Status | Build | Tests | Platform | Source | Revision | Notes |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| web-core | Passed | 12.4 s | 66 | Linux | Workspace | local | Navigation and content |\n| mar-node | Unchanged | — | — | Cross-platform | Workspace | 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef | Not modified |',
      '```typescript\nconst workspace = { name: "my-agent-roam", selectedSession: "review-navigation", inspector: "files", focus: "composer", preserveDraft: true, preserveReadingPosition: true };\nawait review(workspace);\n```',
      'Long paths remain readable without widening the page:',
      '`packages/web-core/src/view/workspace/review/navigation/representative/long/path/that/remains/bounded/inside/the/conversation/content/surface.ts`'
    ].join('\n\n')
  : overview;
</script>

<template>
  <main class="navigation-fixture" :class="{ mobile, 'content-preview': wideContent }">
    <WorkspaceTabs
      placement="body"
      :tabs="tabs"
      :active-tab-id="activeTab"
      :node-label="() => 'Development node'"
      :direct-available="() => false"
      :direct-description="() => undefined"
      :has-active-run="(_nodeId, id) => id === 'workbench'"
      :has-unread="(_nodeId, id) => id === 'docs'"
      @activate="activeTab = $event.id"
      @close="tabs = tabs.filter((tab) => tab.id !== $event.id)"
    />
    <div class="navigation-content">
      <WorkspaceSessionList
        :session-group="group"
        :sessions="filtered"
        :selected-session-id="selectedId"
        :mobile-viewport="mobile"
        :active="true"
        :can-load-more="false"
        :loading-more="false"
        watch-status="ready"
        :node-ready="true"
        :loading="false"
        workspace-kind="GIT_WORKSPACE"
        workspace-kind-label="Git"
        workspace-branch="develop"
        :title="title"
        :runner-icon="runnerBrandIcon"
        :activity="(session) => (session.id === 'session-1' ? 'MANAGED_ACTIVE' : 'IDLE')"
        :activity-label="(session) => (session.id === 'session-1' ? 'Running' : 'Idle')"
        :activity-date-time="() => '2026-11-11T04:00:00Z'"
        :activity-title="() => 'November 11, 2026'"
        :relative-activity="(session) => (session.id === 'session-1' ? 'Now' : '12m')"
        node-id="node"
        workspace-id="workbench"
        :skill-supported="false"
        :mcp-supported="false"
        :cleanup-sessions-supported="false"
        :search-supported="true"
        :search-query="search"
        :searching="false"
        :refreshing="false"
        :workspace-manageable="true"
        :request="request"
        :has-unread="(id) => id === 'session-3'"
        @open="selectedId = $event"
        @search="search = $event"
        @select-group="group = $event"
      />
      <section v-if="!mobile" class="reading-pane" aria-label="Conversation sample">
        <ConversationHeader
          :session="selected"
          runner="mar-agent"
          :files-ready="false"
          :terminal-ready="false"
          :content-search-ready="false"
          :runner-icon="runnerBrandIcon"
          :session-title="title"
        />
        <div class="reading-content"><AgentMarkdown :content="response" /></div>
        <ConversationComposer
          v-model:input="input"
          placeholder="Ask a follow-up question…"
          :working="false"
          working-label="Working"
          :readonly="false"
          :drop-target="false"
          :mobile-viewport="false"
          :command-states="[]"
          :loading="false"
          :skill-tokens="[]"
        />
      </section>
    </div>
  </main>
</template>

<style scoped>
.navigation-fixture {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--mar-conversation-canvas);
}
.navigation-content {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}
.reading-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.reading-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 1.5rem 2.5rem;
}
.mobile .navigation-content {
  grid-template-columns: minmax(0, 1fr);
}
.content-preview .reading-content {
  padding: 1rem;
}
@media (max-width: 767px) {
  .content-preview .navigation-content {
    grid-template-columns: minmax(0, 1fr);
  }
  .content-preview :deep(.conversation-sidebar) {
    display: none;
  }
}
</style>
