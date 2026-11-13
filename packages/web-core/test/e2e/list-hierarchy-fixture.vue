<script setup lang="ts">
import { ref } from 'vue';
import type { CodexCredentialSummary, CodexModelCatalog } from '@myagentroam/protocol';
import SkillCenterPage from '../../src/view/skill/SkillCenterPage.vue';
import SkillSourceManagementPage from '../../src/view/skill/SkillSourceManagementPage.vue';
import McpSourceManagementPage from '../../src/view/skill/McpSourceManagementPage.vue';
import McpCenterPanel from '../../src/view/skill/McpCenterPanel.vue';
import MarAgentModelManagementPage from '../../src/view/settings/MarAgentModelManagementPage.vue';
import QuickOpenDialog from '../../src/view/workspace/QuickOpenDialog.vue';
import WorkbenchRecentSessionList from '../../src/view/workbench/WorkbenchRecentSessionList.vue';
import type { RecentRun } from '../../src/service/workbench-notification-service.js';
import type { Session } from '../../src/model/workbench.js';

const view = new URLSearchParams(location.search).get('list-hierarchy');
const scopeColumns = new URLSearchParams(location.search).has('scope-columns');
const scopeLabels: Readonly<Record<string, string>> = {
  ENTERPRISE: 'Enterprise',
  ORGANIZATION: 'Organization',
  PERSONAL: 'Personal'
};
const scopeLabel = (scope: string) => scopeLabels[scope] ?? scope;
const scopeEntries = ['ENTERPRISE', 'ORGANIZATION', 'PERSONAL'].map((scope, index) => ({
  id: `source-${index}`,
  name: `Source ${index + 1}`,
  scope,
  locator: 'https://example.com/source',
  enabled: true,
  builtIn: false,
  kind: 'REPOSITORY',
  status: 'READY',
  manageable: false,
  sourceId: `source-${index}`,
  normalizedName: `Skill ${index + 1}`,
  serverName: `mcp-${index}`,
  displayName: `MCP ${index + 1}`,
  description: 'Catalog entry',
  repositoryIdentity: 'https://example.com/source',
  skillPath: 'skills/example',
  commitSha: 'c'.repeat(40),
  currentVersionId: 'version',
  tlsVerified: true,
  version: '1.0.0',
  runtime: { transport: 'STDIO' },
  featured: false,
  tags: [],
  updatedAt: 1
}));
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
  if (pathname === '/api/skill-sources' || pathname === '/api/mcp-sources')
    return { sources: scopeColumns ? scopeEntries : [] } as T;
  if (scopeColumns && pathname.startsWith('/api/skill-sources/')) return { skills: [] } as T;
  if (pathname === '/api/skill-favorites' || pathname === '/api/mcp-catalog') {
    return {
      [pathname.endsWith('skill-favorites') ? 'favorites' : 'entries']: scopeColumns
        ? scopeEntries
        : [],
      page: 1,
      pageSize: 20,
      total: scopeColumns ? scopeEntries.length : 0,
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
    <SkillSourceManagementPage
      v-if="view === 'sources'"
      :request="request"
      :writable="false"
      v-bind="scopeColumns ? { scopeLabel } : {}"
    />
    <McpSourceManagementPage
      v-if="view === 'mcp-sources'"
      :request="request"
      :writable="false"
      :scope-label="scopeLabel"
    />
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
      session-group="MAIN"
      :group-state="{ MAIN: { running: 1, unread: false }, CHILD: { running: 0, unread: false } }"
      :runs="runs"
      :has-unread-session="() => false"
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
