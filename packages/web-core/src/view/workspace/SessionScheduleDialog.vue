<script setup lang="ts">
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import { errorMessage } from '../../util/error-presentation.js';
import { showMessage } from '../../service/message-feedback-service.js';

import { marIcon } from '../../util/mar-icons.js';
import { managementDateTime } from '../../util/time-presentation.js';
import { type FormInstance, type FormRules } from 'element-plus';
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import type { Session } from '../../model/workbench.js';
import { translate } from '../../service/locale-preference-service.js';

interface Task {
  readonly id: string;
  readonly objective: string;
  readonly cron: string;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly ownerUserId: number;
  readonly notifyOnTerminal: boolean;
  readonly revision: number;
  readonly nextRunAt: number | null;
}
interface Occurrence {
  readonly id: string;
  readonly due_at: number;
  readonly status: string;
  readonly code: string | null;
}
interface Proposal {
  readonly id: string;
  readonly proposed_by_user_id: number;
  readonly objective: string | null;
  readonly cron: string | null;
  readonly timezone: string | null;
  readonly created_at: number;
}

const props = defineProps<{
  readonly modelValue: boolean;
  readonly session: Session | undefined;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => {
    if (!saving.value) emit('update:modelValue', value);
  }
});
const loading = ref(false);
const pendingAction = ref<string>();
const saving = computed(() => pendingAction.value !== undefined);
const task = ref<Task | null>(null);
const taskLoaded = ref(false);
const currentUserName = ref('');
const notifyUserName = ref<string | null>(null);
const occurrences = ref<readonly Occurrence[]>([]);
const occurrencePage = ref(1);
const occurrenceTotal = ref(0);
const proposals = ref<readonly Proposal[]>([]);
const canResolveProposals = ref(false);
const formRef = ref<FormInstance>();
const form = reactive({
  objective: '',
  time: '09:00',
  hourlyTime: '00:00',
  cronExpression: ''
});
const rules: FormRules = {
  objective: [
    {
      validator: (_rule, value: string, callback) =>
        value.trim().length > 0 && value.trim().length <= 20_000
          ? callback()
          : callback(new Error(translate('generated.scheduledSession.objectiveRequired'))),
      trigger: 'blur'
    }
  ],
  time: [
    {
      validator: (_rule, value: string | null, callback) =>
        value
          ? callback()
          : callback(new Error(translate('generated.scheduledSession.timeRequired')))
    }
  ],
  hourlyTime: [
    {
      validator: (_rule, value: string | null, callback) =>
        value
          ? callback()
          : callback(new Error(translate('generated.scheduledSession.timeRequired')))
    }
  ],
  cronExpression: [
    {
      validator: (_rule, value: string | null, callback) =>
        value !== null && isCronExpressionValid(value)
          ? callback()
          : callback(new Error(translate('generated.scheduledSession.cronRequired'))),
      trigger: 'blur'
    }
  ]
};
const scheduleMode = ref<'SIMPLE' | 'CRON'>('SIMPLE');
const cadence = ref<'HOURLY' | 'DAILY' | 'WEEKLY'>('DAILY');
const weekday = ref(1);
const nodeTimezone = ref('UTC');
const enabled = ref(false);
const notifyOnTerminal = ref(false);
const statusLabel = computed(() => {
  if (!taskLoaded.value) return '';
  return translate(
    task.value === null
      ? 'generated.scheduledSession.notConfigured'
      : enabled.value
        ? 'generated.scheduledSession.enabled'
        : 'generated.scheduledSession.paused'
  );
});
let loadSequence = 0;
let disposed = false;
onBeforeUnmount(() => {
  disposed = true;
  loadSequence++;
});

watch(
  () => [props.modelValue, props.session?.id, props.nodeId, props.workspaceId] as const,
  () => {
    loadSequence++;
    task.value = null;
    taskLoaded.value = false;
    enabled.value = false;
    currentUserName.value = '';
    notifyUserName.value = null;
    occurrences.value = [];
    occurrencePage.value = 1;
    occurrenceTotal.value = 0;
    loading.value = false;
    proposals.value = [];
    form.objective = '';
    form.cronExpression = '';
    scheduleMode.value = 'SIMPLE';
    if (props.modelValue && props.session !== undefined) void load();
  },
  { immediate: true }
);

function path(): string {
  return `/api/agent-sessions/${encodeURIComponent(props.session!.id)}/schedule`;
}

async function load(page = 1, updateForm = true): Promise<void> {
  if (disposed || props.session === undefined) return;
  const sequence = ++loadSequence;
  const sessionId = props.session.id;
  loading.value = true;
  if (updateForm) taskLoaded.value = false;
  try {
    const query = new URLSearchParams({
      nodeId: props.nodeId,
      workspaceId: props.workspaceId,
      occurrencePage: String(page)
    });
    const result = await props.request<{
      task: Task | null;
      occurrences: readonly Occurrence[];
      occurrencePage?: number;
      occurrenceTotal?: number;
      proposals: readonly Proposal[];
      canResolveProposals: boolean;
      nodeTimezone: string;
      currentUserName: string;
      notifyUserName: string | null;
    }>(`/api/agent-sessions/${encodeURIComponent(sessionId)}/schedule?${query}`);
    if (sequence !== loadSequence || !props.modelValue || props.session?.id !== sessionId) return;
    occurrences.value = result.occurrences;
    occurrencePage.value = result.occurrencePage ?? 1;
    occurrenceTotal.value = result.occurrenceTotal ?? 0;
    if (!updateForm) return;
    task.value = result.task;
    currentUserName.value = result.currentUserName;
    notifyUserName.value = result.notifyUserName;
    proposals.value = result.proposals;
    canResolveProposals.value = result.canResolveProposals;
    nodeTimezone.value = result.nodeTimezone;
    if (result.task !== null) {
      form.objective = result.task.objective;
      enabled.value = result.task.enabled;
      notifyOnTerminal.value = result.task.notifyOnTerminal;
      form.cronExpression = result.task.cron;
      const simple = simpleCronParts(result.task.cron);
      if (simple === undefined) {
        scheduleMode.value = 'CRON';
      } else {
        scheduleMode.value = 'SIMPLE';
        cadence.value = simple.cadence;
        form.time = simple.time;
        form.hourlyTime = simple.hourlyTime;
        weekday.value = simple.weekday;
      }
    } else {
      form.objective = '';
      form.cronExpression = '';
      scheduleMode.value = 'SIMPLE';
      cadence.value = 'DAILY';
      form.time = '09:00';
      form.hourlyTime = '00:00';
      weekday.value = 1;
      enabled.value = false;
      notifyOnTerminal.value = false;
    }
    taskLoaded.value = true;
  } catch (error) {
    if (sequence === loadSequence)
      showMessage(
        errorMessage(error, translate('generated.scheduledSession.loadFailed')),
        'error',
        error
      );
  } finally {
    if (sequence === loadSequence) loading.value = false;
  }
}

function changeOccurrencePage(page: number): void {
  if (!loading.value && !saving.value) void load(page, false);
}

function cron(): string {
  if (scheduleMode.value === 'CRON') return form.cronExpression.trim();
  const [hour, minute] = form.time.split(':').map(Number);
  if (cadence.value === 'HOURLY') return `${Number(form.hourlyTime.split(':')[1])} * * * *`;
  if (cadence.value === 'DAILY') return `${minute} ${hour} * * *`;
  return `${minute} ${hour} * * ${weekday.value}`;
}

function simpleCronParts(expression: string):
  | {
      readonly cadence: 'HOURLY' | 'DAILY' | 'WEEKLY';
      readonly time: string;
      readonly hourlyTime: string;
      readonly weekday: number;
    }
  | undefined {
  const fields = expression.trim().split(/\s+/);
  if (
    fields.length !== 5 ||
    !/^\d+$/.test(fields[0] ?? '') ||
    (fields[1] !== '*' && !/^\d+$/.test(fields[1] ?? '')) ||
    fields[2] !== '*' ||
    fields[3] !== '*' ||
    (fields[4] !== '*' && !/^\d+$/.test(fields[4] ?? ''))
  )
    return undefined;
  const minute = Number(fields[0]);
  const hour = fields[1] === '*' ? 9 : Number(fields[1]);
  const weekday = fields[4] === '*' ? 1 : Number(fields[4]);
  if (minute > 59 || hour > 23 || weekday > 6) return undefined;
  return {
    cadence: fields[1] === '*' ? 'HOURLY' : fields[4] === '*' ? 'DAILY' : 'WEEKLY',
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    hourlyTime: `00:${String(minute).padStart(2, '0')}`,
    weekday
  };
}

function isCronExpressionValid(expression: string): boolean {
  const normalized = expression.trim();
  if (normalized.length === 0 || normalized.length > 64) return false;
  const fields = normalized.split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => field.length === 0)) return false;
  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7]
  ] as const;
  return fields.every((field, index) =>
    isCronFieldValid(field, ranges[index]![0], ranges[index]![1])
  );
}

function isCronFieldValid(field: string, min: number, max: number): boolean {
  const values = new Set<number>();
  for (const segment of field.split(',')) {
    const parts = segment.split('/');
    if (parts.length > 2 || parts.some((part) => part.length === 0)) return false;
    const base = parts[0] ?? '';
    const step = parts[1] === undefined ? 1 : cronInteger(parts[1], 1, max - min + 1);
    if (step === undefined) return false;
    let start: number;
    let end: number;
    if (base === '*') {
      start = min;
      end = max;
    } else if (/^\d+-\d+$/.test(base)) {
      const range = base.split('-');
      const rangeStart = cronInteger(range[0], min, max);
      const rangeEnd = cronInteger(range[1], min, max);
      if (rangeStart === undefined || rangeEnd === undefined || rangeStart > rangeEnd) return false;
      start = rangeStart;
      end = rangeEnd;
    } else if (parts.length === 1) {
      const value = cronInteger(base, min, max);
      if (value === undefined) return false;
      start = value;
      end = value;
    } else {
      return false;
    }
    if (parts[1] !== undefined && start === end) return false;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values.size > 0;
}

function cronInteger(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : undefined;
}

async function save(): Promise<void> {
  if (
    saving.value ||
    loading.value ||
    props.session === undefined ||
    !taskLoaded.value ||
    !(await formRef.value?.validate().catch(() => false))
  )
    return;
  if (saving.value || loading.value) return;
  pendingAction.value = 'save';
  try {
    await props.request(path(), {
      method: 'PUT',
      body: JSON.stringify({
        nodeId: props.nodeId,
        workspaceId: props.workspaceId,
        objective: form.objective.trim(),
        cron: cron(),
        enabled: enabled.value,
        notifyOnTerminal: notifyOnTerminal.value,
        ...(task.value === null ? {} : { expectedRevision: task.value.revision })
      })
    });
    showMessage(translate('generated.scheduledSession.saved'), 'success');
  } catch (error) {
    showMessage(
      errorMessage(error, translate('generated.scheduledSession.saveFailed')),
      'error',
      error
    );
    return;
  } finally {
    pendingAction.value = undefined;
  }
  await load();
}

async function remove(): Promise<void> {
  if (task.value === null || !taskLoaded.value || saving.value || loading.value) return;
  pendingAction.value = 'remove';
  try {
    await props.request(path(), {
      method: 'DELETE',
      body: JSON.stringify({
        nodeId: props.nodeId,
        workspaceId: props.workspaceId,
        expectedRevision: task.value.revision
      })
    });
    showMessage(translate('generated.scheduledSession.removed'), 'success');
  } catch (error) {
    showMessage(
      errorMessage(error, translate('generated.scheduledSession.removeFailed')),
      'error',
      error
    );
    return;
  } finally {
    pendingAction.value = undefined;
  }
  await load();
}

async function resolveProposal(proposalId: string, accept: boolean): Promise<void> {
  if (props.session === undefined || saving.value || loading.value) return;
  pendingAction.value = `${accept ? 'accept' : 'reject'}:${proposalId}`;
  try {
    await props.request(`${path()}/proposals/${encodeURIComponent(proposalId)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ nodeId: props.nodeId, workspaceId: props.workspaceId, accept })
    });
  } catch (error) {
    showMessage(
      errorMessage(error, translate('generated.scheduledSession.proposalFailed')),
      'error',
      error
    );
    return;
  } finally {
    pendingAction.value = undefined;
  }
  await load();
}

function requestClose(done: () => void): void {
  if (!saving.value) done();
}

function localTime(value: number | null): string {
  return value === null
    ? '—'
    : managementDateTime(value, task.value?.timezone ?? nodeTimezone.value);
}

function occurrenceStatus(status: string): string {
  const keys: Record<string, string> = {
    CLAIMED: 'occurrenceClaimed',
    SUBMITTED: 'occurrenceSubmitted',
    SUCCEEDED: 'occurrenceSucceeded',
    SKIPPED: 'occurrenceSkipped',
    FAILED: 'occurrenceFailed'
  };
  const key = keys[status];
  return key === undefined ? status : translate(`generated.scheduledSession.${key}`);
}
</script>

<template>
  <el-dialog
    v-if="open"
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    v-model="open"
    :before-close="requestClose"
    :show-close="!saving"
    :close-on-click-modal="!saving"
    :close-on-press-escape="!saving"
    :title="translate('generated.scheduledSession.title')"
    width="min(560px, calc(100vw - 32px))"
    append-to-body
    :close-icon="marIcon('close')"
  >
    <el-form
      ref="formRef"
      v-loading="loading"
      :aria-busy="loading"
      :model="form"
      :rules="rules"
      :disabled="saving || loading || !taskLoaded"
      class="schedule-form"
      label-position="left"
      label-width="116px"
    >
      <el-form-item :label="translate('generated.scheduledSession.objective')" prop="objective">
        <el-input
          v-model="form.objective"
          type="textarea"
          :rows="4"
          :maxlength="20000"
          :placeholder="translate('generated.scheduledSession.objective')"
          :aria-label="translate('generated.scheduledSession.objective')"
        />
      </el-form-item>
      <el-form-item :label="translate('generated.scheduledSession.mode')">
        <el-radio-group
          v-model="scheduleMode"
          :aria-label="translate('generated.scheduledSession.mode')"
        >
          <el-radio-button value="SIMPLE">
            {{ translate('generated.scheduledSession.simpleMode') }}
          </el-radio-button>
          <el-radio-button value="CRON">
            {{ translate('generated.scheduledSession.cronMode') }}
          </el-radio-button>
        </el-radio-group>
      </el-form-item>
      <template v-if="scheduleMode === 'SIMPLE'">
        <el-form-item :label="translate('generated.scheduledSession.repeat')">
          <el-select
            v-model="cadence"
            :aria-label="translate('generated.scheduledSession.repeat')"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
          >
            <el-option value="HOURLY" :label="translate('generated.scheduledSession.hourly')" />
            <el-option value="DAILY" :label="translate('generated.scheduledSession.daily')" />
            <el-option value="WEEKLY" :label="translate('generated.scheduledSession.weekly')" />
          </el-select>
        </el-form-item>
        <div class="schedule-time-fields">
          <el-form-item
            v-if="cadence === 'WEEKLY'"
            :label="translate('generated.scheduledSession.weekday')"
          >
            <el-select
              v-model="weekday"
              :aria-label="translate('generated.scheduledSession.weekday')"
              :clear-icon="marIcon('clear-input')"
              :suffix-icon="marIcon('chevron-down')"
            >
              <el-option
                v-for="index in 7"
                :key="index"
                :value="index - 1"
                :label="translate(`generated.scheduledSession.weekday${index - 1}`)"
              />
            </el-select>
          </el-form-item>
          <el-form-item
            v-if="cadence === 'HOURLY'"
            :label="translate('generated.scheduledSession.minute')"
            prop="hourlyTime"
          >
            <el-time-select
              v-model="form.hourlyTime"
              start="00:00"
              step="00:01"
              end="00:59"
              :aria-label="translate('generated.scheduledSession.minute')"
              :prefix-icon="marIcon('clock')"
              :clear-icon="marIcon('clear-input')"
            />
          </el-form-item>
          <el-form-item v-else :label="translate('generated.scheduledSession.time')" prop="time">
            <el-time-picker
              v-model="form.time"
              format="HH:mm"
              value-format="HH:mm"
              :aria-label="translate('generated.scheduledSession.time')"
              :prefix-icon="marIcon('clock')"
              :clear-icon="marIcon('clear-input')"
            />
          </el-form-item>
        </div>
      </template>
      <template v-else>
        <el-form-item
          :label="translate('generated.scheduledSession.cronExpression')"
          prop="cronExpression"
        >
          <el-input
            v-model="form.cronExpression"
            maxlength="64"
            :placeholder="translate('generated.scheduledSession.cronPlaceholder')"
            :aria-label="translate('generated.scheduledSession.cronExpression')"
          />
        </el-form-item>
        <p class="schedule-timezone">
          {{ translate('generated.scheduledSession.cronHint') }}
        </p>
      </template>
      <p class="schedule-timezone">
        {{ translate('generated.scheduledSession.nodeTimezone', { timezone: nodeTimezone }) }}
      </p>
      <el-form-item :label="translate('generated.scheduledSession.status')">
        <div class="schedule-enabled">
          <el-switch
            v-model="enabled"
            :disabled="!taskLoaded"
            :aria-label="translate('generated.scheduledSession.enabled')"
          />
          <span>{{ statusLabel }}</span>
        </div>
      </el-form-item>
      <el-form-item :label="translate('generated.scheduledSession.notifyUser')">
        <span>{{
          task === null
            ? currentUserName
            : (notifyUserName ?? translate('generated.scheduledSession.userUnavailable'))
        }}</span>
      </el-form-item>
      <el-form-item :label="translate('generated.scheduledSession.terminalNotifications')">
        <el-switch
          v-model="notifyOnTerminal"
          :aria-label="translate('generated.scheduledSession.terminalNotifications')"
        />
      </el-form-item>
      <p class="schedule-timezone">
        {{ translate('generated.scheduledSession.notifyUserHint') }}
      </p>
      <el-form-item v-if="task !== null" :label="translate('generated.scheduledSession.nextRun')">
        <span>{{ localTime(task.nextRunAt) }}</span>
      </el-form-item>
      <div v-if="proposals.length > 0" class="schedule-history">
        <strong>{{ translate('generated.scheduledSession.proposals') }}</strong>
        <div v-for="proposal in proposals" :key="proposal.id" class="schedule-proposal">
          <p>
            {{ localTime(proposal.created_at) }} ·
            {{
              translate('generated.scheduledSession.proposedBy', {
                userId: proposal.proposed_by_user_id
              })
            }}
          </p>
          <p v-if="proposal.objective">
            {{ translate('generated.scheduledSession.objective') }}：{{ proposal.objective }}
          </p>
          <p v-if="proposal.cron">
            {{ translate('generated.scheduledSession.repeat') }}：{{ proposal.cron }}
          </p>
          <p v-if="proposal.timezone">
            {{ translate('generated.scheduledSession.timezone') }}：{{ proposal.timezone }}
          </p>
          <div v-if="canResolveProposals">
            <el-button
              size="small"
              :disabled="saving"
              :loading="pendingAction === `reject:${proposal.id}`"
              :loading-icon="marIcon('loading-action')"
              @click="resolveProposal(proposal.id, false)"
              >{{ translate('generated.scheduledSession.reject') }}</el-button
            >
            <el-button
              size="small"
              type="primary"
              :disabled="saving"
              :loading="pendingAction === `accept:${proposal.id}`"
              :loading-icon="marIcon('loading-action')"
              @click="resolveProposal(proposal.id, true)"
              >{{ translate('generated.scheduledSession.accept') }}</el-button
            >
          </div>
        </div>
      </div>
      <div v-if="occurrences.length > 0" class="schedule-history">
        <strong>{{ translate('generated.scheduledSession.history') }}</strong>
        <p v-for="occurrence in occurrences" :key="occurrence.id">
          {{ localTime(occurrence.due_at) }} · {{ occurrenceStatus(occurrence.status)
          }}<span v-if="occurrence.code"> · {{ occurrence.code }}</span>
        </p>
        <el-pagination
          v-if="occurrenceTotal > 0"
          :current-page="occurrencePage"
          :page-size="10"
          :total="occurrenceTotal"
          :disabled="loading || saving"
          :pager-count="5"
          layout="prev, pager, next"
          @current-change="changeOccurrencePage"
          :prev-icon="marIcon('chevron-left')"
          :next-icon="marIcon('chevron-right')"
        />
      </div>
    </el-form>
    <template #footer>
      <el-button
        v-if="task !== null"
        :disabled="saving || loading || !taskLoaded"
        :loading="pendingAction === 'remove'"
        :loading-icon="marIcon('loading-action')"
        type="danger"
        @click="remove"
        >{{ translate('generated.scheduledSession.remove') }}</el-button
      >
      <el-button :disabled="saving" @click="open = false">{{
        translate('common.close')
      }}</el-button>
      <el-button
        type="primary"
        :loading="pendingAction === 'save'"
        :disabled="saving || loading || !taskLoaded"
        @click="save"
        :loading-icon="marIcon('loading-action')"
        >{{ translate('generated.scheduledSession.save') }}</el-button
      >
    </template>
  </el-dialog>
</template>

<style scoped>
.schedule-form {
  display: grid;
  gap: 0.7rem;
}
.schedule-form :deep(.el-form-item) {
  margin-bottom: 0;
}
.schedule-form :deep(.el-form-item__label) {
  align-items: center;
  justify-content: flex-start;
  line-height: 1.35;
  white-space: normal;
}
.schedule-form :deep(.el-form-item),
.schedule-form :deep(.el-form-item__content),
.schedule-time-fields {
  min-width: 0;
  width: 100%;
}
.schedule-form :deep(.el-textarea),
.schedule-form :deep(.el-select),
.schedule-form :deep(.el-date-editor) {
  width: 100%;
}
.schedule-time-fields {
  display: grid;
}
.schedule-enabled {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.schedule-timezone {
  margin: 0;
  padding-left: 116px;
  color: var(--mar-text-muted);
}
@media (max-width: 600px) {
  .schedule-form :deep(.el-form-item) {
    display: block;
  }
  .schedule-form :deep(.el-form-item__label) {
    width: 100% !important;
    justify-content: flex-start;
    padding: 0 0 0.35rem;
  }
  .schedule-form :deep(.el-form-item__content) {
    margin-left: 0 !important;
  }
  .schedule-timezone {
    padding-left: 0;
  }
}
.schedule-history {
  border-top: 1px solid var(--mar-border-default);
  padding-top: 0.7rem;
}
.schedule-history p {
  margin: 0.35rem 0;
  color: var(--mar-text-muted);
}
.schedule-proposal {
  padding: 0.55rem 0;
  border-bottom: 1px solid var(--mar-border-default);
}
</style>
