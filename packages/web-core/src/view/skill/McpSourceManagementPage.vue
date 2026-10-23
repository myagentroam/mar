<script setup lang="ts">
import { marIcon } from '../../util/mar-icons.js';
import { managementDateTime } from '../../util/time-presentation.js';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import McpDetailsDialog, { type McpDetails } from './McpDetailsDialog.vue';
import { translate } from '../../service/LocalePreferenceService';
import { errorCode } from '../../util/api-error';
import { errorMessage as displayErrorMessage } from '../../util/workbench-presentation';
import { createCatalogPageService, readCatalogReferences } from '../../service/CatalogPageService';
import ManagementPagination from '../settings/ManagementPagination.vue';

interface Source {
  readonly id: string;
  readonly name: string;
  readonly locator: string;
  readonly scope: string;
  readonly enabled: boolean;
  readonly builtIn: boolean;
  readonly status: 'READY' | 'DEGRADED' | 'DISABLED';
  readonly manageable: boolean;
}
interface Candidate {
  readonly id: string;
  readonly serverName: string;
  readonly displayName: string;
  readonly description: string;
  readonly version: string;
  readonly runtime: { readonly transport: 'STDIO' | 'HTTP' };
}
interface CatalogEntry extends Candidate {
  readonly sourceId: string;
  readonly scope: string;
  readonly featured: boolean;
  readonly tags: readonly string[];
  readonly manageable: boolean;
  readonly updatedAt: number;
}
const displaySourceName = (source: Source) =>
  source.builtIn ? translate('common.officialMcpRegistry') : source.name;

const props = defineProps<{
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  writable: boolean;
  scopeLabel?: (scope: string) => string;
  loadExtension?: () => Promise<void>;
  sourceContext?: Readonly<Record<string, unknown>>;
  catalogContext?: Readonly<Record<string, unknown>>;
  ownershipRules?: FormRules;
  submitSource?: (input: { readonly name: string; readonly locator: string }) => Promise<unknown>;
  submitCatalog?: (input: {
    readonly sourceId: string;
    readonly candidate: Candidate | undefined;
    readonly featured: boolean;
    readonly tags: readonly string[];
  }) => Promise<unknown>;
}>();
const emit = defineEmits<{ openSource: []; openCatalog: [] }>();
const sources = ref<readonly Source[]>([]);
// Source definitions form a full configuration snapshot, not a directory page.
const displayedSources = sources;
const pagination = createCatalogPageService<CatalogEntry>(
  props.request,
  '/api/mcp-catalog',
  'entries'
);
const candidates = ref<readonly Candidate[]>([]);
const catalog = pagination.items;
const candidateCatalog = ref<readonly CatalogEntry[]>([]);
const catalogServerNames = computed(
  () => new Set(candidateCatalog.value.map((entry) => entry.serverName))
);
const catalogTags = pagination.tags;
const sourceId = ref('');
const query = ref('');
const activeMcpTab = ref<'source' | 'catalog'>('source');
const loading = ref(false);
const sourcesReady = ref(false);
const sourceDialog = ref(false);
const catalogDialog = ref(false);
const editDialog = ref(false);
const detailsOpen = ref(false);
const sourceForm = ref<FormInstance>();
const catalogForm = ref<FormInstance>();
const editForm = ref<FormInstance>();
const candidate = ref<Candidate>();
const pendingCatalog = ref<CatalogEntry>();
const details = ref<McpDetails>();
const updateChecks = ref<Record<string, { updateAvailable: boolean; latestVersion: string }>>({});
const checkingEntryIds = ref<ReadonlySet<string>>(new Set());
const upgradingEntryId = ref<string>();
const sourceDraft = reactive({
  name: '',
  locator: ''
});
const catalogDraft = reactive({
  featured: false,
  tags: [] as string[]
});
const editDraft = reactive({ featured: false, tags: [] as string[] });
const sourceRules = computed<FormRules>(() => ({
  name: [
    {
      required: true,
      message: translate('generated.mcpSourceManagementPage.enterASourceName'),
      trigger: 'blur'
    }
  ],
  locator: [
    {
      required: true,
      message: translate('generated.mcpSourceManagementPage.enterARegistryURL'),
      trigger: 'blur'
    },
    {
      pattern: /^https:\/\/[^\s]+$/u,
      message: translate('generated.mcpSourceManagementPage.enterAnHTTPSURL'),
      trigger: 'blur'
    }
  ]
}));
const catalogRules = computed<FormRules>(() => ({
  tags: [
    {
      validator: (_rule, value, callback) => {
        const tags = Array.isArray(value) ? value.map((item) => String(item).trim()) : [];
        if (tags.length > 10)
          callback(new Error(translate('generated.mcpSourceManagementPage.addNoMoreThan10Tags')));
        else if (tags.some((tag) => tag.length === 0 || tag.length > 32))
          callback(
            new Error(
              translate('generated.mcpSourceManagementPage.eachTagMustContain132Characters')
            )
          );
        else if (new Set(tags.map((tag) => tag.toLocaleLowerCase())).size !== tags.length)
          callback(
            new Error(translate('generated.mcpSourceManagementPage.duplicateTagsAreNotAllowed'))
          );
        else callback();
      },
      trigger: 'change'
    }
  ]
}));
onMounted(() => {
  pagination.start();
  void initialize();
});
onUnmounted(() => pagination.dispose());

async function initialize(): Promise<void> {
  await run(async () => {
    await loadSources();
    await loadCatalog();
    await props.loadExtension?.();
  });
}
async function loadCatalog(): Promise<void> {
  await pagination.refresh();
  if (candidates.value.length)
    candidateCatalog.value = await readCatalogReferences<CatalogEntry>(
      props.request,
      '/api/mcp-catalog',
      'entries',
      [],
      candidates.value.map((entry) => entry.serverName)
    );
}
async function loadSources(): Promise<void> {
  sources.value = (await props.request<{ sources: Source[] }>('/api/mcp-sources')).sources;
  sourcesReady.value = true;
  if (!sources.value.some((source) => source.id === sourceId.value && source.enabled))
    sourceId.value = sources.value.find((source) => source.enabled)?.id ?? '';
}
async function discover(): Promise<void> {
  if (!sourceId.value) return;
  await run(async () => {
    candidates.value = (
      await props.request<{ servers: Candidate[] }>(
        `/api/mcp-sources/${encodeURIComponent(sourceId.value)}/servers?${new URLSearchParams({ query: query.value })}`
      )
    ).servers;
    candidateCatalog.value = await readCatalogReferences<CatalogEntry>(
      props.request,
      '/api/mcp-catalog',
      'entries',
      [],
      candidates.value.map((entry) => entry.serverName)
    );
  });
}
function openSourceDialog(): void {
  Object.assign(sourceDraft, {
    name: '',
    locator: ''
  });
  emit('openSource');
  sourceDialog.value = true;
}
async function createSource(): Promise<void> {
  if ((await sourceForm.value?.validate().catch(() => false)) !== true) return;
  await run(async () => {
    const input = { name: sourceDraft.name, locator: sourceDraft.locator };
    if (props.submitSource !== undefined) await props.submitSource(input);
    else
      await props.request('/api/mcp-sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, scope: 'PERSONAL' })
      });
    sourceDialog.value = false;
    await loadSources();
  }, translate('generated.mcpSourceManagementPage.mCPSourceAdded'));
}
async function setEnabled(source: Source, enabled: boolean): Promise<void> {
  await run(async () => {
    await props.request(`/api/mcp-sources/${encodeURIComponent(source.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    await loadSources();
  });
}
async function confirmSourceStatusChange(source: Source): Promise<void> {
  try {
    await ElMessageBox.confirm(
      source.enabled
        ? translate('generated.mcpSourceManagementPage.confirmDisableMCPSource', {
            value0: displaySourceName(source)
          })
        : translate('generated.mcpSourceManagementPage.confirmEnableMCPSource', {
            value0: displaySourceName(source)
          }),
      translate('generated.mcpSourceManagementPage.updateMCPSourceStatus'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: source.enabled
          ? translate('generated.mcpSourceManagementPage.disable')
          : translate('generated.mcpSourceManagementPage.enable'),
        cancelButtonText: translate('generated.mcpSourceManagementPage.cancel')
      }
    );
  } catch {
    return;
  }
  await setEnabled(source, !source.enabled);
}
async function removeSource(source: Source): Promise<void> {
  try {
    await ElMessageBox.confirm(
      translate('generated.mcpSourceManagementPage.deleteMCPSource', { value0: source.name }),
      translate('generated.mcpSourceManagementPage.deleteMCPSource2'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('generated.mcpSourceManagementPage.delete'),
        cancelButtonText: translate('generated.mcpSourceManagementPage.cancel')
      }
    );
  } catch {
    return;
  }
  await run(async () => {
    await props.request(`/api/mcp-sources/${encodeURIComponent(source.id)}`, { method: 'DELETE' });
    await loadSources();
  }, translate('generated.mcpSourceManagementPage.mCPSourceDeleted'));
}
function openCatalog(item: Candidate): void {
  candidate.value = item;
  Object.assign(catalogDraft, {
    featured: false,
    tags: []
  });
  emit('openCatalog');
  catalogDialog.value = true;
}
async function addCatalog(): Promise<void> {
  if (!candidate.value) return;
  if ((await catalogForm.value?.validate().catch(() => false)) !== true) return;
  await run(async () => {
    const input = { sourceId: sourceId.value, candidate: candidate.value, ...catalogDraft };
    if (props.submitCatalog !== undefined) await props.submitCatalog(input);
    else
      await props.request('/api/mcp-catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, scope: 'PERSONAL' })
      });
    catalogDialog.value = false;
    await loadCatalog();
  }, translate('generated.mcpSourceManagementPage.addedToMCPCenter'));
}
function formatUpdatedAt(timestamp: number): string {
  return managementDateTime(timestamp);
}
function sourceNameById(sourceIdValue: string): string | undefined {
  const source = sources.value.find((candidate) => candidate.id === sourceIdValue);
  return source === undefined ? undefined : displaySourceName(source);
}
function showDetails(item: Candidate | CatalogEntry): void {
  const entry = 'scope' in item ? item : undefined;
  const source = sourceNameById(entry?.sourceId ?? sourceId.value);
  details.value = {
    name: item.displayName,
    serverName: item.serverName,
    description: item.description,
    ...(entry ? { scope: scopeLabel(entry.scope) } : {}),
    ...(source ? { source } : {}),
    ...(entry ? { updatedAt: formatUpdatedAt(entry.updatedAt) } : {}),
    version: item.version,
    transport: item.runtime.transport,
    ...(entry ? { featured: entry.featured, tags: entry.tags } : {})
  };
  detailsOpen.value = true;
}
function showSourceDetails(source: Source): void {
  details.value = {
    name: displaySourceName(source),
    description: '',
    source: source.locator,
    scope: scopeLabel(source.scope),
    status: source.enabled
      ? translate('generated.mcpSourceManagementPage.enabled')
      : translate('generated.mcpSourceManagementPage.disabled')
  };
  detailsOpen.value = true;
}
function openEdit(entry: CatalogEntry): void {
  pendingCatalog.value = entry;
  editDraft.featured = entry.featured;
  editDraft.tags = [...entry.tags];
  editDialog.value = true;
}
async function savePresentation(): Promise<void> {
  if ((await editForm.value?.validate().catch(() => false)) !== true || !pendingCatalog.value)
    return;
  await run(async () => {
    await props.request(`/api/mcp-catalog/${encodeURIComponent(pendingCatalog.value!.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        featured: editDraft.featured,
        tags: editDraft.tags.map((tag) => tag.trim())
      })
    });
    editDialog.value = false;
    await loadCatalog();
  }, translate('generated.mcpSourceManagementPage.mCPInformationUpdated'));
}
async function checkUpdate(entry: CatalogEntry): Promise<void> {
  checkingEntryIds.value = new Set([...checkingEntryIds.value, entry.id]);
  try {
    const result = await props.request<{ updateAvailable: boolean; latestVersion: string }>(
      `/api/mcp-catalog/${encodeURIComponent(entry.id)}/check-update`,
      { method: 'POST' }
    );
    updateChecks.value = { ...updateChecks.value, [entry.id]: result };
    ElMessage.success({
      icon: marIcon('success'),
      message: result.updateAvailable
        ? translate('generated.mcpSourceManagementPage.updateAvailable')
        : translate('generated.mcpSourceManagementPage.alreadyUpToDate')
    });
  } catch (error) {
    showOperationError(error);
  } finally {
    const remaining = new Set(checkingEntryIds.value);
    remaining.delete(entry.id);
    checkingEntryIds.value = remaining;
  }
}
async function upgrade(entry: CatalogEntry): Promise<void> {
  upgradingEntryId.value = entry.id;
  try {
    await run(async () => {
      await props.request(`/api/mcp-catalog/${encodeURIComponent(entry.id)}/upgrade`, {
        method: 'POST'
      });
      const remaining = { ...updateChecks.value };
      delete remaining[entry.id];
      updateChecks.value = remaining;
      await loadCatalog();
    }, translate('generated.mcpSourceManagementPage.mCPCatalogVersionUpdated'));
  } finally {
    upgradingEntryId.value = undefined;
  }
}
async function removeCatalog(entry: CatalogEntry): Promise<void> {
  try {
    await ElMessageBox.confirm(
      translate('generated.mcpSourceManagementPage.removeFromMCPCenter', {
        value0: entry.displayName
      }),
      translate('generated.mcpSourceManagementPage.removeCatalogEntry'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('generated.mcpSourceManagementPage.remove'),
        cancelButtonText: translate('generated.mcpSourceManagementPage.cancel2')
      }
    );
  } catch {
    return;
  }
  await run(async () => {
    await props.request(`/api/mcp-catalog/${encodeURIComponent(entry.id)}`, {
      method: 'DELETE'
    });
    await loadCatalog();
  }, translate('generated.mcpSourceManagementPage.removedFromMCPCenter'));
}
async function run(operation: () => Promise<void>, success?: string): Promise<void> {
  loading.value = true;
  try {
    await operation();
    if (success) ElMessage.success({ icon: marIcon('success'), message: success });
  } catch (error) {
    showOperationError(error);
  } finally {
    loading.value = false;
  }
}

function showOperationError(error: unknown): void {
  ElMessage.error({
    icon: marIcon('error'),
    message:
      errorCode(error) === 'MCP_CATALOG_ALREADY_EXISTS'
        ? translate('generated.mcpSourceManagementPage.thisMCPServerIsAlreadyInThe')
        : displayErrorMessage(error)
  });
}

function scopeLabel(scope: string): string {
  return props.scopeLabel?.(scope) ?? translate('generated.mcpSourceManagementPage.personal');
}
</script>

<template>
  <main
    v-loading="loading && !sourcesReady"
    element-loading-custom-class="mar-page-loading"
    class="management-page mcp-source-page"
  >
    <div class="table-actions">
      <el-button
        type="primary"
        :icon="marIcon('plus')"
        :disabled="!writable"
        @click="openSourceDialog"
        >{{ translate('generated.mcpSourceManagementPage.addMCPSource') }}</el-button
      >
    </div>
    <el-table
      class="clickable-rows mcp-source-table"
      :data="displayedSources"
      row-key="id"
      @row-click="showSourceDetails"
    >
      <el-table-column
        prop="name"
        :label="translate('generated.mcpSourceManagementPage.name')"
        min-width="180"
        sortable
        ><template #default="{ row }">{{ displaySourceName(row) }}</template></el-table-column
      >
      <el-table-column
        :label="translate('generated.mcpSourceManagementPage.scope')"
        width="110"
        sortable
        ><template #default="{ row }">{{ scopeLabel(row.scope) }}</template></el-table-column
      >
      <el-table-column
        prop="locator"
        :label="translate('generated.mcpSourceManagementPage.uRL')"
        min-width="300"
        show-overflow-tooltip
      />
      <el-table-column :label="translate('generated.mcpSourceManagementPage.status')" width="110"
        ><template #default="{ row }"
          ><el-tag :type="row.enabled ? 'success' : 'info'" effect="plain">{{
            row.enabled
              ? translate('generated.mcpSourceManagementPage.enabled')
              : translate('generated.mcpSourceManagementPage.disabled')
          }}</el-tag></template
        ></el-table-column
      >
      <el-table-column :label="translate('generated.mcpSourceManagementPage.actions')" :width="180">
        <template #default="{ row }"
          ><div class="row-actions" @click.stop>
            <el-button
              link
              type="primary"
              :icon="marIcon('power')"
              :disabled="!row.manageable || !writable"
              @click="confirmSourceStatusChange(row)"
              >{{
                row.enabled
                  ? translate('generated.mcpSourceManagementPage.disable')
                  : translate('generated.mcpSourceManagementPage.enable')
              }}</el-button
            ><el-button
              link
              type="danger"
              :icon="marIcon('delete')"
              :disabled="row.builtIn || !row.manageable || !writable"
              @click="removeSource(row)"
              >{{ translate('generated.mcpSourceManagementPage.delete2') }}</el-button
            >
          </div></template
        >
      </el-table-column>
    </el-table>

    <el-tabs v-model="activeMcpTab" class="mcp-management-tabs">
      <el-tab-pane
        :label="translate('generated.mcpSourceManagementPage.sourceMCPServers')"
        name="source"
      >
        <div class="source-search-bar">
          <el-select
            v-model="sourceId"
            :placeholder="translate('generated.mcpSourceManagementPage.selectAnEnabledMCPSource')"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
            ><el-option
              v-for="source in sources.filter((item) => item.enabled)"
              :key="source.id"
              :label="displaySourceName(source)"
              :value="source.id"
          /></el-select>
          <div class="toolbar">
            <el-input
              v-model="query"
              clearable
              :placeholder="
                translate('generated.mcpSourceManagementPage.enterAnMCPServerNameOrDescription')
              "
              @keyup.enter="discover"
              :clear-icon="marIcon('clear-input')"
            >
              <template #append
                ><el-button
                  :icon="marIcon('search')"
                  :disabled="!sourceId || loading"
                  @click="discover"
                  >{{ translate('generated.mcpSourceManagementPage.search') }}</el-button
                ></template
              >
            </el-input>
          </div>
        </div>
        <div class="mcp-table-section">
          <el-table
            v-if="candidates.length > 0"
            class="clickable-rows source-mcp-table"
            :data="candidates"
            row-key="id"
            @row-click="showDetails"
          >
            <el-table-column
              prop="displayName"
              :label="translate('generated.mcpSourceManagementPage.name')"
              sortable
              min-width="180"
            />
            <el-table-column
              prop="serverName"
              :label="translate('generated.mcpDetailsDialog.serverName')"
              min-width="180"
              show-overflow-tooltip
            />
            <el-table-column
              prop="description"
              :label="translate('conversationTemplates.description')"
              min-width="260"
              show-overflow-tooltip
            >
              <template #default="{ row }">
                {{
                  row.description ||
                  translate(
                    'generated.mcpSourceManagementPage.noDescriptionWasProvidedByThisSource'
                  )
                }}
              </template>
            </el-table-column>
            <el-table-column
              prop="version"
              :label="translate('generated.mcpDetailsDialog.version')"
              width="120"
            />
            <el-table-column :label="translate('generated.mcpDetailsDialog.transport')" width="120">
              <template #default="{ row }">{{ row.runtime.transport }}</template>
            </el-table-column>
            <el-table-column
              :label="translate('generated.mcpSourceManagementPage.actions')"
              :width="180"
            >
              <template #default="{ row }">
                <div class="row-actions" @click.stop>
                  <el-button
                    link
                    type="primary"
                    :icon="marIcon('plus')"
                    :disabled="!writable || catalogServerNames.has(row.serverName)"
                    @click="openCatalog(row)"
                    >{{
                      catalogServerNames.has(row.serverName)
                        ? translate('generated.mcpSourceManagementPage.added')
                        : translate('generated.mcpSourceManagementPage.addToCatalog')
                    }}</el-button
                  >
                </div>
              </template>
            </el-table-column>
          </el-table>
          <div v-else class="mcp-empty">
            {{
              sourceId
                ? translate('generated.mcpSourceManagementPage.enterAKeywordToSearchThisSource')
                : translate('generated.mcpSourceManagementPage.selectAnEnabledMCPSource2')
            }}
          </div>
        </div>
      </el-tab-pane>
      <el-tab-pane
        :label="translate('generated.mcpSourceManagementPage.catalogMCPServers')"
        name="catalog"
      >
        <div class="mcp-toolbar">
          <el-input
            v-model="pagination.keyword.value"
            clearable
            :placeholder="translate('generated.mcpCenterPanel.searchMCPServers')"
            :clear-icon="marIcon('clear-input')"
          />
          <el-select
            v-model="pagination.category.value"
            clearable
            :placeholder="translate('generated.mcpCenterPanel.mCPCategories')"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
          >
            <el-option v-for="tag in catalogTags" :key="tag" :label="tag" :value="tag" />
          </el-select>
        </div>
        <div
          v-loading="sourcesReady && pagination.loading.value && !pagination.loadingMore.value"
          class="mcp-table-section"
        >
          <el-table
            v-if="catalog.length > 0"
            class="clickable-rows catalog-mcp-table"
            @sort-change="pagination.sort"
            :data="catalog"
            row-key="id"
            @row-click="showDetails"
          >
            <el-table-column
              prop="displayName"
              :label="translate('generated.mcpSourceManagementPage.name')"
              sortable="custom"
              min-width="170"
            />
            <el-table-column
              prop="serverName"
              :label="translate('generated.mcpDetailsDialog.serverName')"
              min-width="180"
              show-overflow-tooltip
            />
            <el-table-column
              :label="translate('generated.mcpSourceManagementPage.scope')"
              width="100"
            >
              <template #default="{ row }">{{ scopeLabel(row.scope) }}</template>
            </el-table-column>
            <el-table-column
              prop="description"
              :label="translate('conversationTemplates.description')"
              min-width="240"
              show-overflow-tooltip
            >
              <template #default="{ row }">
                {{
                  row.description ||
                  translate('generated.mcpSourceManagementPage.noDescriptionIsAvailableForThisMCP')
                }}
              </template>
            </el-table-column>
            <el-table-column
              prop="version"
              :label="translate('generated.mcpDetailsDialog.version')"
              width="120"
            />
            <el-table-column :label="translate('generated.mcpDetailsDialog.tags')" min-width="150">
              <template #default="{ row }">
                <div v-if="row.featured || row.tags.length > 0" class="mcp-tags">
                  <el-tag v-if="row.featured" type="warning" effect="plain"
                    >★ {{ translate('generated.mcpSourceManagementPage.featured') }}</el-tag
                  >
                  <el-tag v-for="tag in row.tags" :key="tag" type="info" effect="plain">{{
                    tag
                  }}</el-tag>
                </div>
              </template>
            </el-table-column>
            <el-table-column
              :label="translate('generated.mcpSourceManagementPage.actions')"
              min-width="360"
            >
              <template #default="{ row }">
                <div class="row-actions" @click.stop>
                  <el-button
                    link
                    type="primary"
                    :icon="marIcon('edit')"
                    :disabled="!writable || !row.manageable || loading"
                    @click="openEdit(row)"
                    >{{ translate('generated.mcpSourceManagementPage.edit') }}</el-button
                  >
                  <el-button
                    v-if="!updateChecks[row.id]?.updateAvailable"
                    link
                    :icon="marIcon('refresh')"
                    :loading="checkingEntryIds.has(row.id)"
                    :disabled="!writable || !row.manageable || loading"
                    @click="checkUpdate(row)"
                    :loading-icon="marIcon('loading-action')"
                    >{{ translate('generated.mcpSourceManagementPage.checkForUpdates') }}</el-button
                  >
                  <el-button
                    v-else
                    link
                    type="primary"
                    :icon="marIcon('retry')"
                    :loading="upgradingEntryId === row.id"
                    :disabled="!writable || !row.manageable || loading"
                    @click="upgrade(row)"
                    :loading-icon="marIcon('loading-action')"
                    >{{ translate('generated.mcpSourceManagementPage.updateTo') }}
                    {{ updateChecks[row.id]!.latestVersion }}</el-button
                  >
                  <el-button
                    link
                    type="danger"
                    :icon="marIcon('delete')"
                    :disabled="!writable || !row.manageable || loading"
                    @click="removeCatalog(row)"
                    >{{ translate('generated.mcpSourceManagementPage.remove2') }}</el-button
                  >
                </div>
              </template>
            </el-table-column>
          </el-table>

          <div v-else class="mcp-empty">
            {{ translate('generated.mcpSourceManagementPage.noCatalogMCPServers') }}
          </div>
          <ManagementPagination
            :total="pagination.total.value"
            :page="pagination.page.value"
            :mobile="pagination.mobileViewport.value"
            :mobile-visible-count="pagination.mobileVisibleCount.value"
            :loading="pagination.loading.value"
            :loading-more="pagination.loadingMore.value"
            :has-more="pagination.hasMore.value"
            @page="pagination.setPage"
            @load-more="pagination.loadMore"
          />
        </div>
      </el-tab-pane>
    </el-tabs>
  </main>
  <el-dialog
    v-if="sourceDialog"
    v-model="sourceDialog"
    :title="translate('generated.mcpSourceManagementPage.addMCPSource2')"
    width="min(520px, calc(100vw - 32px))"
    destroy-on-close
    :close-icon="marIcon('close')"
    ><el-form
      ref="sourceForm"
      :model="{ ...sourceContext, ...sourceDraft }"
      :rules="{ ...ownershipRules, ...sourceRules }"
      label-width="90px"
      ><el-form-item :label="translate('generated.mcpSourceManagementPage.name2')" prop="name"
        ><el-input v-model="sourceDraft.name" /></el-form-item
      ><el-form-item :label="translate('common.registry')" prop="locator"
        ><el-input
          v-model="sourceDraft.locator"
          :placeholder="translate('common.registryUrlExample')" /></el-form-item
      ><slot name="source-ownership">
        <el-form-item :label="translate('generated.mcpSourceManagementPage.scope2')">
          <el-select
            model-value="PERSONAL"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
            ><el-option
              value="PERSONAL"
              :label="translate('generated.mcpSourceManagementPage.personal2')"
          /></el-select>
        </el-form-item> </slot></el-form
    ><template #footer
      ><el-button @click="sourceDialog = false">{{
        translate('generated.mcpSourceManagementPage.cancel3')
      }}</el-button
      ><el-button type="primary" @click="createSource">{{
        translate('generated.mcpSourceManagementPage.confirm')
      }}</el-button></template
    ></el-dialog
  >
  <el-dialog
    v-if="catalogDialog"
    v-model="catalogDialog"
    :title="translate('generated.mcpSourceManagementPage.addToMCPCenter')"
    width="min(520px, calc(100vw - 32px))"
    destroy-on-close
    :close-icon="marIcon('close')"
    ><el-form
      ref="catalogForm"
      :model="{ ...catalogContext, ...catalogDraft }"
      :rules="{ ...ownershipRules, ...catalogRules }"
      label-width="90px"
      ><el-form-item :label="translate('common.server')"
        ><span>{{ candidate?.displayName }} {{ candidate?.version }}</span></el-form-item
      ><slot name="catalog-ownership">
        <el-form-item :label="translate('generated.mcpSourceManagementPage.scope3')">
          <el-select
            model-value="PERSONAL"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
            ><el-option
              value="PERSONAL"
              :label="translate('generated.mcpSourceManagementPage.personal3')"
          /></el-select>
        </el-form-item> </slot
      ><el-form-item :label="translate('generated.mcpSourceManagementPage.tags')" prop="tags"
        ><el-select
          v-model="catalogDraft.tags"
          multiple
          filterable
          allow-create
          default-first-option
          :multiple-limit="10"
          :placeholder="translate('generated.mcpSourceManagementPage.selectAnExistingTagOrEnterA')"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
          ><el-option
            v-for="tag in catalogTags"
            :key="tag"
            :label="tag"
            :value="tag" /></el-select></el-form-item
      ><el-form-item :label="translate('generated.mcpSourceManagementPage.featured2')"
        ><el-switch v-model="catalogDraft.featured" /></el-form-item></el-form
    ><template #footer
      ><el-button @click="catalogDialog = false">{{
        translate('generated.mcpSourceManagementPage.cancel4')
      }}</el-button
      ><el-button type="primary" @click="addCatalog">{{
        translate('generated.mcpSourceManagementPage.confirm2')
      }}</el-button></template
    ></el-dialog
  >
  <el-dialog
    v-if="editDialog"
    v-model="editDialog"
    :title="translate('generated.mcpSourceManagementPage.editMCPInformation')"
    width="min(460px, calc(100vw - 32px))"
    destroy-on-close
    :close-icon="marIcon('close')"
  >
    <el-form ref="editForm" :model="editDraft" :rules="catalogRules" label-position="top">
      <el-form-item :label="translate('generated.mcpSourceManagementPage.featured3')"
        ><el-switch v-model="editDraft.featured"
      /></el-form-item>
      <el-form-item :label="translate('generated.mcpSourceManagementPage.tags2')" prop="tags">
        <el-select
          v-model="editDraft.tags"
          multiple
          filterable
          allow-create
          default-first-option
          :multiple-limit="10"
          :placeholder="translate('generated.mcpSourceManagementPage.selectAnExistingTagOrEnterA2')"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
        >
          <el-option v-for="tag in catalogTags" :key="tag" :label="tag" :value="tag" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="editDialog = false">{{
        translate('generated.mcpSourceManagementPage.cancel5')
      }}</el-button>
      <el-button type="primary" @click="savePresentation">{{
        translate('generated.mcpSourceManagementPage.save')
      }}</el-button>
    </template>
  </el-dialog>
  <McpDetailsDialog v-model="detailsOpen" :details="details" />
</template>

<style scoped>
.mcp-source-page > * {
  flex-shrink: 0;
  min-width: 0;
}
h2,
p {
  margin: 0;
}
.mcp-management-tabs {
  min-height: 260px;
  min-width: 0;
}
.mcp-management-tabs :deep(.el-tabs__content) {
  min-width: 0;
}
.mcp-management-tabs :deep(.el-tab-pane) {
  display: grid;
  gap: 14px;
  min-width: 0;
}
.source-search-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.source-search-bar :deep(.el-select) {
  width: min(320px, 100%);
  min-width: 200px;
}
.toolbar {
  flex: 1 1 420px;
  min-width: 0;
  max-width: 620px;
}
.mcp-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.mcp-table-section {
  min-height: 180px;
  min-width: 0;
}
.clickable-rows :deep(.el-table__row) {
  cursor: pointer;
}
.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
}
.mcp-empty {
  border: 1px dashed var(--mar-border-medium);
  border-radius: 8px;
  background: var(--mar-bg-subtle);
  padding: 20px;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-body);
  text-align: center;
}
@media (max-width: 720px) {
  .source-search-bar {
    align-items: stretch;
    flex-direction: column;
  }
  .source-search-bar :deep(.el-select) {
    width: 100%;
  }
  .toolbar :deep(.el-button) {
    min-height: 36px;
  }
}
</style>
