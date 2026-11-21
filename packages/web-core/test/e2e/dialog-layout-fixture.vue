<script setup lang="ts">
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarForm, MarFormItem } from '@myagentroam/mar-ui/form';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarSelect, MarOption } from '@myagentroam/mar-ui/select';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarTable, MarTableColumn } from '@myagentroam/mar-ui/table';
import { h, onMounted, ref } from 'vue';
import type { NodeSummary } from '../../src/model/node.js';
import WorkspaceSessionList from '../../src/view/workspace/WorkspaceSessionList.vue';
import WorkspaceSessionCleanupDialog from '../../src/view/workspace/WorkspaceSessionCleanupDialog.vue';
import SkillDetailsDialog from '../../src/view/skill/SkillDetailsDialog.vue';
import McpDetailsDialog from '../../src/view/skill/McpDetailsDialog.vue';
import ThemeTokenHelp from '../../src/view/settings/ThemeTokenHelp.vue';
import MailTemplateManagement from '../../src/view/settings/MailTemplateManagement.vue';
import ResourceManagementPanel from '../../src/view/settings/ResourceManagementPanel.vue';
import FilePreviewSurface from '../../src/view/workspace/FilePreviewSurface.vue';
import ImagePreviewDialogs from '../../src/view/conversation/ImagePreviewDialogs.vue';
import QuickOpenDialog from '../../src/view/workspace/QuickOpenDialog.vue';
import WorkspaceRegistrationPicker from '../../src/view/workspace/WorkspaceRegistrationPicker.vue';
import WorkspaceFilesPanel from '../../src/view/workspace/WorkspaceFilesPanel.vue';
import { createWorkspaceFilesController } from '../../src/service/workspace-files-controller.js';
import { createWorkspaceFileOperationService } from '../../src/service/workspace-file-operation-service.js';
import { createScopedHttpService } from '../../src/service/scoped-http-service.js';
import { MarMessageBox } from '../../src/service/message-box-service.js';

const kind = new URLSearchParams(location.search).get('kind') ?? 'workspace';
const open = ref(false);
const fileSurface = ref<InstanceType<typeof FilePreviewSurface>>();
async function dismissFile(): Promise<void> {
  if (await fileSurface.value?.close()) open.value = false;
}
const focusDestination = ref<HTMLButtonElement>();
const registrationPath = ref('');
const pendingDirectoryName = ref('');
const registeredPath = ref('');
const registrationLoading = ref(false);
async function registerWorkspace(): Promise<void> {
  if (new URLSearchParams(location.search).has('defer-registration')) {
    registrationLoading.value = true;
    try {
      if (!(await fetch('/api/workspace-registration-fixture', { method: 'POST' })).ok) return;
    } finally {
      registrationLoading.value = false;
    }
  }
  registeredPath.value = registrationPath.value;
  open.value = false;
}
const fileTarget = { nodeId: 'node', workspaceId: 'workspace' };
const fileOperations = createWorkspaceFileOperationService({
  http: createScopedHttpService({
    csrfToken: () => 'fixture',
    renewCsrfToken: async () => 'fixture'
  }),
  onWritten: async () => {}
});
const files = createWorkspaceFilesController({
  target: () => fileTarget,
  workspaceName: () => 'Workspace',
  list: fileOperations.list,
  mutate: fileOperations.mutate,
  revealLocal: fileOperations.reveal,
  preflight: fileOperations.preflight,
  queue: () => {},
  onFailure: () => {},
  onListFailure: () => {},
  onDeletedSelection: () => {},
  onRevealSelection: async () => {},
  onMutationFailure: () => {},
  onWorkspace: () => {}
});
onMounted(() => {
  if (kind === 'upload') void files.requestRefresh();
});
const value = ref('');
const resourceName = new URLSearchParams(location.search).has('long-name')
  ? (kind === 'details' ? 'w' : 'W').repeat(128)
  : 'Long skill';
const nodes: NodeSummary[] = [
  {
    id: 'node',
    displayName: 'Node',
    registeredAddress: '127.0.0.1',
    platform: 'linux',
    architecture: 'x64',
    nodeAppVersion: '0.10.1',
    nodeVersion: '22.0.0',
    connected: true,
    disabled: false,
    capabilities: {}
  }
];
const longText = Array.from({ length: 60 }, (_, i) => `Description line ${i + 1}`).join('\n');
const entries = Array.from({ length: 60 }, (_, i) => ({
  id: `entry-${i}`,
  name: `Skill ${i + 1}`,
  description: `Long description for entry ${i + 1}. `.repeat(4),
  localStatus: ['VALID', 'UNKNOWN_VERSION', 'PARTIAL'][i] ?? 'VALID',
  source: i === 0 ? 'NODE_HOME' : 'WORKSPACE',
  skillFilePath: `/workspace/skills/entry-${i}/SKILL.md`,
  catalogEntryId: `entry-${i}`,
  serverName: `mcp-${i + 1}`,
  displayName: `MCP ${i + 1}`,
  version: '1.0.0',
  origin: 'WORKSPACE',
  enabled: true,
  status: 'CURRENT',
  installedAt: 0
}));

async function request<T>(path: string): Promise<T> {
  if (path.startsWith('/api/resources?')) {
    return { nodes: [], workspaces: [], page: 1, pageSize: 20, total: 0, hasMore: false } as T;
  }
  if (path.includes('/effective-skills')) return { skills: entries } as T;
  if (path.includes('/mcps?')) return { installations: entries } as T;
  if (path.startsWith('/api/mcp-catalog?')) return { entries } as T;
  if (path === '/api/mail/templates') {
    return [
      {
        id: 'mail',
        kind: 'TEST',
        locale: 'en-US',
        name: 'Test template',
        subject: 'Test subject',
        body: 'Test body',
        revision: 1,
        isDefault: true
      }
    ] as T;
  }
  if (path === '/api/mail/templates/preview') {
    return { subject: 'Test subject', text: longText, html: `<p>${longText}</p>` } as T;
  }
  throw new Error(`Unexpected fixture request: ${path}`);
}

const sidebarProps = {
  sessions: [],
  selectedSessionId: undefined,
  mobileViewport: false,
  canLoadMore: false,
  loadingMore: false,
  watchStatus: 'ready' as const,
  nodeReady: true,
  loading: false,
  workspaceKind: undefined,
  workspaceKindLabel: 'Workspace',
  workspaceBranch: undefined,
  title: () => '',
  runnerIcon: () => '',
  activity: () => '',
  activityLabel: () => '',
  activityDateTime: () => undefined,
  activityTitle: () => undefined,
  relativeActivity: () => '',
  nodeId: 'node',
  workspaceId: 'workspace',
  skillSupported: true,
  mcpSupported: true,
  cleanupSessionsSupported: false,
  searchSupported: false,
  searchQuery: '',
  searching: false,
  refreshing: false,
  workspaceManageable: true,
  request,
  hasUnread: () => false
};

function showMessageBox(): void {
  void MarMessageBox.confirm(
    h(
      'div',
      entries.map((entry) => h('p', entry.description))
    ),
    'Long confirmation',
    { confirmButtonText: 'Confirm', cancelButtonText: 'Cancel' }
  ).catch(() => undefined);
}
</script>

<template>
  <WorkspaceSessionList v-if="kind === 'workspace'" v-bind="sidebarProps" />
  <ThemeTokenHelp v-else-if="kind === 'tokens'" :colors="{}" />
  <MailTemplateManagement v-else-if="kind === 'mail'" :request="request" :writable="true" />
  <ResourceManagementPanel
    v-else-if="kind === 'node-registration'"
    :request="request"
    resource-type="NODE"
    writable
  >
    <template #registration-owner>
      <MarFormItem label="Owner">
        <MarSelect model-value="personal" aria-label="Owner">
          <MarOption label="Personal" value="personal" />
        </MarSelect>
      </MarFormItem>
    </template>
  </ResourceManagementPanel>
  <WorkspaceFilesPanel
    v-else-if="kind === 'upload'"
    :service="files"
    :visible="true"
    :mobile-viewport="false"
    @refresh="files.requestRefresh()"
  />
  <button v-else-if="kind === 'message'" @click="showMessageBox">Open content</button>
  <button v-else @click="open = true">Open content</button>
  <button v-if="kind === 'focus-return'" ref="focusDestination">Continue workflow</button>

  <WorkspaceSessionCleanupDialog
    v-if="kind === 'cleanup' && open"
    v-model="open"
    :cleanup="
      async () => ({
        deleted: 3,
        skipped: 2,
        failed: 0,
        deletedByRunner: { codex: 3 },
        timedOut: true,
        remaining: 7
      })
    "
  />

  <SkillDetailsDialog
    v-if="kind === 'details'"
    v-model="open"
    :details="{ name: resourceName, description: longText, tags: ['Test'] }"
  />
  <McpDetailsDialog
    v-if="kind === 'mcp-details'"
    v-model="open"
    :details="{ name: resourceName, description: longText, tags: ['Test'] }"
  />
  <QuickOpenDialog
    v-if="kind === 'quick'"
    :open="open"
    :node-id="undefined"
    :workspace-id="undefined"
    :files-ready="false"
    :symbols-ready="false"
    :nodes="nodes"
    :sessions="[]"
    :session-title="() => ''"
    :open-session="async () => undefined"
    :open-workspace="async () => true"
    :workspace-tabs="
      entries.map((entry) => ({
        id: entry.id,
        nodeId: 'node',
        workspaceId: entry.id,
        label: entry.name,
        lastActiveAt: 0
      }))
    "
    @close="open = false"
  />
  <FilePreviewSurface
    v-if="kind === 'file' && open"
    ref="fileSurface"
    :overlay="true"
    label="File preview"
    @close="dismissFile"
  >
    <div>Preview content</div>
    <MarButton @click="dismissFile">Close file</MarButton>
  </FilePreviewSurface>
  <ImagePreviewDialogs
    v-if="kind === 'image'"
    :attachment-open="false"
    :attachment="undefined"
    v-model:conversation-open="open"
    :conversation="{
      name: 'Image preview',
      url: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221000%22 height=%22700%22/%3E'
    }"
  />
  <template v-if="kind === 'registration'">
    <WorkspaceRegistrationPicker
      v-if="open"
      :open="open"
      :directory="{
        currentPath: '/workspace',
        parentPath: '/',
        browseRoots: ['/'],
        selectable: true,
        truncated: false,
        entries: entries.map((entry) => ({
          path: `/workspace/${entry.id}`,
          name: entry.name,
          selectable: true
        }))
      }"
      :selected-path="registrationPath"
      :pending-directory-name="pendingDirectoryName"
      :loading-directory="false"
      :loading="registrationLoading"
      :node-ready="true"
      :selected-path-valid="registrationPath !== ''"
      @select="registrationPath = $event"
      @select-pending="
        pendingDirectoryName = $event;
        registrationPath = `/workspace/${$event}`;
      "
      @close="
        open = false;
        pendingDirectoryName = '';
        registrationPath = '';
      "
      @register="registerWorkspace"
    />
    <output aria-label="Registered path">{{ registeredPath }}</output>
  </template>
  <MarDialog
    v-if="
      open && ['table', 'form', 'short', 'fullscreen', 'centered', 'focus-return'].includes(kind)
    "
    v-model="open"
    title="Content dialog"
    width="min(640px, calc(100vw - 32px))"
    :fullscreen="kind === 'fullscreen'"
    :align-center="kind === 'centered'"
    append-to-body
    @close-auto-focus="focusDestination?.focus()"
  >
    <MarTable v-if="kind === 'table'" :data="entries">
      <MarTableColumn prop="name" label="Name" />
      <MarTableColumn prop="description" label="Description" />
    </MarTable>
    <MarForm v-else-if="kind === 'form'" label-position="top">
      <MarFormItem v-for="i in 18" :key="i" :label="`Field ${i}`">
        <MarSelect v-if="i === 1" v-model="value" aria-label="First field">
          <MarOption label="Selected option" value="selected" />
        </MarSelect>
        <MarInput v-else v-model="value" :aria-label="`Field ${i}`" />
      </MarFormItem>
    </MarForm>
    <p v-else>Short dialog content</p>
    <template #footer><MarButton @click="open = false">Done</MarButton></template>
  </MarDialog>
</template>
