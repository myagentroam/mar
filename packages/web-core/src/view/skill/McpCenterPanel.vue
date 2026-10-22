<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import { Delete, Download, RefreshRight, SwitchButton } from '@element-plus/icons-vue';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { createMcpCenterService, type McpCatalogCard } from '../../service/McpCenterService.js';

import McpDetailsDialog, { type McpDetails } from './McpDetailsDialog.vue';
import { currentLocale, translate } from '../../service/LocalePreferenceService.js';
import { errorCode } from '../../util/api-error.js';
import { errorMessage as displayErrorMessage } from '../../util/workbench-presentation.js';
import ManagementPagination from '../settings/ManagementPagination.vue';

const props = defineProps<{
  readonly scopeLabel?: (scope: string) => string;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  nodes: readonly {
    readonly id: string;
    readonly displayName: string | null;
    readonly registeredAddress: string;
    readonly connected: boolean;
    readonly disabled: boolean;
    readonly nodeAppVersion: string;
  }[];
}>();
const service = createMcpCenterService(props.request);
const targetKind = ref<'NODE' | 'WORKSPACE'>('NODE');
const targetNodeId = ref('');
const targetWorkspaceId = ref('');
const query = service.catalogPage.keyword;
const selectedCategory = service.catalogPage.category;
const activeConfigTab = ref<'available' | 'installed'>('available');
const pagination = service.catalogPage;
const operationError = ref('');
const installingEntryId = ref('');
const showInstallProgress = ref(false);
const detailsOpen = ref(false);
const details = ref<McpDetails>();
const resources = ref<{
  nodes: readonly {
    id: string;
    displayName: string | null;
    connected: boolean;
    disabled: boolean;
  }[];
  workspaces: readonly { nodeId: string; workspaceId: string; displayName: string }[];
}>({ nodes: [], workspaces: [] });
const targetNodes = computed(() =>
  props.nodes.filter((node) => resources.value.nodes.some((resource) => resource.id === node.id))
);
const workspaces = computed(() =>
  resources.value.workspaces.filter((workspace) => workspace.nodeId === targetNodeId.value)
);
const targetNode = computed(() => targetNodes.value.find((node) => node.id === targetNodeId.value));
const availableTags = service.catalogPage.tags;
const targetIssue = computed(() => {
  if (targetNodes.value.length === 0)
    return translate('generated.mcpCenterPanel.thisAccountHasNoManageableNodes');
  if (targetNodeId.value === '') return translate('generated.mcpCenterPanel.selectANode');
  if (targetNode.value === undefined)
    return translate('generated.mcpCenterPanel.theSelectedNodeIsUnavailableSelectAnother');
  if (targetNode.value.disabled)
    return translate('generated.mcpCenterPanel.theSelectedNodeIsDisabledAndCannot');
  if (!targetNode.value.connected)
    return translate('generated.mcpCenterPanel.theSelectedNodeIsOfflineMCPCan');
  if (targetKind.value === 'WORKSPACE' && workspaces.value.length === 0)
    return translate('generated.mcpCenterPanel.theSelectedNodeHasNoManageableWorkspaces');
  if (targetKind.value === 'WORKSPACE' && targetWorkspaceId.value === '')
    return translate('generated.mcpCenterPanel.selectAWorkspace');
  return '';
});
const targetReady = computed(() => targetIssue.value === '');
const installedNames = computed(
  () => new Set(service.inspection.value?.installations.map((item) => item.serverName) ?? [])
);
const installedByName = computed(
  () =>
    new Map(service.inspection.value?.installations.map((item) => [item.serverName, item]) ?? [])
);
const entries = computed(() => {
  const catalogEntries = (
    activeConfigTab.value === 'installed' ? service.installedCatalog.value : service.catalog.value
  ).map((entry) => ({
    ...entry,
    catalogAvailable: true
  }));
  const catalogNames = new Set(catalogEntries.map((entry) => entry.serverName));
  const installedOnly = (service.inspection.value?.installations ?? [])
    .filter((installation) => !catalogNames.has(installation.serverName))
    .map((installation) => ({
      id: installation.catalogEntryId,
      sourceId: '',
      scope: 'PERSONAL' as const,
      serverName: installation.serverName,
      displayName: installation.displayName,
      description: translate('generated.mcpCenterPanel.thisMCPServerWasRemovedFromThe'),
      version: installation.version,
      featured: false,
      tags: [] as readonly string[],
      runtime: { transport: 'STDIO' as const },
      catalogAvailable: false
    }));
  // Installed tabs are full Node snapshots; orphan records never enter directory pages.
  return activeConfigTab.value === 'installed'
    ? [...catalogEntries, ...installedOnly].filter((entry) =>
        installedNames.value.has(entry.serverName)
      )
    : catalogEntries;
});
const visibleEntries = entries;
const displayedEntries = visibleEntries;

function scopeLabel(scope: string): string {
  return props.scopeLabel?.(scope) ?? translate('generated.mcpCenterPanel.personal');
}

function statusLabel(status: string | undefined): string | undefined {
  if (status === 'CURRENT') return translate('generated.mcpCenterPanel.upToDate');
  if (status === 'UPDATE_AVAILABLE') return translate('generated.mcpCenterPanel.updateAvailable');
  if (status === 'INVALID') return translate('generated.mcpCenterPanel.invalidConfiguration');
  if (status === 'UNAVAILABLE')
    return translate('generated.mcpCenterPanel.catalogEntryUnavailable');
  return undefined;
}

function hasTargetUpdate(entry: (typeof entries.value)[number]): boolean {
  const installed = installedByName.value.get(entry.serverName);
  return installed !== undefined && installed.version !== entry.version;
}

function showDetails(entry: (typeof entries.value)[number]): void {
  const installation = installedByName.value.get(entry.serverName);
  const status = hasTargetUpdate(entry)
    ? translate('generated.mcpCenterPanel.updateAvailable2')
    : statusLabel(installation?.status);
  details.value = {
    name: entry.displayName,
    serverName: entry.serverName,
    description: entry.description,
    scope: scopeLabel(entry.scope),
    version: installation?.version ?? entry.version,
    transport: entry.runtime.transport,
    ...(status ? { status } : {}),
    featured: entry.featured,
    tags: entry.tags
  };
  detailsOpen.value = true;
}

onMounted(() => {
  pagination.start();
  void initialize();
});
onUnmounted(() => pagination.dispose());
watch([targetKind, targetNodeId, targetWorkspaceId], () => {
  operationError.value = '';
  void inspect();
});
watch(targetNodes, (nodes) => {
  if (!nodes.some((node) => node.id === targetNodeId.value))
    targetNodeId.value = nodes[0]?.id ?? '';
});
watch(workspaces, (items) => {
  if (!items.some((item) => item.workspaceId === targetWorkspaceId.value))
    targetWorkspaceId.value = items[0]?.workspaceId ?? '';
});
watch(service.catalogPage.error, (error) => {
  if (error !== undefined) operationError.value = mcpErrorMessage(error);
});
watch(activeConfigTab, (tab) => {
  if (tab === 'available') void execute(service.loadCatalog);
});

async function initialize(): Promise<void> {
  await execute(async () => {
    await service.loadCatalog();
    resources.value = await props.request<typeof resources.value>('/api/resources');
    targetNodeId.value =
      targetNodes.value.find((node) => node.connected && !node.disabled)?.id ??
      targetNodes.value[0]?.id ??
      '';
  });
}

async function inspect(): Promise<void> {
  if (!targetReady.value) {
    service.clearTarget();
    return;
  }
  await execute(() =>
    service.inspect(targetKind.value, targetNodeId.value, targetWorkspaceId.value)
  );
}

async function install(entryId: string, enabled = true): Promise<void> {
  installingEntryId.value = entryId;
  showInstallProgress.value = false;
  const progressTimer = setTimeout(() => {
    if (installingEntryId.value === entryId) showInstallProgress.value = true;
  }, 800);
  try {
    await execute(
      () =>
        service.install(
          targetKind.value,
          targetNodeId.value,
          targetWorkspaceId.value,
          entryId,
          enabled
        ),
      enabled
        ? translate('generated.mcpCenterPanel.mCPInstallationWasValidatedOnTheNode')
        : translate('generated.mcpCenterPanel.mCPServerDisabled')
    );
  } finally {
    clearTimeout(progressTimer);
    installingEntryId.value = '';
    showInstallProgress.value = false;
  }
}

async function remove(serverName: string): Promise<void> {
  try {
    await ElMessageBox.confirm(
      translate('generated.mcpCenterPanel.removeFromTheCurrentTarget', { value0: serverName }),
      translate('generated.mcpCenterPanel.removeMCPServer'),
      {
        type: 'warning',
        confirmButtonText: translate('generated.mcpCenterPanel.remove'),
        cancelButtonText: translate('generated.mcpCenterPanel.cancel')
      }
    );
  } catch {
    return;
  }
  await execute(
    () => service.remove(targetKind.value, targetNodeId.value, targetWorkspaceId.value, serverName),
    translate('generated.mcpCenterPanel.mCPServerRemoved')
  );
}

async function execute(operation: () => Promise<void>, success?: string): Promise<void> {
  operationError.value = '';
  try {
    await service.run(operation);
    if (success) ElMessage.success(success);
  } catch (error) {
    operationError.value = mcpErrorMessage(error);
  }
}

function mcpErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code === 'NODE_OFFLINE')
    return translate('generated.mcpCenterPanel.theNodeIsOfflineTryAgainAfter');
  if (code === 'CAPABILITY_VERSION_UNSUPPORTED')
    return translate('generated.mcpCenterPanel.thisNodeVersionDoesNotSupportMCP');
  if (code === 'CAPABILITY_UNAVAILABLE')
    return translate('generated.mcpCenterPanel.mCPManagementIsNotEnabledOnThis');
  if (code === 'WORKSPACE_NOT_FOUND')
    return translate('generated.mcpCenterPanel.theWorkspaceNoLongerExistsSelectAnother');
  if (code === 'MCP_INSTALL_TIMEOUT')
    return translate('generated.mcpCenterPanel.mCPInstallationValidationTimedOutCheckNode');
  if (code === 'MCP_SECRET_MISSING')
    return translate('generated.mcpCenterPanel.aSecretReferencedByMCPIsMissing');
  if (code === 'MCP_AUTH_FAILED')
    return translate('generated.mcpCenterPanel.mCPAuthenticationFailedCheckTheReferencedSecrets');
  if (code === 'MCP_COMMAND_UNAVAILABLE')
    return translate('generated.mcpCenterPanel.theNodeCouldNotStartTheMCP');
  if (code === 'MCP_CONNECTION_FAILED')
    return translate('generated.mcpCenterPanel.theNodeCouldNotConnectToThe');
  if (code === 'MCP_PROTOCOL_VALIDATION_FAILED')
    return translate('generated.mcpCenterPanel.mCPProtocolValidationFailedAfterStartupCheck');
  if (code === 'MCP_TOOLS_UNAVAILABLE')
    return translate('generated.mcpCenterPanel.mCPConnectedButExposedNoToolsCheck');
  if (code === 'NODE_ACCESS_DENIED' || code === 'WORKSPACE_FORBIDDEN')
    return translate('generated.mcpCenterPanel.youDoNotHavePermissionToManage');
  return displayErrorMessage(error);
}
</script>

<template>
  <section v-loading="service.loading.value" class="mcp-panel">
    <section
      class="mcp-target-panel"
      :aria-label="translate('generated.mcpCenterPanel.mCPConfigurationTarget')"
    >
      <div>
        <strong>{{ translate('generated.mcpCenterPanel.configurationTarget') }}</strong
        ><span>{{ translate('generated.mcpCenterPanel.selectWhereTheMCPServerWillBe') }}</span>
      </div>
      <el-segmented
        v-model="targetKind"
        :options="[
          { label: translate('generated.mcpCenterPanel.node'), value: 'NODE' },
          { label: translate('generated.mcpCenterPanel.workspace'), value: 'WORKSPACE' }
        ]"
      />
      <el-select
        v-model="targetNodeId"
        :placeholder="translate('generated.mcpCenterPanel.selectANode2')"
      >
        <el-option
          v-for="node in targetNodes"
          :key="node.id"
          :label="node.displayName || node.registeredAddress"
          :value="node.id"
          :disabled="node.disabled || !node.connected"
        >
          <span>{{ node.displayName || node.registeredAddress }}</span>
          <span class="target-option-state">{{
            node.disabled
              ? translate('generated.mcpCenterPanel.disabled')
              : node.connected
                ? translate('generated.mcpCenterPanel.online')
                : translate('generated.mcpCenterPanel.offline')
          }}</span>
        </el-option>
      </el-select>
      <el-select
        v-if="targetKind === 'WORKSPACE'"
        v-model="targetWorkspaceId"
        :placeholder="translate('generated.mcpCenterPanel.selectAWorkspace2')"
      >
        <el-option
          v-for="workspace in workspaces"
          :key="workspace.workspaceId"
          :label="workspace.displayName"
          :value="workspace.workspaceId"
        />
      </el-select>
    </section>
    <el-alert v-if="targetIssue" :title="targetIssue" type="info" :closable="false" />
    <el-alert v-if="operationError" :title="operationError" type="error" :closable="false" />
    <el-tabs v-model="activeConfigTab" class="mcp-config-tabs">
      <el-tab-pane
        :label="translate('generated.mcpCenterPanel.availableMCPServers')"
        name="available"
      />
      <el-tab-pane
        :label="translate('generated.mcpCenterPanel.installedMCPServers')"
        name="installed"
      />
    </el-tabs>
    <div class="mcp-filter-bar">
      <el-input
        v-model="query"
        clearable
        :placeholder="translate('generated.mcpCenterPanel.searchMCPServers')"
      />
      <div
        class="mcp-category-strip"
        :aria-label="translate('generated.mcpCenterPanel.mCPCategories')"
      >
        <button :class="{ selected: selectedCategory === '' }" @click="selectedCategory = ''">
          {{ translate('generated.mcpCenterPanel.all') }}
        </button>
        <button
          v-for="tag in availableTags"
          :key="tag"
          :class="{ selected: selectedCategory === tag }"
          @click="selectedCategory = tag"
        >
          {{ tag }}
        </button>
      </div>
    </div>
    <div class="mcp-table-section">
      <el-table
        v-if="visibleEntries.length > 0"
        class="clickable-rows mcp-config-table"
        :data="displayedEntries"
        row-key="id"
        @row-click="showDetails"
        @sort-change="pagination.sort"
      >
        <el-table-column
          prop="displayName"
          :label="translate('generated.mcpSourceManagementPage.name')"
          min-width="180"
          :sortable="activeConfigTab === 'available' ? 'custom' : true"
        />
        <el-table-column
          prop="serverName"
          :label="translate('generated.mcpDetailsDialog.serverName')"
          min-width="180"
          show-overflow-tooltip
        />
        <el-table-column :label="translate('generated.mcpSourceManagementPage.scope')" width="100">
          <template #default="{ row }">{{ scopeLabel(row.scope) }}</template>
        </el-table-column>
        <el-table-column
          prop="description"
          :label="translate('conversationTemplates.description')"
          min-width="260"
          show-overflow-tooltip
        >
          <template #default="{ row }">{{
            row.description ||
            translate('generated.mcpCenterPanel.noDescriptionIsAvailableForThisMCP')
          }}</template>
        </el-table-column>
        <el-table-column :label="translate('generated.mcpDetailsDialog.version')" width="120">
          <template #default="{ row }">{{
            installedByName.get(row.serverName)?.version ?? row.version
          }}</template>
        </el-table-column>
        <el-table-column
          v-if="activeConfigTab === 'installed'"
          :label="translate('generated.mcpDetailsDialog.status')"
          min-width="150"
        >
          <template #default="{ row }">
            <el-tag
              v-if="
                installedByName.get(row.serverName)?.origin === 'NODE' && targetKind === 'WORKSPACE'
              "
              type="info"
              effect="plain"
              >{{ translate('generated.mcpCenterPanel.inheritedFromNode') }}</el-tag
            >
            <span v-else>{{
              hasTargetUpdate(row)
                ? translate('generated.mcpCenterPanel.updateAvailable3')
                : statusLabel(installedByName.get(row.serverName)?.status)
            }}</span>
          </template>
        </el-table-column>
        <el-table-column :label="translate('generated.mcpDetailsDialog.tags')" min-width="150">
          <template #default="{ row }">
            <div v-if="row.featured || row.tags.length > 0" class="mcp-tags">
              <el-tag v-if="row.featured" type="warning" effect="plain"
                >★ {{ translate('generated.mcpCenterPanel.featured') }}</el-tag
              >
              <el-tag v-for="tag in row.tags" :key="tag" effect="plain">{{ tag }}</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column
          :label="translate('generated.mcpSourceManagementPage.actions')"
          min-width="300"
        >
          <template #default="{ row }">
            <div class="row-actions" @click.stop>
              <template v-if="activeConfigTab === 'installed'">
                <el-button
                  link
                  :icon="SwitchButton"
                  :disabled="!targetReady || !row.catalogAvailable"
                  @click="install(row.id, !installedByName.get(row.serverName)?.enabled)"
                  >{{
                    installedByName.get(row.serverName)?.enabled
                      ? translate('generated.mcpCenterPanel.disable')
                      : translate('generated.mcpCenterPanel.enable')
                  }}</el-button
                >
                <el-button
                  v-if="row.catalogAvailable"
                  link
                  type="primary"
                  :icon="RefreshRight"
                  :disabled="!targetReady"
                  @click="install(row.id)"
                  >{{
                    hasTargetUpdate(row)
                      ? translate('generated.mcpCenterPanel.update')
                      : translate('generated.mcpCenterPanel.reinstall')
                  }}</el-button
                >
                <el-button
                  v-if="installedByName.get(row.serverName)?.origin === targetKind"
                  link
                  type="danger"
                  :icon="Delete"
                  :disabled="!targetReady"
                  @click="remove(row.serverName)"
                  >{{ translate('generated.mcpCenterPanel.delete') }}</el-button
                >
              </template>
              <template v-else>
                <el-button
                  link
                  type="primary"
                  :icon="Download"
                  :disabled="!targetReady"
                  @click="install(row.id)"
                  >{{
                    installedNames.has(row.serverName)
                      ? hasTargetUpdate(row)
                        ? translate('generated.mcpCenterPanel.update2')
                        : translate('generated.mcpCenterPanel.reinstall2')
                      : translate('generated.mcpCenterPanel.install')
                  }}</el-button
                >
              </template>
              <div
                v-if="installingEntryId === row.id && showInstallProgress"
                class="mcp-install-progress"
              >
                <span>{{
                  translate('generated.mcpCenterPanel.downloadingAndValidatingMCPOnTheNode')
                }}</span>
                <el-progress :percentage="50" indeterminate :show-text="false" />
              </div>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <el-empty
        v-else
        :description="
          activeConfigTab === 'installed'
            ? translate('generated.mcpCenterPanel.thisTargetHasNoInstalledMCPServers')
            : translate('generated.mcpCenterPanel.noMCPServersAreAvailableAddOne')
        "
      />
      <ManagementPagination
        v-if="activeConfigTab === 'available'"
        :total="pagination.total.value"
        :has-more="pagination.hasMore.value"
        :page="pagination.page.value"
        :mobile="pagination.mobileViewport.value"
        :mobile-visible-count="pagination.mobileVisibleCount.value"
        :loading="pagination.loading.value"
        @page="pagination.setPage"
        @load-more="pagination.loadMore"
      />
    </div>
    <McpDetailsDialog v-model="detailsOpen" :details="details" />
  </section>
</template>

<style scoped>
.mcp-panel {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  overflow: auto;
  padding-right: 4px;
}
.mcp-filter-bar {
  display: grid;
  gap: 10px;
}
.mcp-filter-bar > :deep(.el-input) {
  width: min(620px, 100%);
}
.mcp-category-strip {
  display: flex;
  overflow-x: auto;
  gap: 6px;
  padding: 1px 0 3px;
  scrollbar-width: thin;
}
.mcp-category-strip button {
  flex: none;
  border: 1px solid var(--mar-border-medium);
  border-radius: 999px;
  background: var(--mar-bg-panel);
  color: var(--mar-text-tertiary);
  padding: 5px 12px;
  font: inherit;
  font-size: var(--mar-font-size-body);
  cursor: pointer;
}
.mcp-category-strip button:hover {
  border-color: var(--mar-text-faint);
  color: var(--mar-color-brand-text);
}
.mcp-category-strip button.selected {
  border-color: var(--mar-color-brand);
  background: var(--el-color-primary-light-9);
  color: var(--mar-color-brand-text);
  font-weight: 600;
}
.mcp-category-strip button:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 1px;
}
.mcp-config-tabs {
  min-height: 40px;
}
.mcp-target-panel {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--mar-fill-hover);
  padding-bottom: 12px;
}
.mcp-target-panel > div:first-child {
  display: flex;
  flex: 1 1 220px;
  flex-direction: column;
  gap: 2px;
}
.mcp-target-panel strong {
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-body);
}
.mcp-target-panel span {
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
}
.mcp-target-panel .el-select {
  width: min(240px, 100%);
}
.target-option-state {
  float: right;
  margin-left: 16px;
  color: var(--el-text-color-secondary);
  font-size: var(--mar-font-size-meta);
}
.mcp-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.mcp-table-section {
  min-width: 0;
  min-height: 180px;
}
.clickable-rows :deep(.el-table__row) {
  cursor: pointer;
}
.row-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}
.mcp-install-progress {
  display: grid;
  gap: 6px;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
}
@media (max-width: 720px) {
  .mcp-target-panel .el-select {
    width: 100%;
  }
  .mcp-target-panel :deep(.el-button) {
    min-height: 36px;
  }
}
</style>
