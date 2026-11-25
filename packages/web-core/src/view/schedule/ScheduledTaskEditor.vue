<script setup lang="ts">
import { computed, h, nextTick, onBeforeUnmount, reactive, ref, useId, watch } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarDatePicker } from '@myagentroam/mar-ui/date-picker';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarForm, MarFormItem, type FormInstance, type FormRules } from '@myagentroam/mar-ui/form';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarRadio, MarRadioGroup } from '@myagentroam/mar-ui/radio';
import { MarOption, MarSelect } from '@myagentroam/mar-ui/select';
import { MarSwitch } from '@myagentroam/mar-ui/switch';
import { MarTabPane, MarTabs } from '@myagentroam/mar-ui/tabs';
import { MarTimePicker } from '@myagentroam/mar-ui/time-picker';
import { MarMessageBox } from '../../service/message-box-service.js';
import {
  scheduledClockTimeSchema,
  scheduledTriggerLimit,
  type ScheduledTarget,
  type ScheduledTrigger
} from '@myagentroam/protocol';
import type { RunnerProfile, Session, Workspace } from '../../model/workbench.js';
import { defaultEffortForModel } from '../../service/runner-profile-service.js';
import { errorSummary } from '../../util/error-presentation.js';
import { orderMarAgentReasoningEfforts } from '../../util/mar-agent-reasoning-effort.js';
import { managementDateTime } from '../../util/time-presentation.js';
import { runnerBrandIcon } from '../../util/runner-brand-icon.js';
import {
  compareRunners,
  runnerLabel,
  runnerModelCandidates
} from '../../util/runner-presentation.js';
import { effortPresentation } from '../../util/workbench-presentation.js';
import { translate } from '../../service/locale-preference-service.js';
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import type { ScheduleSessionContext } from './scheduled-task-navigation.js';
import type {
  ScheduleDetail,
  ScheduleDraft,
  ScheduleNode,
  ScheduleTaskKey,
  scheduledTaskClient
} from '../../service/scheduled-task-client.js';
import {
  parseTriggerDraft,
  pickerDate,
  triggerDraft,
  type TriggerDraft
} from './scheduled-time-draft.js';
import '../session/runner-brand-icon.css';

// One dialog owns one draft and cancels its dependent reads when the scope or dialog changes.
const props = defineProps<{
  client: ReturnType<typeof scheduledTaskClient>;
  nodes: ScheduleNode[];
  lockedSession?: ScheduleSessionContext | undefined;
  editing?:
    | {
        key: ScheduleTaskKey;
        detail: ScheduleDetail;
        sessionTitle?: string;
      }
    | undefined;
}>();
const emit = defineEmits<{ close: []; changed: [] }>();
const notificationHintId = useId();
const monthDayOptions = Array.from({ length: 31 }, (_, index) => index + 1);
const minuteOptions = Array.from({ length: 60 }, (_, minute) => minute);
const graceOptions = Array.from({ length: 60 }, (_, minute) => minute + 1);
const repeatOptions = ['once', 'hourly', 'daily', 'weekly', 'monthly'] as const;
const minuteLabel = (minute: number) => String(minute).padStart(2, '0');
const msg = (key: string, args?: Record<string, string | number>) =>
  translate(`generated.scheduledSession.${key}`, args);
const editing = props.editing;
const saved = editing?.detail.task;
const lockedSession = editing ? undefined : props.lockedSession;
const lockedScope = lockedSession?.scope;
let nextId = 1;
const form = reactive({
  nodeId: editing?.key.nodeId ?? lockedScope?.nodeId ?? '',
  workspaceId: editing?.key.workspaceId ?? lockedScope?.workspaceId ?? '',
  targetKind: saved?.newSession ? 'newSession' : saved?.sessionId || lockedScope ? 'existing' : '',
  sessionId: saved?.sessionId ?? lockedScope?.sessionId ?? '',
  runner: saved?.newSession?.runner ?? '',
  model: saved?.newSession?.model.kind === 'fixed' ? saved.newSession.model.modelId : '',
  effort: saved?.newSession?.effort ?? '',
  name: saved?.name ?? '',
  objective: saved?.objective ?? '',
  enabled: saved?.enabled ?? true,
  notifyOnTerminal: saved?.notifyOnTerminal ?? false,
  graceMinutes: saved?.graceMinutes ?? 0,
  triggers: saved?.triggers.length
    ? saved.triggers.map((trigger) => triggerDraft(nextId++, trigger))
    : [triggerDraft(nextId++)]
});
const savedSessionTitle = computed(() =>
  form.sessionId === saved?.sessionId ? editing?.sessionTitle : undefined
);
const dialog = ref<{ handleClose(): void }>();
const taskForm = ref<FormInstance & { $el: HTMLElement }>();
const timeForm = ref<FormInstance & { $el: HTMLElement }>();
const tab = ref('task');
const activeTriggerId = ref(saved?.triggers.length ? undefined : form.triggers[0]?.id);
const alive = ref(true);
const pending = ref<string>();
const error = ref<unknown>();
const workspaceError = ref<unknown>();
const targetError = ref<unknown>();
const previewError = ref<unknown>();
const workspaces = ref<Workspace[]>([]);
const sessions = ref<Session[]>([]);
const profiles = ref<RunnerProfile[]>([]);
const sessionCursor = ref<string | null>(null);
const loadingWorkspaces = ref(false);
const loadingTargets = ref(false);
const loadingPreview = ref(false);
const preview = ref<{ timezone: string; times: { dueAt: number }[] }>();
const timezone = ref(saved?.timezone);
const selection = computed(() => ({ nodeId: form.nodeId, workspaceId: form.workspaceId }));
const node = computed(() => props.nodes.find((item) => item.id === form.nodeId));
const hourlySupported = computed(() => node.value?.hourlySupported === true);
const targetReady = computed(
  () => node.value?.connected && node.value.supported !== false && form.workspaceId !== ''
);
const profile = computed(() => profiles.value.find((item) => item.runner === form.runner));
const selectedRunnerIcon = computed(() => {
  const runner = profile.value?.runner;
  return runner
    ? () =>
        h('img', {
          class: 'mar-runner-brand-icon',
          'data-runner': runner,
          src: runnerBrandIcon(runner),
          alt: ''
        })
    : undefined;
});
const modelOptions = computed(() => runnerModelCandidates(profile.value, undefined));
const model = computed(() => modelOptions.value.find((item) => item.id === form.model));
const savedModel = computed(() => {
  const config = saved?.newSession;
  if (config?.runner !== form.runner || config.model.kind !== 'fixed') return undefined;
  const id = config.model.modelId;
  return modelOptions.value.some((item) => item.id === id) ? undefined : id;
});
const efforts = computed(() => {
  const supported = model.value?.supportedEfforts ?? [];
  return form.runner === 'mar-agent' ? orderMarAgentReasoningEfforts(supported) : supported;
});
const parsedTriggers = computed(() => form.triggers.map(parseTriggerDraft));
const checkedTriggers = () =>
  parsedTriggers.value.flatMap((result) => (result.success ? [result.data] : []));
function triggerError(row: TriggerDraft, index: number): string | undefined {
  if (row.kind === 'hourly' && !hourlySupported.value) return 'hourlyUnavailable';
  if (row.kind === 'hourly' && !row.minutes.length) return 'hourlyMinutesRequired';
  return parsedTriggers.value[index]?.success ? undefined : 'triggerInvalid';
}
const previewTriggers = computed(() =>
  form.triggers.length && !form.triggers.some(triggerError) ? checkedTriggers() : undefined
);
const suggestionTarget = computed(() =>
  form.triggers.find(
    (trigger) =>
      trigger.kind === 'once' &&
      trigger.date === null &&
      trigger.suggestedDate === null &&
      scheduledClockTimeSchema.safeParse(trigger.time).success
  )
);
const suggestionTime = computed(() => suggestionTarget.value?.time ?? undefined);
const hasSpecificDates = computed(() =>
  parsedTriggers.value.some((result) => result.success && result.data.kind === 'once')
);
const allowCatchUp = computed({
  get: () => form.graceMinutes > 0,
  set: (enabled: boolean) => {
    form.graceMinutes = enabled ? 15 : 0;
  }
});
const newSessionSupported = computed(() => node.value?.newSessionSupported !== false);
const serializeDraft = () => JSON.stringify(form);
const initialDraft = serializeDraft();

const rules: FormRules = {
  nodeId: [
    {
      validator: () =>
        (node.value?.connected && node.value.supported !== false) || new Error(msg('nodeRequired'))
    }
  ],
  workspaceId: [
    {
      validator: () =>
        (!!form.workspaceId && workspaces.value.some((item) => item.id === form.workspaceId)) ||
        new Error(msg('workspaceRequired'))
    }
  ],
  targetKind: [{ required: true, message: msg('targetRequired') }],
  sessionId: [{ validator: () => !!form.sessionId || new Error(msg('targetRequired')) }],
  runner: [
    {
      validator: () =>
        (newSessionSupported.value && profile.value !== undefined) ||
        new Error(msg('runnerRequired'))
    }
  ],
  model: [
    {
      validator: () =>
        !!model.value || form.model === savedModel.value || new Error(msg('modelRequired'))
    }
  ],
  name: [
    {
      validator: () =>
        (form.name.trim().length > 0 && form.name.trim().length <= 160) ||
        new Error(msg('nameRequired'))
    }
  ],
  objective: [
    {
      validator: () =>
        (form.objective.trim().length > 0 && form.objective.trim().length <= 20_000) ||
        new Error(msg('objectiveRequired'))
    }
  ],
  graceMinutes: [
    {
      validator: () =>
        (Number.isInteger(form.graceMinutes) &&
          form.graceMinutes >= 0 &&
          form.graceMinutes <= 60) ||
        new Error(msg('graceHint'))
    }
  ]
};
const timeRules = computed<FormRules>(() => ({
  graceMinutes: rules.graceMinutes,
  ...Object.fromEntries(
    form.triggers.map((row, index) => [
      `triggers.${index}`,
      [
        {
          validator: () => {
            const errorKey = triggerError(row, index);
            return errorKey ? new Error(msg(errorKey)) : true;
          }
        }
      ]
    ])
  )
}));

function chooseNode(): void {
  form.workspaceId = '';
  clearTarget();
}
function clearTarget(): void {
  form.targetKind = '';
  form.sessionId = '';
  form.runner = '';
  clearModel();
}
function clearModel(): void {
  form.model = '';
  form.effort = '';
}
function selectModel(): void {
  form.effort = defaultEffortForModel(model.value);
}
let sessionRead: AbortController | undefined;
watch(
  () => [form.nodeId, node.value?.connected, node.value?.supported] as const,
  async ([id, connected, supported], _, onCleanup) => {
    workspaces.value = [];
    workspaceError.value = undefined;
    loadingWorkspaces.value = false;
    if (!id || !connected || supported === false) return;
    const read = new AbortController();
    onCleanup(() => read.abort());
    loadingWorkspaces.value = true;
    try {
      const result = await props.client.workspaces(id, read.signal);
      if (!read.signal.aborted) workspaces.value = result.workspaces;
    } catch (failure) {
      if (!read.signal.aborted) workspaceError.value = failure;
    } finally {
      if (!read.signal.aborted) loadingWorkspaces.value = false;
    }
  },
  { immediate: true }
);

watch(
  () => [form.nodeId, form.workspaceId, targetReady.value] as const,
  (_, __, onCleanup) => {
    sessionRead = undefined;
    sessions.value = [];
    sessionCursor.value = null;
    loadingTargets.value = false;
    targetError.value = undefined;
    if (lockedScope || !targetReady.value) return;
    const read = new AbortController();
    sessionRead = read;
    onCleanup(() => read.abort());
    void loadSessions();
  },
  { immediate: true }
);
async function loadSessions(cursor?: string) {
  const read = sessionRead;
  if (!read || loadingTargets.value) return;
  loadingTargets.value = true;
  targetError.value = undefined;
  try {
    const result = await props.client.sessions(selection.value, read.signal, cursor);
    if (read.signal.aborted) return;
    sessions.value = [...(cursor ? sessions.value : []), ...result.sessions];
    sessionCursor.value = result.nextCursor;
  } catch (failure) {
    if (!read.signal.aborted) targetError.value = failure;
  } finally {
    if (!read.signal.aborted) loadingTargets.value = false;
  }
}
const profileError = ref<unknown>();
const loadingProfiles = ref(false);
watch(
  () => [form.nodeId, form.workspaceId, form.targetKind, targetReady.value] as const,
  async (_, __, onCleanup) => {
    profiles.value = [];
    profileError.value = undefined;
    loadingProfiles.value = false;
    if (!targetReady.value || form.targetKind !== 'newSession') return;
    const read = new AbortController();
    onCleanup(() => read.abort());
    loadingProfiles.value = true;
    try {
      const result = await props.client.profiles(selection.value, read.signal);
      if (!read.signal.aborted)
        profiles.value = result.profiles
          .filter((item) => item.models.length > 0)
          .sort((left, right) => compareRunners(left.runner, right.runner));
    } catch (failure) {
      if (!read.signal.aborted) profileError.value = failure;
    } finally {
      if (!read.signal.aborted) loadingProfiles.value = false;
    }
  },
  { immediate: true }
);

watch(selection, () => {
  for (const row of form.triggers) row.suggestedDate = null;
});

watch(
  [selection, targetReady, previewTriggers, suggestionTarget, suggestionTime],
  ([target, available, triggers, row, suggestTime], [previousTarget], onCleanup) => {
    preview.value = undefined;
    previewError.value = undefined;
    loadingPreview.value = false;
    if (previousTarget !== target || !available) timezone.value = saved?.timezone;
    if (!available || (!triggers && !suggestTime && timezone.value !== undefined)) return;
    const read = new AbortController();
    loadingPreview.value = true;
    const timer = setTimeout(
      async () => {
        try {
          const result = await props.client.preview(
            target,
            { triggers, suggestTime, taskId: saved?.id },
            read.signal
          );
          if (read.signal.aborted) return;
          timezone.value = result.timezone;
          if (result.suggestedDate && row?.date === null)
            row.suggestedDate = pickerDate(result.suggestedDate);
          if (triggers) preview.value = result;
        } catch (failure) {
          if (!read.signal.aborted) previewError.value = failure;
        } finally {
          if (!read.signal.aborted) loadingPreview.value = false;
        }
      },
      triggers ? 250 : 0
    );
    onCleanup(() => {
      clearTimeout(timer);
      read.abort();
    });
  },
  { immediate: true }
);

function addTrigger(): void {
  const row = triggerDraft(nextId++);
  form.triggers.push(row);
  activeTriggerId.value = row.id;
}

function setTriggerTime(row: TriggerDraft, value: string | null): void {
  if (row.time === value) return;
  row.time = value;
  row.suggestedDate = null;
}

function removeTrigger(index: number): void {
  const [removed] = form.triggers.splice(index, 1);
  if (activeTriggerId.value === removed?.id) activeTriggerId.value = undefined;
}

function target(): ScheduledTarget {
  if (lockedScope) return { kind: 'existing', sessionId: lockedScope.sessionId };
  return form.targetKind === 'existing'
    ? { kind: 'existing', sessionId: form.sessionId }
    : {
        kind: 'newSession',
        runner: form.runner as Extract<ScheduledTarget, { kind: 'newSession' }>['runner'],
        model: { kind: 'fixed', modelId: form.model },
        ...(form.effort ? { effort: form.effort } : {})
      };
}
async function submit() {
  if (pending.value) return;
  pending.value = 'save';
  error.value = undefined;
  try {
    if (!(await taskForm.value?.validate().catch(() => false))) {
      tab.value = 'task';
      await nextTick();
      taskForm.value?.$el.querySelector('[role="alert"]')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (!(await timeForm.value?.validate().catch(() => false))) {
      tab.value = 'time';
      const invalid = form.triggers.findIndex(triggerError);
      if (invalid !== -1) activeTriggerId.value = form.triggers[invalid]?.id;
      await nextTick();
      timeForm.value?.$el.querySelector('[role="alert"]')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (!alive.value) return;
    const draft: ScheduleDraft = {
      name: form.name,
      objective: form.objective,
      target: target(),
      triggers: checkedTriggers(),
      enabled: form.enabled,
      notifyOnTerminal: form.notifyOnTerminal,
      graceMinutes: form.graceMinutes
    };
    if (editing && saved) await props.client.update(editing.key, saved.revision, draft);
    else await props.client.create(lockedScope ?? selection.value, draft);
    if (alive.value) emit('changed');
  } catch (failure) {
    if (alive.value) error.value = failure;
  } finally {
    pending.value = undefined;
  }
}
async function resolve(id: string, accept: boolean) {
  if (!editing || pending.value) return;
  if (!(await confirmDiscard()) || !alive.value || pending.value) return;
  pending.value = `${id}:${accept}`;
  error.value = undefined;
  try {
    await props.client.resolve(editing.key, id, accept);
    if (alive.value) emit('changed');
  } catch (failure) {
    if (alive.value) error.value = failure;
  } finally {
    pending.value = undefined;
  }
}
async function remove() {
  if (!editing || !saved || pending.value) return;
  try {
    await MarMessageBox.confirm(msg('deleteConfirm', { name: saved.name }), msg('remove'), {
      type: 'warning'
    });
  } catch {
    return;
  }
  if (!alive.value || pending.value) return;
  pending.value = 'delete';
  error.value = undefined;
  try {
    await props.client.remove(editing.key, saved.revision);
    if (alive.value) emit('changed');
  } catch (failure) {
    if (alive.value) error.value = failure;
  } finally {
    pending.value = undefined;
  }
}
async function confirmDiscard(): Promise<boolean> {
  if (initialDraft === serializeDraft()) return true;
  try {
    await MarMessageBox.confirm(msg('discardConfirm'), msg('discard'), { type: 'warning' });
    return true;
  } catch {
    return false;
  }
}
async function beforeClose(done: (cancel?: boolean) => void) {
  if (!pending.value && (await confirmDiscard()) && alive.value) done();
}
onBeforeUnmount(() => {
  alive.value = false;
});
function triggerLabel(trigger: ScheduledTrigger): string {
  if (trigger.kind === 'once') return `${trigger.date} · ${msg('once')}`;
  if (trigger.kind === 'hourly')
    return msg('hourlySummary', {
      minutes: [...new Set(trigger.minutes)]
        .sort((a, b) => a - b)
        .map(minuteLabel)
        .join(', ')
    });
  if (trigger.kind === 'weekly') {
    const days = [1, 2, 3, 4, 5, 6, 0].filter((day) => trigger.weekdays.includes(day));
    return msg('weeklySummary', { days: days.map((day) => msg(`weekday${day}`)).join(', ') });
  }
  if (trigger.kind === 'monthly')
    return msg('monthlySummary', { days: [...trigger.monthDays].sort((a, b) => a - b).join(', ') });
  return msg('daily');
}
const triggersFromProposal = (triggers: ScheduledTrigger[]) =>
  triggers
    .map((trigger) =>
      trigger.kind === 'hourly'
        ? `${msg('hourly')} · ${triggerLabel(trigger)}`
        : `${trigger.time} · ${triggerLabel(trigger)}`
    )
    .join('\n');
</script>

<template>
  <MarDialog
    v-if="alive"
    ref="dialog"
    :model-value="true"
    :title="saved?.name ?? msg('create')"
    width="min(680px, calc(100vw - 32px))"
    :before-close="beforeClose"
    @update:model-value="(open) => !open && emit('close')"
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
  >
    <MarTabs v-model="tab" :label="msg('editorSections')">
      <MarTabPane name="task" :label="msg('taskTab')" class="editor-section">
        <MarForm
          ref="taskForm"
          :model="form"
          :rules="rules"
          :disabled="!!pending"
          label-position="top"
          :aria-label="msg('taskTab')"
          @submit.prevent="submit"
        >
          <div class="fields">
            <MarFormItem :label="msg('node')" prop="nodeId">
              <MarSelect
                v-model="form.nodeId"
                :placeholder="msg('chooseNode')"
                :disabled="!!saved || !!lockedScope || undefined"
                @change="chooseNode"
              >
                <MarOption
                  v-for="item in nodes"
                  :key="item.id"
                  :label="
                    item.name +
                    (!item.connected
                      ? ` · ${msg('offline')}`
                      : item.supported === false
                        ? ` · ${msg('unsupported')}`
                        : '')
                  "
                  :value="item.id"
                  :disabled="!item.connected || item.supported === false"
                />
              </MarSelect>
            </MarFormItem>
            <MarFormItem :label="msg('workspace')" prop="workspaceId">
              <MarSelect
                v-model="form.workspaceId"
                :placeholder="msg('chooseWorkspace')"
                :disabled="!form.nodeId || !!saved || !!lockedScope || undefined"
                :loading="loadingWorkspaces"
                @change="clearTarget"
              >
                <MarOption
                  v-for="item in workspaces"
                  :key="item.id"
                  :label="item.displayName ?? item.path"
                  :value="item.id"
                />
              </MarSelect>
              <small v-if="workspaceError" role="alert">{{
                errorSummary(workspaceError, msg('loadFailed'))
              }}</small>
            </MarFormItem>
          </div>
          <div :class="{ fields: form.targetKind === 'existing' }">
            <MarFormItem :label="msg('target')" prop="targetKind">
              <MarSelect
                v-model="form.targetKind"
                :placeholder="msg('chooseTarget')"
                :disabled="!!lockedScope || !targetReady || undefined"
                @change="clearModel"
              >
                <MarOption :label="msg('existing')" value="existing" />
                <MarOption
                  :label="msg('newSession')"
                  value="newSession"
                  :disabled="!newSessionSupported"
                />
              </MarSelect>
            </MarFormItem>
            <MarFormItem
              v-if="form.targetKind === 'existing'"
              :label="msg('session')"
              prop="sessionId"
            >
              <MarSelect
                v-model="form.sessionId"
                :placeholder="msg('chooseSession')"
                :filterable="!lockedScope"
                :disabled="!!lockedScope || undefined"
                :loading="loadingTargets"
              >
                <MarOption
                  v-if="
                    form.sessionId &&
                    !sessions.some((item) => (item.externalSessionId ?? item.id) === form.sessionId)
                  "
                  :label="lockedSession?.title ?? savedSessionTitle ?? form.sessionId"
                  :value="form.sessionId"
                />
                <MarOption
                  v-for="item in sessions"
                  :key="item.id"
                  :label="item.customTitle ?? item.runnerTitle ?? item.id"
                  :value="item.externalSessionId ?? item.id"
                />
              </MarSelect>
              <MarButton
                v-if="sessionCursor"
                link
                :disabled="loadingTargets"
                @click="loadSessions(sessionCursor)"
                >{{ msg('moreSessions') }}</MarButton
              >
              <small v-if="targetError" role="alert">{{
                errorSummary(targetError, msg('loadFailed'))
              }}</small>
            </MarFormItem>
          </div>
          <div v-if="form.targetKind === 'newSession'" class="wrapping-fields">
            <MarFormItem :label="$t('common.runner')" prop="runner">
              <MarSelect
                v-model="form.runner"
                :placeholder="msg('chooseAgent')"
                v-bind="selectedRunnerIcon ? { prefixIcon: selectedRunnerIcon } : {}"
                :loading="loadingProfiles"
                @change="clearModel"
              >
                <MarOption
                  v-for="item in profiles"
                  :key="item.runner"
                  :label="runnerLabel(item.runner)"
                  :value="item.runner"
                >
                  <span class="runner-option">
                    <img
                      class="mar-runner-brand-icon"
                      :data-runner="item.runner"
                      :src="runnerBrandIcon(item.runner)"
                      alt=""
                    />
                    <span>{{ runnerLabel(item.runner) }}</span>
                  </span>
                </MarOption>
              </MarSelect>
              <small v-if="profileError" role="alert">{{
                errorSummary(profileError, msg('loadFailed'))
              }}</small>
            </MarFormItem>
            <MarFormItem :label="msg('model')" prop="model">
              <MarSelect
                v-model="form.model"
                :placeholder="msg('chooseModel')"
                filterable
                :disabled="profile ? undefined : true"
                @change="selectModel"
              >
                <MarOption v-if="savedModel" :label="savedModel" :value="savedModel" />
                <MarOption
                  v-for="item in modelOptions"
                  :key="item.id"
                  :label="item.label"
                  :value="item.id"
                />
              </MarSelect>
            </MarFormItem>
            <MarFormItem v-if="efforts.length || form.effort" :label="msg('effort')">
              <MarSelect v-model="form.effort" :placeholder="msg('chooseEffort')" clearable>
                <MarOption
                  v-if="form.effort && !efforts.includes(form.effort)"
                  :label="effortPresentation(form.effort)"
                  :value="form.effort"
                />
                <MarOption
                  v-for="effort in efforts"
                  :key="effort"
                  :label="effortPresentation(effort)"
                  :value="effort"
                />
              </MarSelect>
            </MarFormItem>
          </div>
          <MarFormItem :label="msg('name')" prop="name"
            ><MarInput v-model="form.name" :placeholder="msg('enterName')" maxlength="160"
          /></MarFormItem>
          <MarFormItem :label="msg('objective')" prop="objective"
            ><MarInput
              v-model="form.objective"
              :placeholder="msg('enterObjective')"
              type="textarea"
              :rows="5"
              maxlength="20000"
          /></MarFormItem>
          <div class="fields toggles">
            <MarFormItem :label="msg('enabled')"><MarSwitch v-model="form.enabled" /></MarFormItem>
            <MarFormItem :label="msg('terminalNotifications')">
              <MarSwitch v-model="form.notifyOnTerminal" :aria-describedby="notificationHintId" />
              <small :id="notificationHintId">{{ msg('notifyUserHint') }}</small>
            </MarFormItem>
          </div>
          <p v-if="editing && !editing.detail.mine" class="ownership-hint">
            {{ msg('ownershipHint') }}
          </p>
          <section
            v-if="editing?.detail.proposals.length"
            class="proposals"
            :aria-label="msg('proposals')"
          >
            <h3>{{ msg('proposals') }}</h3>
            <article v-for="proposal in editing.detail.proposals" :key="proposal.id">
              <strong v-if="proposal.name">{{ proposal.name }}</strong>
              <p v-if="proposal.objective" class="multiline">{{ proposal.objective }}</p>
              <p v-if="proposal.triggers" class="multiline">
                {{ triggersFromProposal(proposal.triggers) }}
              </p>
              <MarButton
                :disabled="!!pending"
                :loading="pending === `${proposal.id}:false`"
                @click="resolve(proposal.id, false)"
                >{{ msg('reject') }}</MarButton
              >
              <MarButton
                type="primary"
                :disabled="!!pending"
                :loading="pending === `${proposal.id}:true`"
                @click="resolve(proposal.id, true)"
                >{{ msg('accept') }}</MarButton
              >
            </article>
          </section>
        </MarForm>
      </MarTabPane>
      <MarTabPane name="time" :label="msg('timeTab')" class="editor-section">
        <MarForm
          ref="timeForm"
          :model="form"
          :rules="timeRules"
          :disabled="!!pending"
          label-position="top"
          :aria-label="msg('timeTab')"
          @submit.prevent="submit"
        >
          <p v-if="timezone" class="schedule-timezone">{{ msg('nodeTimezone', { timezone }) }}</p>
          <p v-if="saved && saved.triggers.length === 0" class="schedule-timezone">
            {{ msg('needsRunTimes') }}
          </p>
          <div class="schedule-triggers">
            <MarFormItem
              v-for="(trigger, index) in form.triggers"
              :key="trigger.id"
              :prop="`triggers.${index}`"
              class="trigger-item"
            >
              <div class="trigger-row">
                <span class="trigger-clock">{{
                  trigger.kind === 'hourly' ? msg('hourly') : trigger.time || '—'
                }}</span>
                <span class="trigger-description">
                  {{
                    parsedTriggers[index]?.success
                      ? triggerLabel(parsedTriggers[index].data)
                      : msg('incompleteTrigger')
                  }}
                </span>
                <div class="mar-row-actions trigger-actions">
                  <MarButton
                    link
                    :icon="activeTriggerId === trigger.id ? 'check' : 'edit'"
                    :aria-expanded="activeTriggerId === trigger.id"
                    :aria-controls="`${notificationHintId}-trigger-${trigger.id}`"
                    :aria-label="
                      msg(activeTriggerId === trigger.id ? 'doneTime' : 'editTime', {
                        number: index + 1
                      })
                    "
                    :disabled="!!pending"
                    @click="
                      activeTriggerId = activeTriggerId === trigger.id ? undefined : trigger.id
                    "
                    >{{
                      activeTriggerId === trigger.id ? msg('doneTimeShort') : msg('editTask')
                    }}</MarButton
                  >
                  <MarButton
                    v-if="form.triggers.length > 1"
                    link
                    icon="close"
                    :aria-label="msg('removeTime', { number: index + 1 })"
                    v-tooltip="msg('removeTime', { number: index + 1 })"
                    :disabled="!!pending"
                    @click="removeTrigger(index)"
                  />
                </div>
              </div>
              <div :id="`${notificationHintId}-trigger-${trigger.id}`">
                <fieldset v-if="activeTriggerId === trigger.id" class="trigger-fields">
                  <legend class="trigger-legend">
                    {{ msg('triggerEditor', { number: index + 1 }) }}
                  </legend>
                  <MarFormItem
                    v-if="trigger.kind !== 'hourly'"
                    :label="msg('timeEntry', { number: index + 1 })"
                    class="trigger-time"
                  >
                    <MarTimePicker
                      :model-value="trigger.time"
                      :placeholder="msg('chooseTime')"
                      :clearable="false"
                      @update:model-value="setTriggerTime(trigger, $event)"
                    />
                  </MarFormItem>
                  <MarFormItem :label="msg('repeatLabel')">
                    <MarRadioGroup v-model="trigger.kind" :aria-label="msg('repeatLabel')">
                      <template v-for="kind in repeatOptions" :key="kind">
                        <MarRadio
                          v-if="kind !== 'hourly' || hourlySupported || trigger.kind === 'hourly'"
                          :value="kind"
                          :disabled="kind === 'hourly' && !hourlySupported"
                          >{{ msg(kind) }}</MarRadio
                        >
                      </template>
                    </MarRadioGroup>
                  </MarFormItem>
                  <MarFormItem
                    v-if="trigger.kind === 'once'"
                    :label="msg('dateEntry', { number: index + 1 })"
                    class="trigger-time"
                  >
                    <MarDatePicker
                      type="date"
                      :model-value="trigger.date ?? trigger.suggestedDate"
                      :placeholder="msg('chooseDate')"
                      :clearable="false"
                      @update:model-value="trigger.date = $event"
                    />
                  </MarFormItem>
                  <MarFormItem
                    v-else-if="trigger.kind === 'hourly'"
                    :label="msg('hourlyMinuteField')"
                  >
                    <MarSelect
                      v-model="trigger.minutes"
                      :placeholder="msg('chooseHourlyMinutes')"
                      :disabled="!hourlySupported"
                      multiple
                      collapse-tags
                      collapse-tags-tooltip
                    >
                      <MarOption
                        v-for="minute in minuteOptions"
                        :key="minute"
                        :label="minuteLabel(minute)"
                        :value="minute"
                      />
                    </MarSelect>
                    <p v-if="!hourlySupported" class="schedule-timezone">
                      {{ msg('hourlyUnavailable') }}
                    </p>
                  </MarFormItem>
                  <MarFormItem v-else-if="trigger.kind === 'weekly'" :label="msg('weekdayField')">
                    <MarSelect
                      v-model="trigger.weekdays"
                      :placeholder="msg('chooseWeekdays')"
                      multiple
                    >
                      <MarOption
                        v-for="day in [1, 2, 3, 4, 5, 6, 0]"
                        :key="day"
                        :label="msg(`weekday${day}`)"
                        :value="day"
                      />
                    </MarSelect>
                  </MarFormItem>
                  <MarFormItem v-else-if="trigger.kind === 'monthly'" :label="msg('monthDayField')">
                    <MarSelect
                      v-model="trigger.monthDays"
                      :placeholder="msg('chooseMonthDays')"
                      multiple
                    >
                      <MarOption
                        v-for="day in monthDayOptions"
                        :key="day"
                        :label="String(day)"
                        :value="day"
                      />
                    </MarSelect>
                  </MarFormItem>
                </fieldset>
              </div>
            </MarFormItem>
          </div>
          <div class="add-trigger">
            <MarButton
              icon="plus"
              :disabled="form.triggers.length >= scheduledTriggerLimit || !!pending"
              @click="addTrigger"
            >
              {{ msg('addTime') }}
            </MarButton>
          </div>
          <div v-if="hasSpecificDates" class="catch-up">
            <MarFormItem :label="msg('catchUp')">
              <MarSwitch
                v-model="allowCatchUp"
                :aria-label="msg('catchUp')"
                :aria-describedby="`${notificationHintId}-catch-up`"
              />
              <small :id="`${notificationHintId}-catch-up`">{{ msg('graceHint') }}</small>
            </MarFormItem>
            <MarFormItem v-if="allowCatchUp" :label="msg('grace')" prop="graceMinutes">
              <MarSelect v-model="form.graceMinutes" filterable>
                <MarOption
                  v-for="minute in graceOptions"
                  :key="minute"
                  :value="minute"
                  :label="String(minute)"
                />
              </MarSelect>
            </MarFormItem>
          </div>
          <section class="preview" aria-live="polite">
            <strong>{{ msg('preview') }}</strong>
            <p v-if="loadingPreview">{{ $t('common.loading') }}</p>
            <p v-else-if="previewError">{{ errorSummary(previewError, msg('loadFailed')) }}</p>
            <p v-else-if="!preview">{{ msg('previewHint') }}</p>
            <p v-else-if="preview.times.length === 0">{{ msg('noUpcoming') }}</p>
            <ol v-else>
              <li v-for="row in preview.times" :key="row.dueAt">
                {{ managementDateTime(row.dueAt, preview.timezone) }}
              </li>
            </ol>
          </section>
        </MarForm>
      </MarTabPane>
    </MarTabs>
    <p v-if="error" role="alert" class="failure">{{ errorSummary(error, msg('saveFailed')) }}</p>
    <template #footer>
      <MarButton
        v-if="saved"
        type="danger"
        plain
        :loading="pending === 'delete'"
        :disabled="!!pending"
        @click="remove"
        >{{ msg('remove') }}</MarButton
      >
      <MarButton :disabled="!!pending" @click="dialog?.handleClose()">{{
        msg('cancel')
      }}</MarButton>
      <MarButton
        type="primary"
        :loading="pending === 'save'"
        :disabled="!!pending"
        @click="submit"
        >{{ msg('save') }}</MarButton
      >
    </template>
  </MarDialog>
</template>

<style scoped>
.editor-section {
  padding-top: 1rem;
}
.fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
}
.wrapping-fields {
  display: flex;
  flex-wrap: wrap;
  align-items: start;
  column-gap: 0.75rem;
}
.wrapping-fields > * {
  flex: 1 1 10rem;
  min-inline-size: 0;
}
.wrapping-fields :deep(.mar-ui-form-item__label) {
  line-height: 1.4;
}
.toggles {
  align-items: start;
}
.toggles :deep(.mar-ui-form-item__content) {
  display: grid;
  align-content: start;
  justify-items: start;
}
.runner-option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.schedule-triggers {
  display: grid;
}
.trigger-item {
  margin: 0;
  border-block-start: 1px solid var(--mar-border-default);
}
.trigger-item:last-child {
  border-block-end: 1px solid var(--mar-border-default);
}
.trigger-item :deep(.mar-ui-form-item__content) {
  display: block;
  min-inline-size: 0;
}
.trigger-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem;
  min-block-size: 3.25rem;
  padding-inline: 0.25rem;
}
.trigger-clock {
  min-inline-size: 4ch;
  font-size: var(--mar-font-size-title);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.trigger-description,
.schedule-timezone {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  overflow-wrap: anywhere;
}
.trigger-fields {
  min-inline-size: 0;
  margin: 0 0 0.75rem;
  padding: 0 0.75rem;
  border: 0;
  border-inline-start: 2px solid var(--mar-border-default);
}
.trigger-legend {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  padding-inline: 0.125rem;
  margin-block-end: 0.375rem;
}
.trigger-time {
  max-inline-size: 15rem;
}
.add-trigger {
  margin-block: 0.75rem;
}
.schedule-timezone {
  margin: 0 0 0.625rem;
}
.catch-up {
  border-block-start: 1px solid var(--mar-border-default);
  padding-block-start: 0.75rem;
}
.catch-up :deep(.mar-ui-form-item__content) {
  gap: 0.375rem 0.75rem;
}
.ownership-hint {
  margin: 0;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}
.preview,
.proposals {
  margin-top: 1rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--mar-border-default);
}
.preview p,
.preview ol,
.multiline {
  margin: 0.375rem 0;
}
.multiline {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.failure {
  color: var(--mar-color-danger-text);
}
small {
  color: var(--mar-text-secondary);
}
@media (max-width: 640px) {
  .fields {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }
}
</style>
