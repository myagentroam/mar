<script setup lang="ts" generic="Ownership = unknown">
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import { showMessage } from '../../service/message-feedback-service.js';

import MarIcon from '../common/MarIcon.vue';
import { marIcon } from '../../util/mar-icons.js';
import { managementDateTime } from '../../util/time-presentation.js';
import { computed, h, onMounted, onUnmounted, ref, shallowRef, watch, type Component } from 'vue';
import { ElMessageBox } from '../../service/message-box-service.js';
import type { FormInstance, FormRules } from 'element-plus';
import {
  managementUrlValues,
  replaceManagementUrlValues
} from '../../service/management-url-service';
import NodeDetailsDialogs from './HostingNodeDetailsDialogs.vue';
import { createResourceHostingService } from '../../service/resource-hosting-service.js';
import { useDocumentationAvailability } from '../../service/documentation-availability.js';
import type {
  NodeDetailsData,
  NodeDetailsUpgradeState,
  WorkspaceDetailsData
} from './NodeDetailsDialogs.vue';
import ResourceManagementFilters from './ResourceManagementFilters.vue';
import { translate } from '../../service/locale-preference-service';
import type { RunnerUsage, RunnerUsageName } from '../../service/runner-usage-service';
import { errorMessage } from '../../util/workbench-presentation';
import {
  createManagementPageService,
  parseManagementPage
} from '../../service/management-page-service';
import type { ManagementPage } from '@myagentroam/protocol';
import ManagementPagination from './ManagementPagination.vue';
import type { ResourceRow } from '../../model/resource-management.js';
import type { ComputerUseCapability } from '@myagentroam/protocol';
export type { ResourceRow } from '../../model/resource-management.js';
type Row = ResourceRow<Ownership>;
const documentationAvailable = useDocumentationAvailability();
const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly writable: boolean;
  readonly resourceType: 'NODE' | 'WORKSPACE';
  readonly resourcePath?: string;
  readonly nodePath?: string;
  readonly loadExtension?: () => Promise<void>;
  readonly queryExtension?: Readonly<Record<string, string | number | undefined>>;
  readonly ownershipTypeLabel?: (row: Row) => string;
  readonly ownershipTypeTag?: (row: Row) => 'info' | 'primary';
  readonly ownerLabel?: (row: Row) => string;
  readonly prepareEdit?: (row: Row) => void;
  readonly resourceEditBody?: (row: Row, displayName: string) => Record<string, unknown>;
  readonly registrationBody?: (displayName: string) => unknown;
  readonly detailsComponent?: Component;
  readonly detailsExtension?: (
    row: Row | undefined,
    update: (transform: (row: Row) => Row) => void
  ) => Record<string, unknown>;
}>();
const emit = defineEmits<{ changed: [] }>();
const hosting = createResourceHostingService<Row>(props.request, () => ({
  writable: props.writable
}));

const pushingAllUpgrades = ref(false);
const detailsRefreshing = ref(false);
let detailsRefreshRequest = 0;

const details = shallowRef<Row>();
const editing = shallowRef<Row>();
const editName = ref('');
const editFormRef = ref<FormInstance>();
const registrationFormRef = ref<FormInstance>();
const registrationOpen = ref(false);
const registrationToken = ref('');
const registrationName = ref('');
const creatingRegistrationToken = ref(false);
const usageOpen = ref(false);
const usage = ref<RunnerUsage>();
const usageLoading = ref<RunnerUsageName>();
const usageStatuses = ref<readonly { runner: RunnerUsageName; available: boolean }[]>([]);
const detailsUpgradeState = computed<NodeDetailsUpgradeState | undefined>(() => {
  const row = details.value;
  if (row?.resourceType !== 'NODE') return undefined;
  return {
    label: upgradeLabel(row),
    canUpgrade: canUpgrade(row),
    waitingForRuns: row.metadata?.upgrade?.state === 'WAITING_FOR_RUNS',
    canCancelUpgrade: props.writable && row.manageable !== false
  };
});
const detailsNode = computed<NodeDetailsData | undefined>(() => {
  const row = details.value;
  if (row?.resourceType !== 'NODE') return undefined;
  return {
    id: row.nodeId,
    label: row.label,
    registeredAddress: row.registeredAddress,
    platform: row.platform,
    architecture: row.architecture,
    nodeAppVersion: row.nodeAppVersion,
    nodeVersion: row.nodeVersion,
    metadata: row.metadata,
    connected: row.connected,
    disabled: row.disabled,
    manageable: true,
    secretManageable: true,
    capabilities: row.capabilities
  };
});
const detailsWorkspace = computed<WorkspaceDetailsData | undefined>(() => {
  const row = details.value;
  if (row?.resourceType !== 'WORKSPACE' || row.workspaceId === null) return undefined;
  return { id: row.workspaceId, label: row.label, path: row.path };
});
const keyword = ref('');
const statusFilter = ref<'' | 'online' | 'offline' | 'disabled'>('');
const urlNamespace = props.resourceType === 'NODE' ? 'nodes' : 'workspaces';
const initialFilters = managementUrlValues(urlNamespace, ['keyword', 'status']);
keyword.value = initialFilters.keyword ?? '';
statusFilter.value = (initialFilters.status as typeof statusFilter.value) ?? '';
watch([keyword, statusFilter], () =>
  replaceManagementUrlValues(urlNamespace, {
    keyword: keyword.value,
    status: statusFilter.value || undefined
  })
);
const editRules = computed<FormRules>(() => ({
  name: [
    {
      required: true,
      whitespace: true,
      message: translate('generated.resourceSharingPage.enterAResourceName'),
      trigger: 'blur'
    },
    {
      validator: (_rule, input, callback) =>
        String(input ?? '').trim().length <= (props.resourceType === 'NODE' ? 128 : 255)
          ? callback()
          : callback(
              new Error(
                props.resourceType === 'NODE'
                  ? translate('generated.resourceSharingPage.theNodeNameCannotExceed128Characters')
                  : translate(
                      'generated.resourceSharingPage.theWorkspaceNameCannotExceed255Characters'
                    )
              )
            ),
      trigger: 'blur'
    }
  ]
}));
const registrationRules = computed<FormRules>(() => ({
  name: [
    {
      required: true,
      whitespace: true,
      message: translate('generated.resourceSharingPage.enterANodeName'),
      trigger: 'blur'
    },
    {
      max: 128,
      message: translate('generated.resourceSharingPage.theNodeNameCannotExceed128Characters2'),
      trigger: 'blur'
    }
  ]
}));
const sortBy = ref<string>();
const sortOrder = ref<string>();
const pagination = createManagementPageService<Row>({
  read: readResources,
  key: (row) => row.key,
  context: () =>
    JSON.stringify([
      props.resourcePath,
      props.resourceType,
      keyword.value,
      statusFilter.value,
      props.queryExtension,
      sortBy.value,
      sortOrder.value
    ]),
  reportError: (error) => showMessage(errorMessage(error), 'error', error)
});
const resources = pagination.items;
const loading = pagination.loading;
const pageReady = ref(false);
const refreshLoading = ref(false);
const displayedResources = resources;
watch(pagination.result, (result) => {
  if (result !== undefined) pageReady.value = true;
});
watch(
  () => [props.resourcePath, props.resourceType, props.queryExtension],
  () => {
    pageReady.value = false;
  }
);
watch(
  () => paginationContext(),
  () => {
    void pagination.load(true);
  }
);
function paginationContext(): string {
  return JSON.stringify([
    props.resourcePath,
    props.resourceType,
    keyword.value,
    statusFilter.value,
    props.queryExtension,
    sortBy.value,
    sortOrder.value
  ]);
}
function sortResources(input: { prop?: string; order?: string | null }): void {
  sortBy.value = input.order ? input.prop : undefined;
  sortOrder.value = input.order === 'descending' ? 'desc' : input.order ? 'asc' : undefined;
}
function ownershipTypeLabel(row: Row): string {
  return props.ownershipTypeLabel?.(row) ?? translate('generated.resourceSharingPage.personal2');
}
function ownershipTypeTag(row: Row): 'info' | 'primary' {
  return props.ownershipTypeTag?.(row) ?? 'info';
}
function ownerLabel(row: Row): string {
  return (
    props.ownerLabel?.(row) ??
    row.ownerUsername ??
    translate('generated.resourceSharingPage.personal')
  );
}
const detailsExtensionProps = computed(() => {
  const row = details.value;
  const update = (transform: (value: Row) => Row) => {
    if (row === undefined) return;
    resources.value = resources.value.map((current) =>
      current.key === row.key ? transform(current) : current
    );
    if (details.value?.key === row.key)
      details.value = resources.value.find((current) => current.key === row.key);
    emit('changed');
  };
  if (props.detailsExtension !== undefined) return props.detailsExtension(row, update);
  return {
    hosting: hosting.describe(row),
    hostingCapability: row?.capabilities?.conversationHosting,
    onEnableHosting: () => hosting.enable(row, update),
    onDisableHosting: () => hosting.disable(row, update)
  };
});
function updateComputerUse(capability: ComputerUseCapability): void {
  const row = details.value;
  if (row?.resourceType !== 'NODE') return;
  resources.value = resources.value.map((current) =>
    current.key === row.key
      ? { ...current, capabilities: { ...current.capabilities, computerUse: capability } }
      : current
  );
  details.value = resources.value.find((current) => current.key === row.key);
}

async function readResources(page: number, full = false): Promise<ManagementPage<Row>> {
  const base = props.resourcePath ?? '/api/resources';
  const [path, search] = base.split('?');
  const query = new URLSearchParams(search);
  if (!full) {
    query.set('page', String(page));
    query.set('limit', '20');
    query.set('resourceType', props.resourceType);
    if (keyword.value) query.set('keyword', keyword.value);
    if (statusFilter.value) query.set('status', statusFilter.value);
    if (sortBy.value && sortOrder.value) {
      query.set('sortBy', sortBy.value);
      query.set('sortOrder', sortOrder.value);
    }
    for (const [key, value] of Object.entries(props.queryExtension ?? {}))
      if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const raw = await props.request<Record<string, unknown>>(`${path}?${query}`);
  const nodeRows = raw['nodes'] as readonly (Partial<Row> & {
    id: string;
    displayName?: string | null;
    ownership: Ownership;
  })[];
  const workspaceRows = raw['workspaces'] as readonly {
    nodeId: string;
    nodeDisplayName?: string | null;
    workspaceId: string;
    displayName?: string;
    ownership: Ownership;
    ownerUsername?: string;
  }[];
  let nodeDetails = new Map<string, Partial<Row>>();
  // Bulk upgrade is an on-demand full management read, never the table's data source.
  if (full) {
    const result = await props.request<{ nodes: readonly (Partial<Row> & { id: string })[] }>(
      props.nodePath ?? '/api/nodes'
    );
    nodeDetails = new Map(result.nodes.map((node) => [node.id, node]));
  }
  const rows: Row[] = [
    ...nodeRows.map((node): Row => ({
      ...node,
      ...nodeDetails.get(node.id),
      key: `NODE:${node.id}`,
      resourceType: 'NODE',
      nodeId: node.id,
      workspaceId: null,
      label: node.displayName || node.id,
      ownership: node.ownership
    })),
    ...workspaceRows.map((workspace): Row => ({
      ...workspace,
      key: `WORKSPACE:${workspace.nodeId}:${workspace.workspaceId}`,
      resourceType: 'WORKSPACE',
      nodeLabel: workspace.nodeDisplayName || workspace.nodeId,
      workspaceId: workspace.workspaceId,
      label: workspace.displayName || workspace.workspaceId
    }))
  ];
  return full
    ? { items: rows, page: 1, pageSize: 20, total: rows.length, hasMore: false }
    : parseManagementPage({ ...raw, rows }, 'rows');
}
async function load(): Promise<void> {
  await Promise.all([pagination.load(true), props.loadExtension?.()]);
}
async function refresh(): Promise<void> {
  refreshLoading.value = true;
  try {
    await load();
  } finally {
    refreshLoading.value = false;
  }
}
function statusLabel(row: Row): string {
  return row.disabled
    ? translate('generated.resourceSharingPage.disabled')
    : row.connected
      ? translate('generated.resourceSharingPage.online')
      : translate('generated.resourceSharingPage.offline');
}
function timeLabel(value: number | null | undefined): string {
  return value == null ? '-' : managementDateTime(value);
}
function upgradeLabel(row: Row): string {
  if (row.connected === false) return '-';
  const upgrade = row.metadata?.upgrade;
  if (upgrade?.state === 'WAITING_FOR_RUNS')
    return translate('generated.resourceSharingPage.waitingForRuns', {
      value0: upgrade.activeRunCount ?? 0
    });
  if (upgrade?.state === 'READY_TO_RESTART')
    return translate('generated.resourceSharingPage.readyToRestart');
  if (upgrade?.state === 'FAILED')
    return translate('generated.resourceSharingPage.upgradeFailed', {
      value0: upgrade.errorCode ?? translate('common.unknownError')
    });
  if (row.upgradeAvailability === undefined)
    return translate('generated.resourceSharingPage.unavailable');
  return {
    AVAILABLE: translate('generated.resourceSharingPage.upgradeTo', {
      value0: row.upgradeAvailability.targetVersion
    }),
    CURRENT: translate('generated.resourceSharingPage.upToDate'),
    SERVER_OLDER: translate('generated.resourceSharingPage.nodeIsNewerThanServer'),
    VERSION_INVALID: translate('generated.resourceSharingPage.unknownOrUnsupportedVersion'),
    NODE_UNSUPPORTED: translate('generated.resourceSharingPage.enableSupervisorManually'),
    PACKAGE_UNAVAILABLE: translate('generated.resourceSharingPage.targetNpmPackageUnavailable')
  }[row.upgradeAvailability.state];
}
function canUpgrade(row: Row): boolean {
  return (
    props.writable &&
    row.manageable !== false &&
    row.connected === true &&
    row.disabled !== true &&
    row.metadata?.upgrade?.state !== 'WAITING_FOR_RUNS' &&
    row.metadata?.upgrade?.state !== 'READY_TO_RESTART' &&
    row.upgradeAvailability?.state === 'AVAILABLE'
  );
}
function requestUpgrade(row: Row): Promise<unknown> {
  return props.request(`/api/nodes/${encodeURIComponent(row.nodeId)}/upgrade`, {
    method: 'POST'
  });
}
async function pushAllUpgrades(): Promise<void> {
  if (pushingAllUpgrades.value || !props.writable) return;
  pushingAllUpgrades.value = true;
  let candidates: readonly Row[];
  try {
    candidates = (await readResources(1, true)).items.filter(
      (row) => row.resourceType === 'NODE' && canUpgrade(row)
    );
  } catch (error) {
    showMessage(errorMessage(error), 'error', error);
    pushingAllUpgrades.value = false;
    return;
  }
  if (!candidates.length) {
    pushingAllUpgrades.value = false;
    return;
  }
  try {
    await ElMessageBox.confirm(
      translate('generated.resourceSharingPage.pushAllUpgradesImpact', {
        value0: candidates.length
      }),
      translate('generated.resourceSharingPage.confirmPushAllUpgrades'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('generated.resourceSharingPage.pushAllUpgrades'),
        cancelButtonText: translate('generated.resourceSharingPage.cancel')
      }
    );
  } catch {
    pushingAllUpgrades.value = false;
    return;
  }
  let succeeded = 0;
  const failures: string[] = [];
  try {
    for (const row of candidates) {
      try {
        await requestUpgrade(row);
        succeeded++;
      } catch (error) {
        failures.push(`${row.label}: ${errorMessage(error)}`);
      }
    }
    await load();
    if (details.value?.resourceType === 'NODE')
      details.value = resources.value.find((item) => item.key === details.value?.key);
    if (failures.length === 0)
      showMessage(
        translate('generated.resourceSharingPage.pushAllUpgradesSucceeded', {
          value0: succeeded
        }),
        'success'
      );
    else
      await ElMessageBox.alert(
        h(
          'div',
          { class: 'bulk-upgrade-result-list' },
          translate('generated.resourceSharingPage.pushAllUpgradesPartial', {
            value0: succeeded,
            value1: failures.length,
            value2: failures.join('\n')
          })
        ),
        translate('generated.resourceSharingPage.pushAllUpgrades'),
        {
          closeIcon: marIcon('close'),
          icon: marIcon('warning'),
          type: 'warning',
          customClass: 'bulk-upgrade-result',
          confirmButtonText: translate('generated.resourceSharingPage.close2')
        }
      ).catch(() => undefined);
  } finally {
    pushingAllUpgrades.value = false;
  }
}
async function pushUpgrade(row: Row): Promise<void> {
  if (!canUpgrade(row) || row.upgradeAvailability === undefined) return;
  try {
    await ElMessageBox.confirm(
      translate('generated.resourceSharingPage.upgradeToLimitedByTheLatestStable', {
        value0: row.upgradeAvailability.targetVersion
      }),
      translate('generated.resourceSharingPage.pushNodeUpgrade'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('generated.resourceSharingPage.pushUpgrade'),
        cancelButtonText: translate('generated.resourceSharingPage.cancel')
      }
    );
    await requestUpgrade(row);
    showMessage(
      translate('generated.resourceSharingPage.upgradeRequestedTheNodeWillUpgradeWhen'),
      'success'
    );
    await load();
    if (details.value?.nodeId === row.nodeId)
      details.value = resources.value.find((item) => item.key === row.key);
  } catch (error) {
    if (error !== 'cancel') showMessage(errorMessage(error), 'error', error);
  }
}
async function cancelUpgrade(row: Row): Promise<void> {
  try {
    await props.request(`/api/nodes/${encodeURIComponent(row.nodeId)}/upgrade/cancel`, {
      method: 'POST'
    });
    showMessage(translate('generated.resourceSharingPage.pendingUpgradeCanceled'), 'success');
    await load();
    if (details.value?.nodeId === row.nodeId)
      details.value = resources.value.find((item) => item.key === row.key);
  } catch (error) {
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.resourceSharingPage.unableToCancelUpgrade'),
      'error',
      error
    );
  }
}
function openEdit(row: Row): void {
  editing.value = row;
  editName.value = row.label;
  props.prepareEdit?.(row);
}
async function openDetails(row: Row): Promise<void> {
  details.value = row;
  if (row.resourceType === 'WORKSPACE') {
    try {
      const result = await props.request<{ workspaces: readonly { id: string; path: string }[] }>(
        `/api/workspaces?nodeId=${encodeURIComponent(row.nodeId)}`
      );
      const workspacePath = result.workspaces.find(
        (workspace) => workspace.id === row.workspaceId
      )?.path;
      details.value = workspacePath === undefined ? row : { ...row, path: workspacePath };
    } catch {
      details.value = row;
    }
    return;
  }
  await refreshNodeDetails(row);
  try {
    const result = await props.request<{
      statuses: readonly { runner: 'codex' | 'claude-code'; available: boolean }[];
    }>(`/api/runner-usage/status?nodeId=${encodeURIComponent(row.nodeId)}`);
    usageStatuses.value = result.statuses;
  } catch {
    usageStatuses.value = [];
  }
}
async function refreshNodeDetails(row = details.value): Promise<void> {
  if (row?.resourceType !== 'NODE') return;
  const requestId = ++detailsRefreshRequest;
  detailsRefreshing.value = true;
  try {
    const result = await props.request<{
      nodes: readonly (Partial<Row> & { id: string })[];
    }>(props.nodePath ?? '/api/nodes');
    const latest = result.nodes.find((node) => node.id === row.nodeId);
    if (latest === undefined) return;
    resources.value = resources.value.map((current) =>
      current.key === row.key ? { ...current, ...latest } : current
    );
    if (details.value?.key === row.key)
      details.value = resources.value.find((current) => current.key === row.key);
  } catch (error) {
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.nodeDetailsDialogs.unableToRefreshCapabilities'),
      'error',
      error
    );
  } finally {
    if (requestId === detailsRefreshRequest) detailsRefreshing.value = false;
  }
}
async function saveEdit(): Promise<void> {
  if (!editing.value) return;
  if (!(await editFormRef.value?.validate().catch(() => false))) return;
  const row = editing.value;
  const endpoint =
    row.resourceType === 'NODE'
      ? `/api/nodes/${encodeURIComponent(row.nodeId)}`
      : `/api/workspaces/${encodeURIComponent(row.workspaceId!)}?nodeId=${encodeURIComponent(row.nodeId)}`;
  const resourceBody = props.resourceEditBody?.(row, editName.value) ?? {
    displayName: editName.value.trim()
  };
  try {
    await props.request(endpoint, { method: 'PATCH', body: JSON.stringify(resourceBody) });
    editing.value = undefined;
    await load();
    emit('changed');
    showMessage(translate('generated.resourceSharingPage.resourceUpdated'), 'success');
  } catch (error) {
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.resourceSharingPage.unableToUpdateResource'),
      'error',
      error
    );
  }
}
async function registerNode(): Promise<void> {
  if (creatingRegistrationToken.value || !props.writable) return;
  creatingRegistrationToken.value = true;
  try {
    if (!(await registrationFormRef.value?.validate().catch(() => false))) return;
    registrationToken.value = (
      await props.request<{ token: string }>('/api/node-registration-tokens', {
        method: 'POST',
        body: JSON.stringify(
          props.registrationBody?.(registrationName.value.trim()) ?? {
            displayName: registrationName.value.trim()
          }
        )
      })
    ).token;
    registrationOpen.value = false;
  } catch (error) {
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.resourceSharingPage.unableToCreateRegistrationToken'),
      'error',
      error
    );
  } finally {
    creatingRegistrationToken.value = false;
  }
}
function openRegistration(): void {
  registrationName.value = '';
  registrationToken.value = '';
  registrationOpen.value = true;
}
async function removeResource(row: Row): Promise<void> {
  const isNode = row.resourceType === 'NODE';
  try {
    await ElMessageBox.confirm(
      isNode
        ? translate('generated.resourceSharingPage.deletingTheNodeRegistrationRequiresANew')
        : translate(
            'generated.resourceSharingPage.unregisteringTheWorkspaceRemovesOnlyItsRegistration'
          ),
      isNode
        ? translate('generated.resourceSharingPage.deleteNode')
        : translate('generated.resourceSharingPage.unregisterWorkspace'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: isNode
          ? translate('generated.resourceSharingPage.deleteNode2')
          : translate('generated.resourceSharingPage.unregisterWorkspace2'),
        cancelButtonText: translate('generated.resourceSharingPage.cancel2')
      }
    );
    await props.request(
      isNode
        ? `/api/nodes/${encodeURIComponent(row.nodeId)}`
        : `/api/workspaces/${encodeURIComponent(row.workspaceId!)}?nodeId=${encodeURIComponent(row.nodeId)}`,
      { method: 'DELETE' }
    );
    details.value = undefined;
    await load();
    emit('changed');
  } catch (error) {
    if (error !== 'cancel') showMessage(errorMessage(error), 'error', error);
  }
}
async function showUsage(runner: RunnerUsageName): Promise<void> {
  const row = details.value;
  if (row === undefined || usageLoading.value !== undefined) return;
  usageLoading.value = runner;
  try {
    usage.value = (
      await props.request<{ usage: RunnerUsage }>(
        `/api/runner-usage?nodeId=${encodeURIComponent(row.nodeId)}&runner=${encodeURIComponent(runner)}`
      )
    ).usage;
    usageOpen.value = true;
  } catch (error) {
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.resourceSharingPage.unableToLoadUsage'),
      'error',
      error
    );
  } finally {
    usageLoading.value = undefined;
  }
}
function usageDisabledReason(runner: RunnerUsageName): string {
  const status = usageStatuses.value.find((candidate) => candidate.runner === runner);
  return status?.available === true
    ? ''
    : translate('generated.resourceSharingPage.usageUnavailable');
}
onMounted(() => {
  pagination.start();
  void load();
});
onUnmounted(() => pagination.dispose());
</script>
<template>
  <section
    v-loading="loading && !pageReady"
    element-loading-custom-class="mar-page-loading"
    class="management-page resource-management-panel"
  >
    <slot
      name="filters"
      :keyword="keyword"
      :status="statusFilter"
      :set-keyword="(value: string) => (keyword = value)"
      :set-status="(value: typeof statusFilter) => (statusFilter = value)"
    >
      <ResourceManagementFilters
        v-model:keyword="keyword"
        v-model:status="statusFilter"
        :resource-type="resourceType"
      />
    </slot>
    <div class="table-actions">
      <el-button
        :icon="marIcon('refresh')"
        :loading="refreshLoading && pageReady"
        @click="refresh"
        :loading-icon="marIcon('loading-action')"
        >{{ translate('generated.resourceSharingPage.refresh') }}</el-button
      >
      <el-button
        v-if="resourceType === 'NODE'"
        type="primary"
        :icon="marIcon('plus')"
        :disabled="!writable"
        @click="openRegistration"
        >{{ translate('generated.resourceSharingPage.registerNode') }}</el-button
      >
      <el-button
        v-if="resourceType === 'NODE'"
        :icon="marIcon('upload')"
        :loading="pushingAllUpgrades"
        :disabled="!writable"
        @click="pushAllUpgrades"
        :loading-icon="marIcon('loading-action')"
        >{{ translate('generated.resourceSharingPage.pushAllUpgrades') }}</el-button
      >
    </div>
    <el-table
      v-loading="
        pagination.loading.value && pageReady && !pagination.loadingMore.value && !refreshLoading
      "
      class="clickable-rows"
      :data="displayedResources"
      row-key="key"
      @row-click="openDetails"
      @sort-change="sortResources"
      ><el-table-column
        prop="label"
        :label="
          resourceType === 'NODE'
            ? translate('generated.resourceSharingPage.nodeName')
            : translate('generated.resourceSharingPage.workspaceName')
        "
        sortable="custom"
        min-width="180"
      />
      <el-table-column
        v-if="resourceType === 'WORKSPACE'"
        :label="translate('generated.resourceSharingPage.node')"
        min-width="180"
        ><template #default="{ row }">{{ row.nodeLabel }}</template></el-table-column
      >
      <el-table-column
        v-if="resourceType === 'NODE'"
        :label="translate('generated.resourceSharingPage.status2')"
        width="110"
        ><template #default="{ row }"
          ><el-tag
            effect="light"
            :type="row.disabled ? 'danger' : row.connected ? 'success' : 'info'"
            >{{ statusLabel(row) }}</el-tag
          ></template
        ></el-table-column
      >
      <el-table-column
        :label="translate('generated.resourceSharingPage.ownershipType')"
        min-width="120"
        ><template #default="{ row }"
          ><el-tag :type="ownershipTypeTag(row)" effect="light">{{
            ownershipTypeLabel(row)
          }}</el-tag></template
        ></el-table-column
      >
      <el-table-column :label="translate('generated.resourceSharingPage.owner')" min-width="160"
        ><template #default="{ row }">{{ ownerLabel(row) }}</template></el-table-column
      >
      <el-table-column
        v-if="resourceType === 'NODE'"
        :label="translate('generated.resourceSharingPage.lastHeartbeat')"
        min-width="180"
        ><template #default="{ row }">{{
          timeLabel(row.lastHeartbeatAt)
        }}</template></el-table-column
      >
      <el-table-column
        v-if="resourceType === 'NODE'"
        prop="nodeAppVersion"
        :label="translate('generated.resourceSharingPage.currentVersion')"
        min-width="150"
        ><template #default="{ row }">{{
          row.nodeAppVersion ?? translate('generated.nodeDetailsDialogs.unknown')
        }}</template></el-table-column
      >
      <el-table-column
        v-if="resourceType === 'NODE'"
        :label="translate('generated.resourceSharingPage.upgradeStatus')"
        min-width="210"
        ><template #default="{ row }">{{ upgradeLabel(row) }}</template></el-table-column
      >
      <el-table-column :label="translate('generated.resourceSharingPage.actions')" :width="290"
        ><template #default="{ row }"
          ><div class="row-actions" @click.stop>
            <el-button link :icon="marIcon('edit')" :disabled="!writable" @click="openEdit(row)">{{
              translate('generated.resourceSharingPage.edit')
            }}</el-button>
            <slot name="resource-actions" :resource="row" />
            <el-button
              link
              type="danger"
              :icon="marIcon('delete')"
              :disabled="!writable"
              @click="removeResource(row)"
              >{{ translate('common.delete') }}</el-button
            >
          </div></template
        ></el-table-column
      ></el-table
    >
    <ManagementPagination
      :total="pagination.total.value"
      :has-more="pagination.hasMore.value"
      :loading="loading"
      :loading-more="pagination.loadingMore.value"
      :page="pagination.page.value"
      :mobile="pagination.mobileViewport.value"
      :mobile-visible-count="pagination.mobileVisibleCount.value"
      @page="pagination.setPage"
      @load-more="pagination.loadMore"
    />
    <el-dialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="editing !== undefined"
      :model-value="editing !== undefined"
      :title="
        resourceType === 'NODE'
          ? translate('generated.resourceSharingPage.editNode')
          : translate('generated.resourceSharingPage.editWorkspace')
      "
      width="min(460px, calc(100vw - 32px))"
      @update:model-value="editing = undefined"
      :close-icon="marIcon('close')"
      ><el-form
        v-if="editing"
        ref="editFormRef"
        :model="{ name: editName }"
        :rules="editRules"
        label-position="top"
        ><el-form-item
          prop="name"
          :label="
            editing.resourceType === 'NODE'
              ? translate('generated.resourceSharingPage.nodeName2')
              : translate('generated.resourceSharingPage.workspaceName2')
          "
          ><el-input
            v-model="editName"
            :placeholder="
              editing.resourceType === 'NODE'
                ? translate('generated.resourceSharingPage.enterANodeName2')
                : translate('generated.resourceSharingPage.enterAWorkspaceName')
            "
            :maxlength="editing.resourceType === 'NODE' ? 128 : 255" /></el-form-item
        ><slot name="edit-owner" :resource="editing"
          ><el-form-item :label="translate('generated.resourceSharingPage.owner2')"
            ><el-input
              :model-value="translate('generated.resourceSharingPage.personal3')"
              disabled /></el-form-item></slot></el-form
      ><template #footer
        ><el-button @click="editing = undefined">{{
          translate('generated.resourceSharingPage.cancel4')
        }}</el-button
        ><el-button type="primary" :disabled="!writable" @click="saveEdit">{{
          translate('generated.resourceSharingPage.save')
        }}</el-button></template
      ></el-dialog
    ><component
      :is="detailsComponent ?? NodeDetailsDialogs"
      v-bind="detailsExtensionProps"
      :node-open="details?.resourceType === 'NODE'"
      :workspace-open="details?.resourceType === 'WORKSPACE'"
      v-model:usage-open="usageOpen"
      :node="detailsNode"
      :workspace="detailsWorkspace"
      :workspace-node-id="details?.resourceType === 'WORKSPACE' ? details.nodeId : undefined"
      :workspace-node-label="details?.nodeLabel"
      :workspace-node-connected="details?.connected"
      :workspace-git-manageable="details !== undefined && writable"
      :workspace-secret-manageable="details !== undefined"
      :usage="usage"
      :usage-loading="usageLoading"
      :usage-disabled-reason="usageDisabledReason"
      :ownership-type-label="details === undefined ? undefined : ownershipTypeLabel(details)"
      :ownership-type-tag="details === undefined ? undefined : ownershipTypeTag(details)"
      :owner-label="details !== undefined ? ownerLabel(details) : undefined"
      :secret-writable="writable"
      :node-refreshable="details?.resourceType === 'NODE'"
      :node-refreshing="detailsRefreshing"
      :upgrade="detailsUpgradeState"
      :request="request"
      @update:node-open="details = undefined"
      @update:workspace-open="details = undefined"
      @computer-use-changed="updateComputerUse"
      @refresh-node="refreshNodeDetails()"
      @usage="showUsage"
      @upgrade="details && pushUpgrade(details)"
      @cancel-upgrade="details && cancelUpgrade(details)"
    /><el-dialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="registrationOpen"
      v-model="registrationOpen"
      :title="translate('generated.resourceSharingPage.registerNode2')"
      width="min(460px, calc(100vw - 32px))"
      :show-close="!creatingRegistrationToken"
      :close-on-click-modal="!creatingRegistrationToken"
      :close-on-press-escape="!creatingRegistrationToken"
      :close-icon="marIcon('close')"
      ><el-form
        ref="registrationFormRef"
        :model="{ name: registrationName }"
        :rules="registrationRules"
        :disabled="creatingRegistrationToken"
        label-position="top"
        ><el-form-item :label="translate('generated.resourceSharingPage.nodeName4')" prop="name"
          ><el-input
            v-model="registrationName"
            maxlength="128"
            :placeholder="
              translate('generated.resourceSharingPage.enterANodeName3')
            " /></el-form-item
        ><slot name="registration-owner"
          ><el-form-item :label="translate('generated.resourceSharingPage.owner4')"
            ><el-input
              :model-value="translate('generated.resourceSharingPage.personal4')"
              disabled /></el-form-item></slot
      ></el-form>
      <template #footer>
        <el-button :disabled="creatingRegistrationToken" @click="registrationOpen = false">{{
          translate('generated.resourceSharingPage.close2')
        }}</el-button>
        <el-button
          type="primary"
          :disabled="!writable"
          :loading="creatingRegistrationToken"
          :icon="marIcon('plus')"
          @click="registerNode"
          :loading-icon="marIcon('loading-action')"
          >{{
            translate('generated.resourceSharingPage.createOneTimeRegistrationToken')
          }}</el-button
        >
      </template>
    </el-dialog>
    <el-dialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="registrationToken"
      :model-value="true"
      :title="translate('generated.resourceSharingPage.registrationTokenCreated')"
      width="min(460px, calc(100vw - 32px))"
      :close-on-click-modal="false"
      @update:model-value="registrationToken = ''"
      :close-icon="marIcon('close')"
    >
      <el-alert
        :title="translate('generated.resourceSharingPage.registrationTokenCreated')"
        type="success"
        show-icon
        :closable="false"
        ><template #icon><MarIcon name="success" /></template
      ></el-alert>
      <p class="registration-instructions">
        {{ translate('generated.resourceSharingPage.registrationTokenInstructions') }}
      </p>
      <div class="registration-token-label">
        {{ translate('generated.resourceSharingPage.registrationTokenLabel') }}
      </div>
      <code class="registration-token">{{ registrationToken }}</code>
      <el-link
        v-if="documentationAvailable"
        class="registration-help-link"
        type="primary"
        :icon="marIcon('link')"
        :underline="false"
        :href="translate('generated.resourceSharingPage.docsEnUSDeploymentNodeInstallation')"
        target="_blank"
        rel="noopener noreferrer"
        >{{
          translate('generated.resourceSharingPage.viewNodeDeploymentAndAutostartGuide')
        }}</el-link
      >
      <template #footer
        ><el-button @click="registrationToken = ''">{{
          translate('generated.resourceSharingPage.close2')
        }}</el-button></template
      ></el-dialog
    >
    <slot name="extensions" />
  </section>
</template>
<style scoped>
.clickable-rows :deep(.el-table__row) {
  cursor: pointer;
}

.resource-management-panel code {
  display: block;
  font-size: var(--mar-font-size-meta);
  color: var(--mar-text-muted);
}
code.registration-token {
  display: block;
  margin: 0.5rem 0 1rem;
  padding: 0.75rem;
  border: 1px solid var(--mar-border-default);
  border-radius: 4px;
  font-size: var(--mar-font-size-body);
  color: var(--mar-text-primary);
  overflow-wrap: anywhere;
  user-select: all;
}
.registration-instructions {
  margin: 1rem 0;
  line-height: 1.6;
}
.registration-token-label {
  font-weight: 600;
}
.registration-help-link {
  margin-top: 2px;
  font-size: var(--mar-font-size-body);
}
:global(.resource-management-panel .el-dialog .el-descriptions__label) {
  width: 140px;
}
:global(.bulk-upgrade-result.el-message-box) {
  width: min(520px, calc(100vw - 32px));
}
:global(.bulk-upgrade-result-list) {
  max-height: min(50vh, 420px);
  overflow-y: auto;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
</style>
