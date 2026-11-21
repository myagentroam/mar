<script setup lang="ts">
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarTabPane, MarTabs } from '@myagentroam/mar-ui/tabs';
import { MarTag } from '@myagentroam/mar-ui/tag';
import { MarTable, MarTableColumn } from '@myagentroam/mar-ui/table';
import { MarForm, MarFormItem, type FormInstance, type FormRules } from '@myagentroam/mar-ui/form';
import { MarSelect, MarOption } from '@myagentroam/mar-ui/select';
import { MarSwitch } from '@myagentroam/mar-ui/switch';

import { MarInput } from '@myagentroam/mar-ui/input';
import { MarButton } from '@myagentroam/mar-ui/button';
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import { watchManagementPageFailure } from '../../service/management-page-feedback.js';
import { showMessage } from '../../service/message-feedback-service.js';

import { marIcon } from '@myagentroam/mar-ui/icons';
import { managementDateTime } from '../../util/time-presentation.js';
import { MarMessageBox } from '../../service/message-box-service.js';
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import McpDetailsDialog, { type McpDetails } from './McpDetailsDialog.vue';
import { translate } from '../../service/locale-preference-service';
import { errorCode } from '../../util/api-error';
import { errorMessage as displayErrorMessage } from '../../util/workbench-presentation';
import {
  createCatalogPageService,
  readCatalogReferences
} from '../../service/catalog-page-service';
import ManagementPagination from '../settings/ManagementPagination.vue';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';

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
watchManagementPageFailure(pagination);
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
const sourcesLoading = ref(false);
const catalogLoading = computed(() => pagination.loading.value && !pagination.loadingMore.value);
const discoveryState = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle');
let discoveryRevision = 0;
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
onUnmounted(() => {
  discoveryRevision++;
  pagination.dispose();
});
watch(
  sourceId,
  () => {
    discoveryRevision++;
    candidates.value = [];
    candidateCatalog.value = [];
    discoveryState.value = 'idle';
    catalogDialog.value = false;
    candidate.value = undefined;
  },
  { flush: 'sync' }
);

async function initialize(): Promise<void> {
  await run(loadSources);
  await run(loadCatalog);
  await run(async () => props.loadExtension?.());
}
async function loadCatalog(): Promise<void> {
  await pagination.refresh();
  const currentCandidates = candidates.value;
  if (currentCandidates.length) {
    const references = await readCatalogReferences<CatalogEntry>(
      props.request,
      '/api/mcp-catalog',
      'entries',
      [],
      currentCandidates.map((entry) => entry.serverName)
    );
    if (currentCandidates === candidates.value) candidateCatalog.value = references;
  }
}
async function loadSources(): Promise<void> {
  sourcesLoading.value = true;
  try {
    sources.value = (await props.request<{ sources: Source[] }>('/api/mcp-sources')).sources;
    if (!sources.value.some((source) => source.id === sourceId.value && source.enabled))
      sourceId.value = sources.value.find((source) => source.enabled)?.id ?? '';
  } finally {
    sourcesLoading.value = false;
  }
}
async function discover(): Promise<void> {
  const source = sourceId.value;
  if (!source || loading.value || discoveryState.value === 'loading') return;
  const revision = ++discoveryRevision;
  discoveryState.value = 'loading';
  candidates.value = [];
  candidateCatalog.value = [];
  try {
    const rows = (
      await props.request<{ servers: Candidate[] }>(
        `/api/mcp-sources/${encodeURIComponent(source)}/servers?${new URLSearchParams({ query: query.value })}`
      )
    ).servers;
    if (revision !== discoveryRevision) return;
    const references = await readCatalogReferences<CatalogEntry>(
      props.request,
      '/api/mcp-catalog',
      'entries',
      [],
      rows.map((entry) => entry.serverName)
    );
    if (revision !== discoveryRevision) return;
    candidates.value = rows;
    candidateCatalog.value = references;
    discoveryState.value = 'ready';
  } catch (error) {
    if (revision !== discoveryRevision) return;
    discoveryState.value = 'failed';
    showOperationError(error);
  }
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
    await MarMessageBox.confirm(
      source.enabled
        ? translate('generated.mcpSourceManagementPage.confirmDisableMCPSource', {
            value0: displaySourceName(source)
          })
        : translate('generated.mcpSourceManagementPage.confirmEnableMCPSource', {
            value0: displaySourceName(source)
          }),
      translate('generated.mcpSourceManagementPage.updateMCPSourceStatus'),
      {
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
    await MarMessageBox.confirm(
      translate('generated.mcpSourceManagementPage.deleteMCPSource', { value0: source.name }),
      translate('generated.mcpSourceManagementPage.deleteMCPSource2'),
      {
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
  if (!candidates.value.includes(item)) return;
  candidate.value = item;
  Object.assign(catalogDraft, {
    featured: false,
    tags: []
  });
  emit('openCatalog');
  catalogDialog.value = true;
}
async function addCatalog(): Promise<void> {
  const item = candidate.value;
  const source = sourceId.value;
  const revision = discoveryRevision;
  if (!item || !source || loading.value || !candidates.value.includes(item)) return;
  if ((await catalogForm.value?.validate().catch(() => false)) !== true) return;
  if (
    !catalogDialog.value ||
    loading.value ||
    revision !== discoveryRevision ||
    item !== candidate.value
  )
    return;
  await run(async () => {
    const input = { sourceId: source, candidate: item, ...catalogDraft };
    if (props.submitCatalog !== undefined) await props.submitCatalog(input);
    else
      await props.request('/api/mcp-catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, scope: 'PERSONAL' })
      });
    if (candidate.value === item) catalogDialog.value = false;
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
    showMessage(
      result.updateAvailable
        ? translate('generated.mcpSourceManagementPage.updateAvailable')
        : translate('generated.mcpSourceManagementPage.alreadyUpToDate'),
      'info'
    );
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
    await MarMessageBox.confirm(
      translate('generated.mcpSourceManagementPage.removeFromMCPCenter', {
        value0: entry.displayName
      }),
      translate('generated.mcpSourceManagementPage.removeCatalogEntry'),
      {
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
    if (success) showMessage(success, 'success');
  } catch (error) {
    if (error !== pagination.error.value) showOperationError(error);
  } finally {
    loading.value = false;
  }
}

function showOperationError(error: unknown): void {
  showMessage(
    errorCode(error) === 'MCP_CATALOG_ALREADY_EXISTS'
      ? translate('generated.mcpSourceManagementPage.thisMCPServerIsAlreadyInThe')
      : displayErrorMessage(error),
    'error',
    error
  );
}

function scopeLabel(scope: string): string {
  return props.scopeLabel?.(scope) ?? translate('generated.mcpSourceManagementPage.personal');
}
</script>

<template>
  <main class="mar-management-page mcp-source-page">
    <div class="mar-table-actions">
      <MarButton
        type="primary"
        :icon="marIcon('plus')"
        :disabled="!writable"
        @click="openSourceDialog"
        >{{ translate('generated.mcpSourceManagementPage.addMCPSource') }}</MarButton
      >
    </div>
    <MarTable
      class="clickable-rows mcp-source-table"
      :data="displayedSources"
      :aria-busy="sourcesLoading"
      row-key="id"
      @row-click="showSourceDetails"
    >
      <template v-if="sourcesLoading" #loading>
        <span role="progressbar" :aria-label="translate('common.loading')">
          <MarBusyIndicator class="mar-read-loading-indicator" />
        </span>
      </template>
      <MarTableColumn
        prop="name"
        :label="translate('generated.mcpSourceManagementPage.name')"
        min-width="180"
        sortable
        ><template #default="{ row }">{{ displaySourceName(row) }}</template></MarTableColumn
      >
      <MarTableColumn
        :label="translate('generated.mcpSourceManagementPage.scope')"
        width="144"
        show-overflow-tooltip
        sortable
        ><template #default="{ row }">{{ scopeLabel(row.scope) }}</template></MarTableColumn
      >
      <MarTableColumn
        prop="locator"
        :label="translate('generated.mcpSourceManagementPage.uRL')"
        min-width="300"
        show-overflow-tooltip
      />
      <MarTableColumn :label="translate('generated.mcpSourceManagementPage.status')" width="110"
        ><template #default="{ row }"
          ><MarTag :type="row.enabled ? 'success' : 'info'" effect="plain">{{
            row.enabled
              ? translate('generated.mcpSourceManagementPage.enabled')
              : translate('generated.mcpSourceManagementPage.disabled')
          }}</MarTag></template
        ></MarTableColumn
      >
      <MarTableColumn :label="translate('generated.mcpSourceManagementPage.actions')" :width="180">
        <template #default="{ row }"
          ><div class="mar-row-actions" @click.stop>
            <MarButton
              link
              :icon="marIcon('power')"
              :disabled="!row.manageable || !writable"
              @click="confirmSourceStatusChange(row)"
              >{{
                row.enabled
                  ? translate('generated.mcpSourceManagementPage.disable')
                  : translate('generated.mcpSourceManagementPage.enable')
              }}</MarButton
            ><MarButton
              link
              type="danger"
              :icon="marIcon('delete')"
              :disabled="row.builtIn || !row.manageable || !writable"
              @click="removeSource(row)"
              >{{ translate('generated.mcpSourceManagementPage.delete2') }}</MarButton
            >
          </div></template
        >
      </MarTableColumn>
    </MarTable>

    <MarTabs v-model="activeMcpTab" class="mcp-management-tabs">
      <MarTabPane
        :label="translate('generated.mcpSourceManagementPage.sourceMCPServers')"
        name="source"
      >
        <div class="source-search-bar">
          <MarSelect
            v-model="sourceId"
            :aria-label="translate('generated.mcpSourceManagementPage.selectAnEnabledMCPSource')"
            :placeholder="translate('generated.mcpSourceManagementPage.selectAnEnabledMCPSource')"
            ><MarOption
              v-for="source in sources.filter((item) => item.enabled)"
              :key="source.id"
              :label="displaySourceName(source)"
              :value="source.id"
          /></MarSelect>
          <div class="toolbar">
            <MarInput
              v-model="query"
              clearable
              :placeholder="
                translate('generated.mcpSourceManagementPage.enterAnMCPServerNameOrDescription')
              "
              @keyup.enter="discover"
              :clear-icon="marIcon('clear-input')"
            >
              <template #append
                ><MarButton
                  :icon="marIcon('search')"
                  :disabled="!sourceId || loading || discoveryState === 'loading'"
                  @click="discover"
                  >{{ translate('generated.mcpSourceManagementPage.search') }}</MarButton
                ></template
              >
            </MarInput>
          </div>
        </div>
        <div class="mcp-table-section">
          <MarTable
            v-if="discoveryState !== 'idle'"
            class="clickable-rows source-mcp-table"
            :data="candidates"
            :aria-busy="discoveryState === 'loading'"
            row-key="id"
            @row-click="showDetails"
          >
            <template v-if="discoveryState === 'loading'" #loading>
              <span role="progressbar" :aria-label="translate('common.loading')">
                <MarBusyIndicator class="mar-read-loading-indicator" />
              </span>
            </template>
            <MarTableColumn
              prop="displayName"
              :label="translate('generated.mcpSourceManagementPage.name')"
              sortable
              min-width="180"
            />
            <MarTableColumn
              prop="serverName"
              :label="translate('generated.mcpDetailsDialog.serverName')"
              min-width="180"
              show-overflow-tooltip
            />
            <MarTableColumn
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
            </MarTableColumn>
            <MarTableColumn
              prop="version"
              :label="translate('generated.mcpDetailsDialog.version')"
              width="120"
            />
            <MarTableColumn :label="translate('generated.mcpDetailsDialog.transport')" width="120">
              <template #default="{ row }">{{ row.runtime.transport }}</template>
            </MarTableColumn>
            <MarTableColumn
              :label="translate('generated.mcpSourceManagementPage.actions')"
              :width="180"
            >
              <template #default="{ row }">
                <div class="mar-row-actions" @click.stop>
                  <MarButton
                    link
                    :icon="marIcon('plus')"
                    :disabled="!writable || catalogServerNames.has(row.serverName)"
                    @click="openCatalog(row)"
                    >{{
                      catalogServerNames.has(row.serverName)
                        ? translate('generated.mcpSourceManagementPage.added')
                        : translate('generated.mcpSourceManagementPage.addToCatalog')
                    }}</MarButton
                  >
                </div>
              </template>
            </MarTableColumn>
          </MarTable>
          <div v-else class="mcp-empty">
            {{
              sourceId
                ? translate('generated.mcpSourceManagementPage.enterAKeywordToSearchThisSource')
                : translate('generated.mcpSourceManagementPage.selectAnEnabledMCPSource2')
            }}
          </div>
        </div>
      </MarTabPane>
      <MarTabPane
        :label="translate('generated.mcpSourceManagementPage.catalogMCPServers')"
        name="catalog"
      >
        <div class="mcp-toolbar">
          <MarInput
            v-model="pagination.keyword.value"
            clearable
            :placeholder="translate('generated.mcpCenterPanel.searchMCPServers')"
            :clear-icon="marIcon('clear-input')"
          />
          <MarSelect
            v-model="pagination.category.value"
            clearable
            :aria-label="translate('generated.mcpCenterPanel.mCPCategories')"
            :placeholder="translate('generated.mcpCenterPanel.mCPCategories')"
          >
            <MarOption v-for="tag in catalogTags" :key="tag" :label="tag" :value="tag" />
          </MarSelect>
        </div>
        <div class="mcp-table-section">
          <MarTable
            class="clickable-rows catalog-mcp-table"
            @sort-change="pagination.sort"
            :data="catalog"
            :aria-busy="catalogLoading"
            row-key="id"
            @row-click="showDetails"
          >
            <template v-if="catalogLoading" #loading>
              <span role="progressbar" :aria-label="translate('common.loading')">
                <MarBusyIndicator class="mar-read-loading-indicator" />
              </span>
            </template>
            <MarTableColumn
              prop="displayName"
              :label="translate('generated.mcpSourceManagementPage.name')"
              sortable="custom"
              min-width="170"
            />
            <MarTableColumn
              prop="serverName"
              :label="translate('generated.mcpDetailsDialog.serverName')"
              min-width="180"
              show-overflow-tooltip
            />
            <MarTableColumn
              :label="translate('generated.mcpSourceManagementPage.scope')"
              width="144"
              show-overflow-tooltip
            >
              <template #default="{ row }">{{ scopeLabel(row.scope) }}</template>
            </MarTableColumn>
            <MarTableColumn
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
            </MarTableColumn>
            <MarTableColumn
              prop="version"
              :label="translate('generated.mcpDetailsDialog.version')"
              width="120"
            />
            <MarTableColumn :label="translate('generated.mcpDetailsDialog.tags')" min-width="150">
              <template #default="{ row }">
                <div v-if="row.featured || row.tags.length > 0" class="mcp-tags">
                  <MarTag v-if="row.featured" type="warning" effect="plain"
                    >★ {{ translate('generated.mcpSourceManagementPage.featured') }}</MarTag
                  >
                  <MarTag v-for="tag in row.tags" :key="tag" type="info" effect="plain">{{
                    tag
                  }}</MarTag>
                </div>
              </template>
            </MarTableColumn>
            <MarTableColumn
              :label="translate('generated.mcpSourceManagementPage.actions')"
              min-width="360"
            >
              <template #default="{ row }">
                <div class="mar-row-actions" @click.stop>
                  <MarButton
                    link
                    :icon="marIcon('edit')"
                    :disabled="!writable || !row.manageable || loading"
                    @click="openEdit(row)"
                    >{{ translate('generated.mcpSourceManagementPage.edit') }}</MarButton
                  >
                  <MarButton
                    v-if="!updateChecks[row.id]?.updateAvailable"
                    link
                    :icon="marIcon('refresh')"
                    :loading="checkingEntryIds.has(row.id)"
                    :disabled="!writable || !row.manageable || loading"
                    @click="checkUpdate(row)"
                    >{{ translate('generated.mcpSourceManagementPage.checkForUpdates') }}</MarButton
                  >
                  <MarButton
                    v-else
                    link
                    :icon="marIcon('retry')"
                    :loading="upgradingEntryId === row.id"
                    :disabled="!writable || !row.manageable || loading"
                    @click="upgrade(row)"
                    >{{ translate('generated.mcpSourceManagementPage.updateTo') }}
                    {{ updateChecks[row.id]!.latestVersion }}</MarButton
                  >
                  <MarButton
                    link
                    type="danger"
                    :icon="marIcon('delete')"
                    :disabled="!writable || !row.manageable || loading"
                    @click="removeCatalog(row)"
                    >{{ translate('generated.mcpSourceManagementPage.remove2') }}</MarButton
                  >
                </div>
              </template>
            </MarTableColumn>
          </MarTable>

          <ManagementPagination
            :total="pagination.total.value"
            :page="pagination.page.value"
            :mobile="pagination.mobileViewport.value"
            :mobile-visible-count="pagination.mobileVisibleCount.value"
            :loading="pagination.loading.value"
            :loading-more="pagination.loadingMore.value"
            :has-more="pagination.hasMore.value"
            @page="pagination.setPage"
            :failed="pagination.failure.value !== undefined"
            :incremental-failed="pagination.failure.value?.incremental === true"
            :error="pagination.failure.value?.error"
            :context-key="pagination.contextKey.value"
            @retry="pagination.retry"
            @load-more="pagination.loadMore"
          />
        </div>
      </MarTabPane>
    </MarTabs>
  </main>
  <MarDialog
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    v-if="sourceDialog"
    v-model="sourceDialog"
    :title="translate('generated.mcpSourceManagementPage.addMCPSource2')"
    width="min(520px, calc(100vw - 32px))"
    destroy-on-close
    ><MarForm
      ref="sourceForm"
      :model="{ ...sourceContext, ...sourceDraft }"
      :rules="{ ...ownershipRules, ...sourceRules }"
      label-width="90px"
      ><MarFormItem :label="translate('generated.mcpSourceManagementPage.name2')" prop="name"
        ><MarInput v-model="sourceDraft.name" /></MarFormItem
      ><MarFormItem :label="translate('common.registry')" prop="locator"
        ><MarInput
          v-model="sourceDraft.locator"
          :placeholder="translate('common.registryUrlExample')" /></MarFormItem
      ><slot name="source-ownership">
        <MarFormItem :label="translate('generated.mcpSourceManagementPage.scope2')">
          <MarSelect
            model-value="PERSONAL"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
            ><MarOption
              value="PERSONAL"
              :label="translate('generated.mcpSourceManagementPage.personal2')"
          /></MarSelect>
        </MarFormItem> </slot></MarForm
    ><template #footer
      ><MarButton @click="sourceDialog = false">{{
        translate('generated.mcpSourceManagementPage.cancel3')
      }}</MarButton
      ><MarButton type="primary" @click="createSource">{{
        translate('generated.mcpSourceManagementPage.confirm')
      }}</MarButton></template
    ></MarDialog
  >
  <MarDialog
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    v-if="catalogDialog"
    v-model="catalogDialog"
    :title="translate('generated.mcpSourceManagementPage.addToMCPCenter')"
    width="min(520px, calc(100vw - 32px))"
    destroy-on-close
    ><MarForm
      ref="catalogForm"
      :model="{ ...catalogContext, ...catalogDraft }"
      :rules="{ ...ownershipRules, ...catalogRules }"
      label-width="90px"
      ><MarFormItem :label="translate('common.server')"
        ><span>{{ candidate?.displayName }} {{ candidate?.version }}</span></MarFormItem
      ><slot name="catalog-ownership">
        <MarFormItem :label="translate('generated.mcpSourceManagementPage.scope3')">
          <MarSelect
            model-value="PERSONAL"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
            ><MarOption
              value="PERSONAL"
              :label="translate('generated.mcpSourceManagementPage.personal3')"
          /></MarSelect>
        </MarFormItem> </slot
      ><MarFormItem :label="translate('generated.mcpSourceManagementPage.tags')" prop="tags"
        ><MarSelect
          v-model="catalogDraft.tags"
          multiple
          filterable
          allow-create
          default-first-option
          :multiple-limit="10"
          :placeholder="translate('generated.mcpSourceManagementPage.selectAnExistingTagOrEnterA')"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
          ><MarOption
            v-for="tag in catalogTags"
            :key="tag"
            :label="tag"
            :value="tag" /></MarSelect></MarFormItem
      ><MarFormItem :label="translate('generated.mcpSourceManagementPage.featured2')"
        ><MarSwitch v-model="catalogDraft.featured" /></MarFormItem></MarForm
    ><template #footer
      ><MarButton @click="catalogDialog = false">{{
        translate('generated.mcpSourceManagementPage.cancel4')
      }}</MarButton
      ><MarButton type="primary" @click="addCatalog">{{
        translate('generated.mcpSourceManagementPage.confirm2')
      }}</MarButton></template
    ></MarDialog
  >
  <MarDialog
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    v-if="editDialog"
    v-model="editDialog"
    :title="translate('generated.mcpSourceManagementPage.editMCPInformation')"
    width="min(460px, calc(100vw - 32px))"
    destroy-on-close
  >
    <MarForm ref="editForm" :model="editDraft" :rules="catalogRules" label-position="top">
      <MarFormItem :label="translate('generated.mcpSourceManagementPage.featured3')"
        ><MarSwitch v-model="editDraft.featured"
      /></MarFormItem>
      <MarFormItem :label="translate('generated.mcpSourceManagementPage.tags2')" prop="tags">
        <MarSelect
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
          <MarOption v-for="tag in catalogTags" :key="tag" :label="tag" :value="tag" />
        </MarSelect>
      </MarFormItem>
    </MarForm>
    <template #footer>
      <MarButton @click="editDialog = false">{{
        translate('generated.mcpSourceManagementPage.cancel5')
      }}</MarButton>
      <MarButton type="primary" @click="savePresentation">{{
        translate('generated.mcpSourceManagementPage.save')
      }}</MarButton>
    </template>
  </MarDialog>
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
.mcp-management-tabs :deep(.mar-ui-tabs__content) {
  min-width: 0;
}
.mcp-management-tabs :deep(.mar-ui-tab-pane) {
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
.source-search-bar :deep(.mar-ui-select) {
  width: min(320px, 100%);
  min-width: 200px;
}
.toolbar {
  flex: 0 1 360px;
  min-width: 0;
}
.mcp-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.mcp-toolbar > :deep(.mar-ui-input) {
  width: min(320px, 100%);
}
.mcp-toolbar > :deep(.mar-ui-select) {
  width: min(200px, 100%);
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
.clickable-rows :deep(.mar-ui-table__row) {
  cursor: pointer;
}
.mar-row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
}
.mcp-empty {
  border: 1px dashed var(--mar-border-medium);
  border-radius: 8px;
  background: var(--mar-bg-subtle);
  padding: 20px;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  text-align: center;
}
@media (max-width: 720px) {
  .source-search-bar,
  .mcp-toolbar {
    align-items: stretch;
    flex-direction: column;
  }
  .source-search-bar :deep(.mar-ui-select),
  .mcp-toolbar > :deep(.mar-ui-input),
  .mcp-toolbar > :deep(.mar-ui-select) {
    width: 100%;
  }
  .source-search-bar .toolbar {
    flex-basis: auto;
  }
  .toolbar :deep(.mar-ui-button) {
    min-height: 36px;
  }
}
</style>
