<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import { marIcon } from '@myagentroam/mar-ui/icons';
import { MarTable, MarTableColumn } from '@myagentroam/mar-ui/table';
import { MarTag } from '@myagentroam/mar-ui/tag';
import { MANAGEMENT_DEFAULT_LIMIT } from '@myagentroam/protocol';
import { translate } from '../../service/locale-preference-service.js';
import {
  scheduledTaskClient,
  type ScheduleInvalidation,
  type ScheduleOccurrence,
  type ScheduleScope,
  type ScheduleTaskKey,
  type ScheduleWorkspaceOption
} from '../../service/scheduled-task-client.js';
import { errorSummary } from '../../util/error-presentation.js';
import { managementDateTime } from '../../util/time-presentation.js';
import ManagementPagination from '../settings/ManagementPagination.vue';
import ScheduledWorkspaceFilter from './ScheduledWorkspaceFilter.vue';

// Owns one paged history query. The panel owns the task scope and occurrence detail.
const props = defineProps<{
  client: ReturnType<typeof scheduledTaskClient>;
  mobile: boolean;
  task?: ScheduleTaskKey;
  invalidation?: ScheduleInvalidation | undefined;
}>();
const emit = defineEmits<{ open: [record: ScheduleOccurrence] }>();
const msg = (key: string, args?: Record<string, number>) =>
  translate(`generated.scheduledSession.${key}`, args);
const workspace = shallowRef<ScheduleScope>();
const workspaces = shallowRef<ScheduleWorkspaceOption[]>([]);
const rows = shallowRef<(ScheduleOccurrence & { key: string })[]>([]);
const page = ref(1);
const pageSize = ref(MANAGEMENT_DEFAULT_LIMIT);
const total = ref(0);
const hasMore = ref(false);
const unavailable = ref<string[]>([]);
const failure = shallowRef<{ error: unknown; retryPage: number; incremental: boolean }>();
const loading = ref(false);
let request: AbortController | undefined;
let refresh: ReturnType<typeof setTimeout> | undefined;

async function load(target: number, reset = false, incremental = props.mobile && target > 1) {
  if (!reset && loading.value) return;
  const append = props.mobile && target > 1;
  if (reset) clearTimeout(refresh);
  request?.abort();
  const read = new AbortController();
  request = read;
  loading.value = true;
  if (!incremental) failure.value = undefined;
  if (reset) {
    rows.value = [];
    page.value = 1;
    total.value = 0;
    hasMore.value = false;
    unavailable.value = [];
  }
  let requestPage = target;
  let appendPage = append;
  try {
    const filters = props.task
      ? { task: props.task }
      : workspace.value
        ? { workspace: workspace.value }
        : {};
    let result = await props.client.history({ ...filters, page: requestPage }, read.signal);
    if (read.signal.aborted) return;
    if (appendPage && result.page < target) {
      requestPage = 1;
      appendPage = false;
      if (result.page !== 1)
        result = await props.client.history({ ...filters, page: requestPage }, read.signal);
      if (read.signal.aborted) return;
    }
    const items = result.items.map((item) => ({
      ...item,
      key: JSON.stringify([item.nodeId, item.occurrenceId])
    }));
    if (appendPage) {
      const seen = new Set(rows.value.map((item) => item.key));
      rows.value = [...rows.value, ...items.filter((item) => !seen.has(item.key))];
    } else rows.value = items;
    if (result.workspaces) workspaces.value = result.workspaces;
    unavailable.value = result.unavailableNodeIds;
    page.value = result.page;
    pageSize.value = result.pageSize;
    total.value = result.total;
    hasMore.value = result.hasMore;
    failure.value = undefined;
  } catch (error) {
    if (!read.signal.aborted) {
      failure.value = { error, retryPage: requestPage, incremental };
    }
  } finally {
    if (!read.signal.aborted) loading.value = false;
  }
}

const reload = () => load(1, true);
const loadMore = () => {
  if (hasMore.value && !failure.value) void load(page.value + 1);
};
const retry = () => {
  if (failure.value) void load(failure.value.retryPage, false, failure.value.incremental);
};
const openRecord = (record: ScheduleOccurrence) => emit('open', record);
function openRow(record: ScheduleOccurrence, _column: unknown, event: MouseEvent) {
  // Give the detail view the same focus return target for pointer and keyboard entry.
  if (event.currentTarget instanceof Element) {
    event.currentTarget
      .closest('tr')
      ?.querySelector<HTMLButtonElement>('[data-history-record-trigger]')
      ?.focus({ preventScroll: true });
  }
  openRecord(record);
}
watch([workspace, () => props.mobile], reload, { immediate: true });
watch(
  () => props.invalidation,
  (change) => {
    if (!change || change.connectionOnly) return;
    const scope = props.task ?? workspace.value;
    if (scope && change.nodeId && scope.nodeId !== change.nodeId) return;
    if (scope && change.workspaceId && scope.workspaceId !== change.workspaceId) return;
    clearTimeout(refresh);
    refresh = setTimeout(reload, 120);
  }
);
onBeforeUnmount(() => {
  clearTimeout(refresh);
  request?.abort();
});
defineExpose({ reload });
</script>

<template>
  <div class="execution-history">
    <ScheduledWorkspaceFilter v-if="!task" v-model="workspace" :workspaces="workspaces" />
    <div class="mar-table-actions">
      <MarButton :icon="marIcon('refresh')" :disabled="loading" @click="reload()">{{
        msg('refresh')
      }}</MarButton>
    </div>
    <p v-if="unavailable.length" class="notice" role="status">
      {{ msg('partial', { count: unavailable.length }) }}
    </p>
    <p v-if="failure && !failure.incremental" class="notice" role="alert">
      {{ errorSummary(failure.error, msg('loadFailed')) }}
    </p>
    <div
      v-if="loading && !rows.length"
      class="mar-page-loading-state"
      role="progressbar"
      :aria-label="$t('common.loading')"
    >
      <MarBusyIndicator />
    </div>
    <MarTable
      v-else-if="rows.length || (!failure && !unavailable.length)"
      class="clickable-rows"
      :data="rows"
      row-key="key"
      :aria-label="msg('historyTable')"
      :aria-busy="loading"
      @row-click="openRow"
    >
      <MarTableColumn :label="task ? msg('dueAt') : msg('name')" :min-width="task ? 185 : 150">
        <template #default="{ row }">
          <MarButton link data-history-record-trigger @click.stop="openRecord(row)">{{
            task ? managementDateTime(row.dueAt) : (row.name ?? row.taskId)
          }}</MarButton>
        </template>
      </MarTableColumn>
      <MarTableColumn v-if="!task" :label="msg('node')" prop="nodeName" min-width="125" />
      <MarTableColumn v-if="!task" :label="msg('workspace')" prop="workspaceName" min-width="125" />
      <MarTableColumn v-if="!task" :label="msg('dueAt')" min-width="185">
        <template #default="{ row }">{{ managementDateTime(row.dueAt) }}</template>
      </MarTableColumn>
      <MarTableColumn :label="msg('historyStatus')" min-width="108">
        <template #default="{ row }"
          ><MarTag>{{ msg(`state.${row.state}`) }}</MarTag></template
        >
      </MarTableColumn>
      <template #empty>{{ msg('emptyHistory') }}</template>
    </MarTable>
    <ManagementPagination
      v-if="rows.length || (!loading && !failure && !unavailable.length)"
      :page="page"
      :page-size="pageSize"
      :total="total"
      :mobile="mobile"
      :mobile-visible-count="rows.length"
      :loading="loading"
      :loading-more="mobile && rows.length > 0"
      :failed="failure !== undefined"
      :incremental-failed="failure?.incremental === true"
      :error="failure?.error"
      :has-more="hasMore"
      :context-key="JSON.stringify([workspace, mobile])"
      @page="load"
      @load-more="loadMore"
      @retry="retry"
    />
  </div>
</template>

<style scoped>
.execution-history {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.75rem;
  min-width: 0;
  justify-items: stretch;
}
.notice {
  margin: 0;
  color: var(--mar-text-secondary);
}
.clickable-rows :deep(.mar-ui-table__row) {
  cursor: pointer;
}
</style>
