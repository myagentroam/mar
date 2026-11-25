<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  shallowRef,
  useId,
  useTemplateRef,
  watch
} from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarDescriptions, MarDescriptionsItem } from '@myagentroam/mar-ui/descriptions';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { marIcon } from '@myagentroam/mar-ui/icons';
import { MarTag } from '@myagentroam/mar-ui/tag';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import { MANAGEMENT_DEFAULT_LIMIT } from '@myagentroam/protocol';
import { errorCode } from '../../util/api-error.js';
import { errorSummary } from '../../util/error-presentation.js';
import { managementDateTime } from '../../util/time-presentation.js';
import { runStatusLabel } from '../../util/session-presentation.js';
import { translate } from '../../service/locale-preference-service.js';
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import {
  scheduledTaskClient,
  type ScheduleCard,
  type ScheduleDetail,
  type ScheduleInvalidation,
  type ScheduleNode,
  type ScheduleOccurrence,
  type ScheduleOccurrenceDetail,
  type ScheduleRequest,
  type ScheduleRunReceipt,
  type ScheduleScope,
  type ScheduleSessionScope,
  type ScheduleTaskKey,
  type ScheduleTaskLink,
  type ScheduleWorkspaceOption
} from '../../service/scheduled-task-client.js';
import ScheduledTaskCard from './ScheduledTaskCard.vue';
import ScheduledTaskEditor from './ScheduledTaskEditor.vue';
import ScheduledExecutionHistory from './ScheduledExecutionHistory.vue';
import ScheduledWorkspaceFilter from './ScheduledWorkspaceFilter.vue';
import ManagementPagination from '../settings/ManagementPagination.vue';
import type { ScheduleSection, ScheduleSessionContext } from './scheduled-task-navigation.js';

// Owns task cards and modal selection. History owns its paged reads; the editor owns its draft.
const props = defineProps<{
  request: ScheduleRequest;
  section: ScheduleSection;
  mobile?: boolean;
  session?: ScheduleSessionContext | undefined;
  linkedTask?: ScheduleTaskLink | undefined;
  invalidation?: ScheduleInvalidation | undefined;
}>();
const emit = defineEmits<{
  openTarget: [target: ScheduleSessionScope & { runId?: string }];
  backToAll: [];
}>();
const client = scheduledTaskClient(props.request);
const panelTitleId = useId();
const msg = (key: string, args?: Record<string, number | string>) =>
  translate(`generated.scheduledSession.${key}`, args);
const sessionContext = computed(() => (props.section === 'history' ? undefined : props.session));
const sessionScope = computed(() => sessionContext.value?.scope);
const title = computed(() => msg(sessionContext.value ? 'sessionTitle' : props.section));
const summary = computed(() =>
  sessionContext.value
    ? msg('currentSession', { name: sessionContext.value.title })
    : msg(`${props.section}Summary`)
);
const tasks = ref<ScheduleCard[]>([]);
const globalNodes = shallowRef<ScheduleNode[]>();
const sessionNodes = shallowRef<{ scope: ScheduleSessionScope; nodes: ScheduleNode[] }>();
const nodes = computed(() => {
  const scope = sessionScope.value;
  if (!scope) return globalNodes.value;
  const confirmed = sessionNodes.value;
  return confirmed?.scope === scope ? confirmed.nodes : undefined;
});
const canCreate = computed(
  () => nodes.value?.some((node) => node.connected && node.supported !== false) === true
);
const workspace = shallowRef<ScheduleScope>();
const workspaces = shallowRef<ScheduleWorkspaceOption[]>([]);
const page = ref(1);
const pageSize = ref(MANAGEMENT_DEFAULT_LIMIT);
const total = ref(0);
const hasMore = ref(false);
const failure = shallowRef<{ error: unknown; page: number; incremental: boolean }>();
const loading = ref(false);
const listComplete = computed(() => !loading.value && !failure.value);
const selectedTask = shallowRef<ScheduleTaskKey>();
const taskHistory = shallowRef<ScheduleTaskKey & { name: string }>();
const historyView = useTemplateRef('historyView');
const detailBody = ref<HTMLElement>();
let historyRow: HTMLElement | undefined;
type OccurrenceKey = Pick<ScheduleOccurrence, 'nodeId' | 'workspaceId' | 'taskId' | 'occurrenceId'>;
const selectedOccurrence = shallowRef<OccurrenceKey>();
const occurrence = shallowRef<ScheduleOccurrenceDetail>();
const detailFailure = shallowRef<unknown>();
const detailLoading = ref(false);
const runReceipt = shallowRef<ScheduleRunReceipt>();
const editor = shallowRef<
  | {
      key: ScheduleTaskKey;
      detail: ScheduleDetail;
      mode: 'view' | 'edit';
      sessionTitle?: string;
      invoker?: HTMLElement;
    }
  | 'new'
>();
let listRead: AbortController | undefined;
let detailRead: AbortController | undefined;
let refresh: ReturnType<typeof setTimeout> | undefined;
const identity = ({ nodeId, workspaceId, id }: ScheduleTaskKey) =>
  JSON.stringify([nodeId, workspaceId, id]);
const context = computed(() =>
  JSON.stringify([props.section, sessionScope.value ?? workspace.value, props.mobile === true])
);
const date = (time: number | null) =>
  time === null ? msg('notRecorded') : managementDateTime(time);

async function load(next: number, reset = false, incremental = props.mobile === true && next > 1) {
  if (props.section === 'history') return;
  if (!reset && loading.value) return;
  if (reset) cancelRefresh();
  listRead?.abort();
  const read = new AbortController();
  listRead = read;
  loading.value = true;
  if (!incremental) failure.value = undefined;
  if (reset) {
    tasks.value = [];
    page.value = 1;
    total.value = 0;
    hasMore.value = false;
  }
  const fixedSession = sessionScope.value;
  const target = fixedSession ?? workspace.value;
  const filters = { mine: props.section === 'mine', ...(target ? { target } : {}) };
  const readContext = context.value;
  const current = () => !read.signal.aborted && readContext === context.value;
  let requestPage = next;
  let append = props.mobile === true && next > 1;
  try {
    let result = await client.list({ ...filters, page: requestPage }, read.signal);
    if (!current()) return;
    if (append && result.page < requestPage) {
      requestPage = 1;
      append = false;
      if (result.page !== 1) result = await client.list({ ...filters, page: 1 }, read.signal);
      if (!current()) return;
    }
    if (append) {
      const seen = new Set(tasks.value.map(identity));
      tasks.value = [...tasks.value, ...result.items.filter((task) => !seen.has(identity(task)))];
    } else tasks.value = result.items;
    if (fixedSession) sessionNodes.value = { scope: fixedSession, nodes: result.nodes };
    else if (!target) globalNodes.value = result.nodes;
    if (result.workspaces) workspaces.value = result.workspaces;
    page.value = result.page;
    pageSize.value = result.pageSize;
    total.value = result.total;
    hasMore.value = result.hasMore;
    failure.value = undefined;
  } catch (error) {
    if (current()) failure.value = { error, page: requestPage, incremental };
  } finally {
    if (current()) loading.value = false;
  }
}
const reload = () => load(1, true);
const loadMore = () => {
  if (hasMore.value && !failure.value) void load(page.value + 1);
};
const retry = () => {
  if (failure.value) void load(failure.value.page, false, failure.value.incremental);
};
function resetDetail() {
  detailRead?.abort();
  selectedTask.value = undefined;
  selectedOccurrence.value = undefined;
  occurrence.value = undefined;
  detailFailure.value = undefined;
  detailLoading.value = false;
  runReceipt.value = undefined;
  editor.value = undefined;
}
function closeDetail() {
  resetDetail();
  taskHistory.value = undefined;
  historyRow = undefined;
}
watch(
  [() => props.section, sessionScope, workspace],
  () => {
    closeDetail();
    cancelRefresh();
    listRead?.abort();
    if (props.section === 'history') loading.value = false;
    else void reload();
  },
  { immediate: true }
);
watch(() => props.mobile === true, reload);
watch(
  () => props.invalidation,
  (change) => {
    if (!change) return;
    const matches = (scope: ScheduleScope) =>
      (!change.nodeId || change.nodeId === scope.nodeId) &&
      (!change.workspaceId || change.workspaceId === scope.workspaceId);
    const open =
      selectedTask.value ??
      selectedOccurrence.value ??
      taskHistory.value ??
      (editor.value === 'new' ? sessionScope.value : editor.value?.key);
    // Dialogs follow their target scope, independently of the current list filter.
    if (change.verify && open && matches(open)) closeDetail();
    const bound = sessionScope.value ?? workspace.value;
    if (props.section === 'history' || (bound && !matches(bound))) return;
    cancelRefresh();
    refresh = setTimeout(reload, 120);
  }
);
function cancelRefresh() {
  clearTimeout(refresh);
  refresh = undefined;
}
onBeforeUnmount(() => {
  cancelRefresh();
  listRead?.abort();
  detailRead?.abort();
});

async function openTask(
  key: ScheduleTaskKey & Partial<Pick<ScheduleCard, 'sessionId' | 'sessionTitle'>>,
  mode: 'view' | 'edit',
  proposalId?: string
) {
  const { sessionId, sessionTitle } = key;
  const active = globalThis.document?.activeElement;
  const invoker =
    active && active instanceof HTMLElement && active !== active.ownerDocument.body
      ? active
      : undefined;
  closeDetail();
  selectedTask.value = key;
  const read = new AbortController();
  detailRead = read;
  detailLoading.value = true;
  try {
    let detail = await client.detail(key, read.signal);
    if (!read.signal.aborted) {
      if (proposalId !== undefined) {
        const proposal = detail.proposals.find((item) => item.id === proposalId);
        if (proposal === undefined) throw new Error('SCHEDULE_NOT_FOUND');
        detail = { ...detail, proposals: [proposal] };
      }
      selectedTask.value = undefined;
      editor.value = {
        key,
        detail,
        mode,
        ...(sessionId && sessionId === detail.task.sessionId && sessionTitle
          ? { sessionTitle }
          : {}),
        ...(invoker ? { invoker } : {})
      };
    }
  } catch (error) {
    if (!read.signal.aborted) {
      detailFailure.value = error;
      if (errorCode(error) === 'SCHEDULE_NOT_FOUND' || errorCode(error) === 'WORKSPACE_NOT_FOUND')
        void reload();
    }
  } finally {
    if (!read.signal.aborted) detailLoading.value = false;
  }
}
function closeEditor() {
  const invoker = editor.value === 'new' ? undefined : editor.value?.invoker;
  closeDetail();
  // The loading and loaded dialogs are different layers, so restore the original invoker.
  if (invoker) void nextTick(() => invoker.isConnected && invoker.focus({ preventScroll: true }));
}
async function openOccurrence(item: OccurrenceKey) {
  resetDetail();
  if (taskHistory.value && document.activeElement instanceof HTMLElement)
    historyRow = document.activeElement;
  selectedOccurrence.value = item;
  const read = new AbortController();
  detailRead = read;
  detailLoading.value = true;
  if (taskHistory.value) void nextTick(() => detailBody.value?.focus());
  try {
    const result = await client.occurrence(item, read.signal);
    if (read.signal.aborted) return;
    if (result.taskId !== item.taskId) throw new Error('SCHEDULE_NOT_FOUND');
    occurrence.value = result;
    if (result.run !== null) {
      const receipt = await client.runReceipt(item, result.run, read.signal);
      if (!read.signal.aborted) runReceipt.value = receipt;
    }
  } catch (error) {
    if (!read.signal.aborted) {
      detailFailure.value = error;
      if (errorCode(error) === 'SCHEDULE_NOT_FOUND' || errorCode(error) === 'WORKSPACE_NOT_FOUND')
        void historyView.value?.reload();
    }
  } finally {
    if (!read.signal.aborted) detailLoading.value = false;
  }
}
function openRun() {
  const item = selectedOccurrence.value;
  const run = occurrence.value?.run;
  if (item && run && runReceipt.value)
    emit('openTarget', { nodeId: item.nodeId, workspaceId: item.workspaceId, ...run });
}
function openTaskHistory({ nodeId, workspaceId, id, name }: ScheduleCard) {
  closeDetail();
  taskHistory.value = { nodeId, workspaceId, id, name };
}
function backToTaskHistory() {
  resetDetail();
  const row = historyRow;
  historyRow = undefined;
  void nextTick(() => {
    if (row?.isConnected) row.focus();
    else detailBody.value?.focus();
  });
}
function reasonLabel(code: string): string {
  const key = `errors.${code}`;
  const localized = translate(key);
  return localized === key ? msg('reasonUnavailable') : localized;
}
function changed() {
  closeDetail();
  void reload();
}
watch(
  () => props.linkedTask,
  (task) => {
    if (!task) return;
    if (task.reference.kind === 'proposal') void openTask(task, 'edit', task.reference.id);
    else
      void openOccurrence({
        nodeId: task.nodeId,
        workspaceId: task.workspaceId,
        taskId: task.id,
        occurrenceId: task.reference.id
      });
  },
  { immediate: true }
);
</script>

<template>
  <section
    class="mar-management-page schedule-panel"
    :class="{ 'schedule-panel--tasks': section !== 'history' }"
    :aria-labelledby="panelTitleId"
  >
    <header>
      <h2 :id="panelTitleId" class="mar-settings-page-title">{{ title }}</h2>
      <p class="mar-settings-page-summary">{{ summary }}</p>
    </header>
    <ScheduledExecutionHistory
      v-if="section === 'history'"
      ref="historyView"
      :client="client"
      :mobile="mobile === true"
      :invalidation="invalidation"
      @open="openOccurrence"
    />
    <template v-else>
      <div class="mar-table-actions schedule-toolbar">
        <ScheduledWorkspaceFilter
          v-if="!sessionContext"
          v-model="workspace"
          :workspaces="workspaces"
        />
        <MarButton
          v-if="sessionContext"
          :icon="marIcon('chevron-left')"
          @click="emit('backToAll')"
          >{{ msg('backToAll') }}</MarButton
        >
        <MarButton text :icon="marIcon('refresh')" :disabled="loading" @click="reload()">{{
          msg('refresh')
        }}</MarButton>
        <div class="schedule-create" :class="{ 'schedule-create--pending': nodes === undefined }">
          <MarButton
            type="primary"
            :icon="marIcon('plus')"
            :disabled="!canCreate"
            @click="editor = 'new'"
            >{{ msg('create') }}</MarButton
          >
        </div>
      </div>
      <p v-if="failure && !failure.incremental" role="alert" class="notice">
        {{ errorSummary(failure.error, msg('loadFailed')) }}
      </p>
      <div
        v-if="loading && !tasks.length"
        class="mar-page-loading-state"
        role="progressbar"
        :aria-label="$t('common.loading')"
      >
        <MarBusyIndicator />
      </div>
      <template v-else>
        <p v-if="!tasks.length && listComplete" class="panel-empty">
          {{ msg(sessionContext ? 'emptySessionTasks' : 'emptyTasks') }}
        </p>
        <ul v-else-if="tasks.length" class="cards" :aria-label="msg('tasks')" :aria-busy="loading">
          <ScheduledTaskCard
            v-for="item in tasks"
            :key="identity(item)"
            :task="item"
            @details="openTask(item, 'view')"
            @edit="openTask(item, 'edit')"
            @history="openTaskHistory(item)"
            @open-target="emit('openTarget', $event)"
          />
        </ul>
      </template>
      <ManagementPagination
        v-if="tasks.length"
        class="schedule-pagination"
        :page="page"
        :page-size="pageSize"
        :total="total"
        :mobile="mobile === true"
        :mobile-visible-count="tasks.length"
        :loading="loading"
        :loading-more="mobile === true"
        :failed="failure !== undefined"
        :incremental-failed="failure?.incremental === true"
        :error="failure?.error"
        :has-more="hasMore"
        :context-key="context"
        @page="load"
        @load-more="loadMore"
        @retry="retry"
      />
    </template>
    <ScheduledTaskEditor
      v-if="editor"
      :client="client"
      :nodes="nodes ?? []"
      :locked-session="editor === 'new' ? sessionContext : undefined"
      :editing="editor === 'new' ? undefined : editor"
      @close="closeEditor"
      @changed="changed"
    />
    <MarDialog
      v-if="selectedTask || selectedOccurrence || taskHistory"
      :model-value="true"
      :title="selectedOccurrence ? msg('occurrence') : taskHistory ? msg('history') : msg('title')"
      width="min(720px, calc(100vw - 32px))"
      @update:model-value="(open) => !open && closeDetail()"
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
    >
      <div ref="detailBody" tabindex="-1">
        <section v-if="taskHistory" v-show="!selectedOccurrence">
          <h3 class="history-task-title">{{ taskHistory.name }}</h3>
          <ScheduledExecutionHistory
            ref="historyView"
            :client="client"
            :mobile="mobile === true"
            :task="taskHistory"
            :invalidation="invalidation"
            @open="openOccurrence"
          />
        </section>
        <p v-if="detailFailure" role="alert">
          {{ errorSummary(detailFailure, msg('loadFailed')) }}
        </p>
        <div
          v-else-if="detailLoading"
          class="mar-page-loading-state"
          role="progressbar"
          :aria-label="$t('common.loading')"
        >
          <MarBusyIndicator />
        </div>
        <template v-else-if="occurrence">
          <h3>{{ occurrence.name ?? occurrence.taskId }}</h3>
          <MarTag>{{ msg(`state.${occurrence.state}`) }}</MarTag>
          <MarDescriptions class="occurrence-facts" :column="1" border>
            <MarDescriptionsItem :label="msg('dueAt')">{{
              date(occurrence.dueAt)
            }}</MarDescriptionsItem>
            <MarDescriptionsItem :label="msg('actualStart')">{{
              date(occurrence.startedAt)
            }}</MarDescriptionsItem>
            <MarDescriptionsItem :label="msg('actualEnd')">{{
              date(occurrence.endedAt)
            }}</MarDescriptionsItem>
            <MarDescriptionsItem
              v-if="occurrence.startedAt !== null && occurrence.endedAt !== null"
              :label="msg('duration')"
            >
              {{
                msg('seconds', {
                  count: Math.max(0, Math.round((occurrence.endedAt - occurrence.startedAt) / 1000))
                })
              }}
            </MarDescriptionsItem>
            <MarDescriptionsItem v-if="occurrence.reason" :label="msg('reason')">
              {{ reasonLabel(occurrence.reason) }}
            </MarDescriptionsItem>
            <MarDescriptionsItem v-if="runReceipt" :label="msg('originalRun')">
              {{ runStatusLabel(runReceipt.status) }} · <code>{{ runReceipt.id }}</code>
            </MarDescriptionsItem>
          </MarDescriptions>
          <h4>{{ msg('promptSnapshot') }}</h4>
          <p class="snapshot">{{ occurrence.snapshot?.objective ?? msg('notRecorded') }}</p>
        </template>
      </div>
      <template #footer>
        <MarButton v-if="taskHistory && selectedOccurrence" @click="backToTaskHistory">{{
          msg('backToHistory')
        }}</MarButton>
        <MarButton v-if="runReceipt" type="primary" @click="openRun">{{
          msg('openRun')
        }}</MarButton>
        <MarButton @click="closeDetail">{{ msg('close') }}</MarButton>
      </template>
    </MarDialog>
  </section>
</template>

<style scoped>
.schedule-panel > header {
  display: block;
}
.schedule-panel {
  color: var(--mar-text-primary);
}
.schedule-panel--tasks {
  background: var(--mar-bg-page);
}
.schedule-panel--tasks > header {
  flex-direction: column;
  gap: 0.25rem;
}
.schedule-panel--tasks .mar-settings-page-title {
  font-size: var(--mar-font-size-page-title);
}
.schedule-panel--tasks .mar-settings-page-summary {
  margin-block-start: 0;
}
.schedule-panel--tasks
  > :is(
    header,
    .schedule-toolbar,
    .cards,
    .notice,
    .panel-empty,
    .schedule-pagination,
    .mar-page-loading-state
  ) {
  max-inline-size: 1560px;
}
.schedule-create {
  margin-inline-start: auto;
}
.schedule-create--pending {
  visibility: hidden;
}
.schedule-panel--tasks .schedule-pagination {
  background: transparent;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr));
  gap: 1rem;
  padding: 0;
  margin: 0;
  list-style: none;
}
.occurrence-facts {
  margin: 0.75rem 0;
}
.history-task-title {
  margin: 0 0 0.75rem;
  overflow-wrap: anywhere;
}
.notice,
.panel-empty {
  margin: 0;
  color: var(--mar-text-secondary);
}
.snapshot {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
