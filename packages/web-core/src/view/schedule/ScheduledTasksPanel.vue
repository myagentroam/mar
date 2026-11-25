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
  type ScheduleSessionScope,
  type ScheduleTaskKey,
  type ScheduleTaskLink
} from '../../service/scheduled-task-client.js';
import ScheduledTaskEditor from './ScheduledTaskEditor.vue';
import ScheduledExecutionHistory from './ScheduledExecutionHistory.vue';
import type { ScheduleSection } from './scheduled-task-navigation.js';

// Owns task cards and modal selection. History owns its paged reads; the editor owns its draft.
const props = defineProps<{
  request: ScheduleRequest;
  section: ScheduleSection;
  mobile?: boolean;
  initial?: ScheduleSessionScope | undefined;
  linkedTask?: ScheduleTaskLink | undefined;
  invalidation?: ScheduleInvalidation | undefined;
}>();
const emit = defineEmits<{
  openRun: [target: ScheduleSessionScope & { runId: string }];
}>();
const client = scheduledTaskClient(props.request);
const panelTitleId = useId();
const msg = (key: string, args?: Record<string, number | string>) =>
  translate(`generated.scheduledSession.${key}`, args);
const tasks = ref<ScheduleCard[]>([]);
const nodes = ref<ScheduleNode[]>([]);
const cursor = ref<string | null>(null);
const unavailable = ref<string[]>([]);
const failure = shallowRef<unknown>();
const loading = ref(false);
const listComplete = computed(() => !loading.value && !failure.value && !unavailable.value.length);
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
const editor = shallowRef<{ key: ScheduleTaskKey; detail: ScheduleDetail } | 'new'>();
let listRead: AbortController | undefined;
let detailRead: AbortController | undefined;
let refresh: ReturnType<typeof setTimeout> | undefined;
const identity = (nodeId: string, id: string) => JSON.stringify([nodeId, id]);
const date = (time: number | null) =>
  time === null ? msg('notRecorded') : managementDateTime(time);
const cardState = (item: ScheduleCard) =>
  item.targetKind === 'unbound'
    ? 'unbound'
    : !item.enabled
      ? 'paused'
      : item.nextRunAt === null
        ? 'finished'
        : 'enabled';

async function load(next?: string) {
  if (props.section === 'history') return;
  if (!next) cancelRefresh();
  listRead?.abort();
  const read = new AbortController();
  listRead = read;
  loading.value = true;
  failure.value = undefined;
  if (!next) {
    tasks.value = [];
    cursor.value = null;
    unavailable.value = [];
  }
  try {
    const result = await client.list(
      {
        mine: props.section === 'mine',
        ...(next === undefined ? {} : { cursor: next }),
        ...(props.initial ? { session: props.initial } : {})
      },
      read.signal
    );
    if (read.signal.aborted) return;
    tasks.value = next ? [...tasks.value, ...result.items] : result.items;
    nodes.value = result.nodes;
    unavailable.value = result.unavailableNodeIds;
    cursor.value = result.nextCursor;
  } catch (error) {
    if (!read.signal.aborted) failure.value = error;
  } finally {
    if (!read.signal.aborted) loading.value = false;
  }
}
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
  () => props.section,
  () => {
    closeDetail();
    cancelRefresh();
    listRead?.abort();
    void load();
  },
  { immediate: true }
);
watch(
  () => props.invalidation,
  (change) => {
    const bound = props.section === 'history' ? undefined : props.initial;
    if (
      !change ||
      (bound &&
        ((change.nodeId && change.nodeId !== bound.nodeId) ||
          (change.workspaceId && change.workspaceId !== bound.workspaceId)))
    )
      return;
    const open =
      selectedTask.value ??
      selectedOccurrence.value ??
      taskHistory.value ??
      (typeof editor.value === 'object' ? editor.value.key : undefined);
    if (
      change.verify &&
      open &&
      (!change.nodeId || change.nodeId === open.nodeId) &&
      (!change.workspaceId || change.workspaceId === open.workspaceId)
    )
      closeDetail();
    if (props.section === 'history') return;
    cancelRefresh();
    refresh = setTimeout(() => void load(), 120);
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

async function openTask(key: ScheduleTaskKey, proposalId?: string) {
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
      editor.value = { key, detail };
    }
  } catch (error) {
    if (!read.signal.aborted) {
      detailFailure.value = error;
      if (errorCode(error) === 'SCHEDULE_NOT_FOUND' || errorCode(error) === 'WORKSPACE_NOT_FOUND')
        void load();
    }
  } finally {
    if (!read.signal.aborted) detailLoading.value = false;
  }
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
    emit('openRun', { nodeId: item.nodeId, workspaceId: item.workspaceId, ...run });
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
  void load();
}
watch(
  () => props.linkedTask,
  (task) => {
    if (!task) return;
    if (task.reference.kind === 'proposal') void openTask(task, task.reference.id);
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
  <section class="mar-management-page schedule-panel" :aria-labelledby="panelTitleId">
    <header>
      <h2 :id="panelTitleId">{{ msg(section === 'history' ? 'history' : 'panelTitle') }}</h2>
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
      <div class="mar-table-actions">
        <MarButton :icon="marIcon('refresh')" :disabled="loading" @click="load()">{{
          msg('refresh')
        }}</MarButton>
        <MarButton
          type="primary"
          :icon="marIcon('plus')"
          :disabled="nodes.length === 0"
          @click="editor = 'new'"
          >{{ msg('create') }}</MarButton
        >
      </div>
      <p v-if="unavailable.length" role="status" class="notice">
        {{ msg('partial', { count: unavailable.length }) }}
      </p>
      <p v-if="failure" role="alert" class="notice">
        {{ errorSummary(failure, msg('loadFailed')) }}
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
        <p v-if="!tasks.length && listComplete" class="panel-empty">{{ msg('emptyTasks') }}</p>
        <ul v-else-if="tasks.length" class="cards" :aria-label="msg('tasks')">
          <li v-for="item in tasks" :key="identity(item.nodeId, item.id)" class="card">
            <div class="card-heading">
              <h3>
                <MarButton v-if="!item.mine && !item.offline" link @click="openTask(item)">{{
                  item.name
                }}</MarButton>
                <template v-else>{{ item.name }}</template>
              </h3>
              <MarTag :type="cardState(item) === 'enabled' ? 'success' : 'info'">{{
                msg(item.offline ? 'offline' : cardState(item))
              }}</MarTag>
            </div>
            <p class="secondary">{{ item.nodeName }} · {{ item.workspaceName }}</p>
            <p>
              {{
                item.sessionTitle ??
                item.sessionId ??
                msg(item.targetKind === 'newSession' ? 'newSession' : 'unbound')
              }}
            </p>
            <p v-if="item.objectivePreview" class="objective">{{ item.objectivePreview }}</p>
            <dl>
              <div>
                <dt>{{ msg('owner') }}</dt>
                <dd>{{ item.ownerName ?? msg('notRecorded') }}</dd>
              </div>
              <div>
                <dt>{{ msg('nextRun') }}</dt>
                <dd>{{ item.nextRunAt === null ? msg('noUpcoming') : date(item.nextRunAt) }}</dd>
              </div>
              <div v-if="item.offline && item.syncedAt">
                <dt>{{ msg('lastSynced') }}</dt>
                <dd>{{ date(item.syncedAt) }}</dd>
              </div>
            </dl>
            <div class="mar-row-actions mar-row-actions--wrap">
              <MarButton
                v-if="item.mine"
                link
                :disabled="item.offline === true"
                :icon="marIcon('edit')"
                @click="openTask(item)"
                >{{ msg('editTask') }}</MarButton
              >
              <MarButton
                link
                :disabled="item.offline === true"
                :icon="marIcon('clock')"
                @click="openTaskHistory(item)"
                >{{ msg('history') }}</MarButton
              >
            </div>
          </li>
        </ul>
      </template>
      <MarButton
        v-if="cursor"
        :loading="loading"
        :disabled="loading"
        class="more"
        @click="load(cursor)"
        >{{ msg('more') }}</MarButton
      >
    </template>
    <ScheduledTaskEditor
      v-if="editor"
      :client="client"
      :nodes="nodes"
      :initial="initial"
      :editing="editor === 'new' ? undefined : editor"
      @close="closeDetail"
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
.schedule-panel {
  color: var(--mar-text-primary);
}
.card-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.secondary {
  color: var(--mar-text-secondary);
}
p {
  margin: 0.375rem 0;
}
ul {
  padding: 0;
  margin: 0;
  list-style: none;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 18rem), 1fr));
  gap: 0.75rem;
}
.card {
  min-width: 0;
  border: 1px solid var(--mar-border-default);
  border-radius: var(--mar-radius-control);
  padding: 1rem;
  overflow-wrap: anywhere;
}
.card-heading {
  flex-wrap: nowrap;
  align-items: flex-start;
}
.card-heading h3 {
  min-width: 0;
  margin: 0;
}
.card-heading h3 :deep(button) {
  font-size: inherit;
  font-weight: inherit;
  white-space: normal;
  text-align: start;
}
.card-heading h3 :deep(button:enabled) {
  color: var(--mar-text-primary);
}
.objective {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card dl,
.occurrence-facts {
  margin: 0.75rem 0;
}
.card dl div {
  display: flex;
  gap: 0.5rem;
  justify-content: space-between;
  margin: 0.375rem 0;
}
.card dt {
  color: var(--mar-text-secondary);
}
.card dd {
  margin: 0;
  text-align: end;
}
.history-task-title {
  margin: 0 0 0.75rem;
  overflow-wrap: anywhere;
}
.more {
  align-self: start;
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
