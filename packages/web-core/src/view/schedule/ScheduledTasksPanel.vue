<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue';
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
import type { ScheduleHistoryTask, ScheduleSection } from './scheduled-task-navigation.js';

// This panel owns the current read scope, cursor and selected resource; the editor owns its draft.
const props = defineProps<{
  request: ScheduleRequest;
  section: ScheduleSection;
  historyTask?: ScheduleHistoryTask | undefined;
  initial?: ScheduleSessionScope | undefined;
  linkedTask?: ScheduleTaskLink | undefined;
  invalidation?: { nodeId?: string; workspaceId?: string; verify?: boolean } | undefined;
}>();
const emit = defineEmits<{
  showHistory: [task?: ScheduleHistoryTask];
  openRun: [target: ScheduleSessionScope & { runId: string }];
}>();
const client = scheduledTaskClient(props.request);
const panelTitleId = useId();
const msg = (key: string, args?: Record<string, number | string>) =>
  translate(`generated.scheduledSession.${key}`, args);
const tasks = ref<ScheduleCard[]>([]);
const nodes = ref<ScheduleNode[]>([]);
const occurrences = ref<ScheduleOccurrence[]>([]);
const cursor = ref<string | null>(null);
const unavailable = ref<string[]>([]);
const failure = shallowRef<unknown>();
const loading = ref(false);
const listComplete = computed(() => !loading.value && !failure.value && !unavailable.value.length);
const selectedTask = shallowRef<ScheduleTaskKey>();
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
  if (!next) cancelRefresh();
  listRead?.abort();
  const read = new AbortController();
  listRead = read;
  loading.value = true;
  failure.value = undefined;
  if (!next) {
    tasks.value = [];
    occurrences.value = [];
    cursor.value = null;
    unavailable.value = [];
  }
  try {
    const filters = {
      mine: props.section === 'mine',
      ...(next === undefined ? {} : { cursor: next })
    };
    if (props.section !== 'history') {
      const result = await client.list(
        {
          ...filters,
          ...(props.initial ? { session: props.initial } : {})
        },
        read.signal
      );
      if (read.signal.aborted) return;
      tasks.value = next ? [...tasks.value, ...result.items] : result.items;
      nodes.value = result.nodes;
      unavailable.value = result.unavailableNodeIds;
      cursor.value = result.nextCursor;
    } else {
      const result = await client.history(
        {
          ...filters,
          ...(props.historyTask ? { task: props.historyTask } : {}),
          ...(props.initial ? { session: props.initial } : {})
        },
        read.signal
      );
      if (read.signal.aborted) return;
      occurrences.value = next ? [...occurrences.value, ...result.items] : result.items;
      unavailable.value = result.unavailableNodeIds;
      cursor.value = result.nextCursor;
    }
  } catch (error) {
    if (!read.signal.aborted) failure.value = error;
  } finally {
    if (!read.signal.aborted) loading.value = false;
  }
}
function closeDetail() {
  detailRead?.abort();
  selectedTask.value = undefined;
  selectedOccurrence.value = undefined;
  occurrence.value = undefined;
  detailFailure.value = undefined;
  detailLoading.value = false;
  runReceipt.value = undefined;
  editor.value = undefined;
}
watch(
  [() => props.section, () => props.historyTask],
  () => {
    closeDetail();
    void load();
  },
  { immediate: true }
);
watch(
  () => props.invalidation,
  (change) => {
    const bound = props.historyTask ?? props.initial;
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
      (typeof editor.value === 'object' ? editor.value.key : undefined);
    if (change.verify && open && (!change.nodeId || change.nodeId === open.nodeId)) closeDetail();
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
  closeDetail();
  selectedOccurrence.value = item;
  const read = new AbortController();
  detailRead = read;
  detailLoading.value = true;
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
        void load();
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
function showTaskHistory({ nodeId, workspaceId, id, name }: ScheduleCard) {
  emit('showHistory', { nodeId, workspaceId, id, name });
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
      <h2 :id="panelTitleId">{{ msg('panelTitle') }}</h2>
    </header>
    <div class="mar-table-actions">
      <MarButton :icon="marIcon('refresh')" :disabled="loading" @click="load()">{{
        msg('refresh')
      }}</MarButton>
      <MarButton
        v-if="section !== 'history'"
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
    <p v-if="failure" role="alert" class="notice">{{ errorSummary(failure, msg('loadFailed')) }}</p>
    <template v-if="section !== 'history'">
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
                <MarButton link :disabled="item.offline === true" @click="openTask(item)">{{
                  item.name
                }}</MarButton>
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
            <MarButton
              link
              :disabled="item.offline === true"
              :icon="marIcon('clock')"
              @click="showTaskHistory(item)"
              >{{ msg('history') }}</MarButton
            >
          </li>
        </ul>
      </template>
    </template>
    <template v-else>
      <div v-if="historyTask" class="history-filter">
        <strong>{{ historyTask.name }}</strong>
        <MarButton link @click="emit('showHistory')">{{ msg('clearTask') }}</MarButton>
      </div>
      <div
        v-if="loading && !occurrences.length"
        class="mar-page-loading-state"
        role="progressbar"
        :aria-label="$t('common.loading')"
      >
        <MarBusyIndicator />
      </div>
      <p v-else-if="!occurrences.length && listComplete" class="panel-empty">
        {{ msg('emptyHistory') }}
      </p>
      <ul v-else-if="occurrences.length" class="history">
        <li v-for="item in occurrences" :key="identity(item.nodeId, item.occurrenceId)">
          <span
            ><MarButton link @click="openOccurrence(item)">{{ item.name ?? item.taskId }}</MarButton
            ><small>{{ date(item.dueAt) }}</small></span
          >
          <MarTag>{{ msg(`state.${item.state}`) }}</MarTag>
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
      v-if="selectedTask || selectedOccurrence"
      :model-value="true"
      :title="selectedOccurrence ? msg('occurrence') : msg('title')"
      width="min(720px, calc(100vw - 32px))"
      @update:model-value="(open) => !open && closeDetail()"
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
    >
      <p v-if="detailFailure" role="alert">{{ errorSummary(detailFailure, msg('loadFailed')) }}</p>
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
      <template #footer>
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
.card-heading,
.history-filter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.secondary,
.history small {
  color: var(--mar-text-secondary);
}
p {
  margin: 0.375rem 0;
}
.history li {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  padding: 0.375rem 0;
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
.history li {
  justify-content: space-between;
  border-bottom: 1px solid var(--mar-border-default);
}
.history small {
  display: block;
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
