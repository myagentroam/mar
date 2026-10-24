<script setup lang="ts">
import { ref } from 'vue';
import type { CodexCredentialSummary, CodexModelCatalog } from '@myagentroam/protocol';
import SkillCenterPage from '../../src/view/skill/SkillCenterPage.vue';
import SkillSourceManagementPage from '../../src/view/skill/SkillSourceManagementPage.vue';
import McpCenterPanel from '../../src/view/skill/McpCenterPanel.vue';
import MarAgentModelManagementPage from '../../src/view/settings/MarAgentModelManagementPage.vue';
import QuickOpenDialog from '../../src/view/workspace/QuickOpenDialog.vue';
import WorkbenchRecentSessionList from '../../src/view/workbench/WorkbenchRecentSessionList.vue';
import type { RecentRun } from '../../src/service/workbench-notification-service.js';
import type { Session } from '../../src/model/workbench.js';

const view = new URLSearchParams(location.search).get('list-hierarchy');
const open = ref(true);
const opened = ref('');
const sessions: Session[] = ['Review first', 'Review second'].map((id) => ({
  id,
  workspaceId: 'workspace',
  runner: 'mar-agent',
  externalSessionId: id
}));
const runs: RecentRun[] = sessions.map((session, index) => ({
  nodeId: 'node',
  runId: session.id,
  workspaceId: 'workspace',
  workspaceName: 'Project',
  sessionId: session.id,
  sessionTitle: session.id,
  userMessage: 'Review the current change',
  runner: 'mar-agent',
  status: index === 0 ? 'RUNNING' : 'SUCCEEDED',
  createdAt: 1,
  startedAt: 1,
  completedAt: index === 0 ? null : 2,
  updatedAt: 2,
  sortAt: 2,
  version: 1
}));
const credential: CodexCredentialSummary = {
  id: 'credential',
  name: 'Catalog credential',
  type: 'CODEX_OAUTH',
  ownership: { ownerType: 'PERSONAL', ownerUserId: 1 },
  status: 'ACTIVE',
  accessTokenExpiresAt: null,
  lastRefreshAt: null,
  lastCheckedAt: null,
  accountId: 'fixture',
  proxy: { configured: false },
  revision: 1
};
const catalog: CodexModelCatalog = {
  catalogHash: 'c'.repeat(64),
  fetchedAt: 1,
  models: [
    {
      upstreamModelId: 'catalog-model',
      displayName: 'Catalog model',
      reasoningEfforts: ['medium'],
      unsupportedReasoningEfforts: [],
      inputCapabilities: ['TEXT'],
      hostedWebSearch: false,
      warnings: [],
      requiredInputs: ['contextWindowTokens']
    }
  ]
};
async function request<T>(path: string): Promise<T> {
  const pathname = new URL(path, location.origin).pathname;
  if (pathname === '/api/resources') return { nodes: [], workspaces: [] } as T;
  if (pathname === '/api/skill-sources') return { sources: [] } as T;
  if (pathname === '/api/skill-favorites' || pathname === '/api/mcp-catalog') {
    return {
      [pathname.endsWith('skill-favorites') ? 'favorites' : 'entries']: [],
      page: 1,
      pageSize: 20,
      total: 0,
      hasMore: false,
      facets: { tags: ['Engineering', 'Writing'] }
    } as T;
  }
  if (pathname === '/api/admin/mar-agent/models') return { models: [] } as T;
  if (pathname === '/api/admin/mar-agent/codex-credentials')
    return { credentials: [credential] } as T;
  if (pathname === '/api/admin/mar-agent/codex-credentials/credential')
    return { details: { credential, socks5Url: null } } as T;
  if (pathname === '/api/admin/mar-agent/codex-credentials/credential/models/load')
    return { catalog } as T;
  throw new Error(`Unexpected fixture request: ${path}`);
}
</script>

<template>
  <main class="list-hierarchy-fixture">
    <output data-testid="opened">{{ opened }}</output>
    <SkillCenterPage v-if="view === 'skills'" :request="request" :nodes="[]" />
    <SkillSourceManagementPage v-if="view === 'sources'" :request="request" :writable="false" />
    <McpCenterPanel v-if="view === 'mcp'" :request="request" :nodes="[]" />
    <MarAgentModelManagementPage
      v-if="view === 'models'"
      :request="request"
      :nodes="[]"
      :writable="true"
      :can-manage-models="true"
    />
    <QuickOpenDialog
      v-if="view === 'quick' && open"
      :open="open"
      :node-id="undefined"
      :workspace-id="undefined"
      :files-ready="false"
      :symbols-ready="false"
      :nodes="[]"
      :sessions="sessions"
      :session-title="(session) => session.id"
      :open-session="
        async (id) => {
          opened = id;
        }
      "
      :open-workspace="async () => false"
      :workspace-tabs="[]"
      @close="open = false"
    />
    <WorkbenchRecentSessionList
      v-if="view === 'recent'"
      :runs="runs"
      :mobile-mode="false"
      :run-time="() => 'Just now'"
      @open-recent-run="opened = $event.sessionId"
    />
  </main>
</template>

<style scoped>
.list-hierarchy-fixture {
  padding: 16px;
}
</style>
