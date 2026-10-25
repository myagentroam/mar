<script setup lang="ts">
import { h, ref } from 'vue';
import type { NodeSummary } from '../../src/model/node.js';
import WorkspaceSessionList from '../../src/view/workspace/WorkspaceSessionList.vue';
import SkillDetailsDialog from '../../src/view/skill/SkillDetailsDialog.vue';
import McpDetailsDialog from '../../src/view/skill/McpDetailsDialog.vue';
import ThemeTokenHelp from '../../src/view/settings/ThemeTokenHelp.vue';
import MailTemplateManagement from '../../src/view/settings/MailTemplateManagement.vue';
import FilePreviewSurface from '../../src/view/workspace/FilePreviewSurface.vue';
import ImagePreviewDialogs from '../../src/view/conversation/ImagePreviewDialogs.vue';
import QuickOpenDialog from '../../src/view/workspace/QuickOpenDialog.vue';
import WorkspaceRegistrationPicker from '../../src/view/workspace/WorkspaceRegistrationPicker.vue';
import WorkspaceInspector from '../../src/view/workspace/WorkspaceInspector.vue';
import { ElMessageBox } from '../../src/service/message-box-service.js';

const kind = new URLSearchParams(location.search).get('kind') ?? 'workspace';
const open = ref(false);
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
  localStatus: 'VALID',
  source: 'WORKSPACE',
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
  void ElMessageBox.confirm(
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
  <WorkspaceInspector
    v-else-if="kind === 'upload'"
    node-id="node"
    workspace-id="workspace"
    workspace-name="Workspace"
    workspace-kind="DIRECTORY"
    csrf-token="fixture"
    :renew-csrf-token="async () => 'fixture'"
    :enabled="true"
    :mobile-viewport="false"
    :content-search-enabled="false"
    :code-navigation-enabled="false"
    :code-navigation-prewarm-enabled="false"
    files-watch-status="idle"
    changes-watch-status="idle"
    :history-capability="false"
    :file-write-enabled="true"
  />
  <button v-else-if="kind === 'message'" @click="showMessageBox">Open content</button>
  <button v-else @click="open = true">Open content</button>

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
    :overlay="true"
    label="File preview"
    @close="open = false"
  >
    <div>Preview content</div>
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
  <el-dialog
    v-if="
      open && ['table', 'form', 'short', 'fullscreen', 'centered', 'registration'].includes(kind)
    "
    v-model="open"
    title="Content dialog"
    width="min(640px, calc(100vw - 32px))"
    :fullscreen="kind === 'fullscreen'"
    :align-center="kind === 'centered'"
    append-to-body
  >
    <WorkspaceRegistrationPicker
      v-if="kind === 'registration'"
      :model-value="['register']"
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
      selected-path="/workspace"
      pending-directory-name=""
      :loading-directory="false"
      :loading="false"
      :node-ready="true"
      :selected-path-valid="true"
    />
    <el-table v-else-if="kind === 'table'" :data="entries">
      <el-table-column prop="name" label="Name" />
      <el-table-column prop="description" label="Description" />
    </el-table>
    <el-form v-else-if="kind === 'form'" label-position="top">
      <el-form-item v-for="i in 18" :key="i" :label="`Field ${i}`">
        <el-select v-if="i === 1" v-model="value" aria-label="First field">
          <el-option label="Selected option" value="selected" />
        </el-select>
        <el-input v-else v-model="value" :aria-label="`Field ${i}`" />
      </el-form-item>
    </el-form>
    <p v-else>Short dialog content</p>
    <template #footer><el-button @click="open = false">Done</el-button></template>
  </el-dialog>
</template>
