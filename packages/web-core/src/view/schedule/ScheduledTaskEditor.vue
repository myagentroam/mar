<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, useId, watch } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarForm, MarFormItem, type FormInstance, type FormRules } from '@myagentroam/mar-ui/form';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarOption, MarSelect } from '@myagentroam/mar-ui/select';
import { MarSwitch } from '@myagentroam/mar-ui/switch';
import { MarTabPane, MarTabs } from '@myagentroam/mar-ui/tabs';
import { MarMessageBox } from '../../service/message-box-service.js';
import type { ScheduledTarget, ScheduledTimeGroup } from '@myagentroam/protocol';
import type { RunnerProfile, Session, Workspace } from '../../model/workbench.js';
import { errorSummary } from '../../util/error-presentation.js';
import { managementDateTime } from '../../util/time-presentation.js';
import { translate } from '../../service/locale-preference-service.js';
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import type {
  ScheduleDetail,
  ScheduleDraft,
  ScheduleNode,
  ScheduleSessionScope,
  ScheduleTaskKey,
  scheduledTaskClient
} from '../../service/scheduled-task-client.js';
import { parseTimeDraft, timeDraft } from './scheduled-time-draft.js';

// One dialog owns one draft and cancels its dependent reads when the scope or dialog changes.
const props = defineProps<{
  client: ReturnType<typeof scheduledTaskClient>;
  nodes: ScheduleNode[];
  initial?: ScheduleSessionScope | undefined;
  editing?: { key: ScheduleTaskKey; detail: ScheduleDetail } | undefined;
}>();
const emit = defineEmits<{ close: []; changed: [] }>();
const notificationHintId = useId();
const msg = (key: string, args?: Record<string, string | number>) =>
  translate(`generated.scheduledSession.${key}`, args);
const editing = props.editing;
const saved = editing?.detail.task;
const readOnly = editing?.detail.mine === false;
let nextId = 1;
const form = reactive({
  nodeId: editing?.key.nodeId ?? props.initial?.nodeId ?? '',
  workspaceId: editing?.key.workspaceId ?? props.initial?.workspaceId ?? '',
  targetKind: saved?.newSession
    ? 'newSession'
    : saved?.sessionId || props.initial
      ? 'existing'
      : '',
  sessionId: saved?.sessionId ?? props.initial?.sessionId ?? '',
  runner: saved?.newSession?.runner ?? '',
  model: saved?.newSession?.model.kind === 'fixed' ? saved.newSession.model.modelId : '',
  modelKind: saved?.newSession?.model.kind ?? '',
  effort: saved?.newSession?.effort ?? '',
  name: saved?.name ?? '',
  objective: saved?.objective ?? '',
  enabled: saved?.enabled ?? true,
  notifyOnTerminal: saved?.notifyOnTerminal ?? false,
  graceMinutes: String(saved?.graceMinutes ?? 60),
  groups: saved?.groups.map((group) => timeDraft(nextId++, group)) ?? [timeDraft(nextId++)]
});
const dialog = ref<{ handleClose(): void }>();
const taskForm = ref<FormInstance & { $el: HTMLElement }>();
const timeForm = ref<FormInstance & { $el: HTMLElement }>();
const tab = ref('task');
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
const selection = computed(() => ({ nodeId: form.nodeId, workspaceId: form.workspaceId }));
const node = computed(() => props.nodes.find((item) => item.id === form.nodeId));
const targetReady = computed(
  () => node.value?.connected && node.value.supported !== false && form.workspaceId !== ''
);
const profile = computed(() => profiles.value.find((item) => item.runner === form.runner));
const model = computed(() => profile.value?.models.find((item) => item.id === form.model));
const parsedGroups = computed(() => form.groups.map(parseTimeDraft));
const checkedGroups = () =>
  parsedGroups.value.flatMap((group) => (group.success ? [group.data] : []));
const newSessionSupported = computed(() => node.value?.newSessionSupported !== false);
const initialDraft = JSON.stringify(form);
const modelOptions = computed(
  () => profile.value?.models.filter((item) => !item.subagentModel) ?? []
);

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
  modelKind: [{ required: true, message: msg('modelRequired') }],
  model: [{ validator: () => model.value !== undefined || new Error(msg('modelRequired')) }],
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
        (/^\d{1,2}$/.test(form.graceMinutes) && Number(form.graceMinutes) <= 60) ||
        new Error(msg('graceHint'))
    }
  ]
};
const timeRules = computed<FormRules>(() => ({
  graceMinutes: rules.graceMinutes,
  ...Object.fromEntries(
    form.groups.map((_, index) => [
      `groups.${index}`,
      [{ validator: () => parsedGroups.value[index]?.success || new Error(msg('groupInvalid')) }]
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
  form.modelKind = '';
  form.effort = '';
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
    if (!targetReady.value) return;
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
        profiles.value = result.profiles.filter((item) => item.models.length > 0);
    } catch (failure) {
      if (!read.signal.aborted) profileError.value = failure;
    } finally {
      if (!read.signal.aborted) loadingProfiles.value = false;
    }
  },
  { immediate: true }
);

watch(
  () => ({ target: selection.value, available: targetReady.value, groups: parsedGroups.value }),
  ({ target, available, groups }, _, onCleanup) => {
    preview.value = undefined;
    previewError.value = undefined;
    loadingPreview.value = false;
    if (!available || groups.some((group) => !group.success)) return;
    const read = new AbortController();
    const timer = setTimeout(async () => {
      loadingPreview.value = true;
      try {
        const result = await props.client.preview(target, checkedGroups(), read.signal, saved?.id);
        if (!read.signal.aborted) preview.value = result;
      } catch (failure) {
        if (!read.signal.aborted) previewError.value = failure;
      } finally {
        if (!read.signal.aborted) loadingPreview.value = false;
      }
    }, 250);
    onCleanup(() => {
      clearTimeout(timer);
      read.abort();
    });
  },
  { immediate: true }
);

function target(): ScheduledTarget {
  return form.targetKind === 'existing'
    ? { kind: 'existing', sessionId: form.sessionId }
    : {
        kind: 'newSession',
        runner: form.runner as Extract<ScheduledTarget, { kind: 'newSession' }>['runner'],
        model:
          form.modelKind === 'fixed' ? { kind: 'fixed', modelId: form.model } : { kind: 'default' },
        ...(form.effort ? { effort: form.effort } : {})
      };
}
async function submit() {
  if (pending.value || readOnly) return;
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
      await nextTick();
      timeForm.value?.$el.querySelector('[role="alert"]')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (!alive.value) return;
    const draft: ScheduleDraft = {
      name: form.name,
      objective: form.objective,
      target: target(),
      groups: checkedGroups(),
      enabled: form.enabled,
      notifyOnTerminal: form.notifyOnTerminal,
      graceMinutes: Number(form.graceMinutes)
    };
    if (editing && saved) await props.client.update(editing.key, saved.revision, draft);
    else await props.client.create(selection.value, draft);
    if (alive.value) emit('changed');
  } catch (failure) {
    if (alive.value) error.value = failure;
  } finally {
    pending.value = undefined;
  }
}
async function resolve(id: string, accept: boolean) {
  if (!editing || pending.value) return;
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
async function beforeClose(done: (cancel?: boolean) => void) {
  if (pending.value) return;
  if (!readOnly && initialDraft !== JSON.stringify(form)) {
    try {
      await MarMessageBox.confirm(msg('discardConfirm'), msg('discard'), { type: 'warning' });
    } catch {
      return;
    }
  }
  if (alive.value) done();
}
onBeforeUnmount(() => {
  alive.value = false;
});
function groupsFromProposal(groups: ScheduledTimeGroup[]): string {
  return groups
    .map((group, i) => {
      const draft = timeDraft(i, group);
      const dates =
        draft.dayKind === 'weekdays'
          ? draft.weekdays.map((day) => msg(`weekday${day}`)).join(', ')
          : draft.dates || draft.monthDays || msg('anyDay');
      return `${dates} · ${draft.times || `${draft.hours} × ${draft.minutes}`}`;
    })
    .join('\n');
}
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
          :disabled="readOnly || !!pending"
          label-position="top"
          :aria-label="msg('taskTab')"
          @submit.prevent="submit"
        >
          <div class="fields">
            <MarFormItem :label="msg('node')" prop="nodeId">
              <MarSelect
                v-model="form.nodeId"
                :disabled="!!saved || undefined"
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
                :disabled="!form.nodeId || !!saved || undefined"
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
          <MarFormItem :label="msg('target')" prop="targetKind">
            <MarSelect
              v-model="form.targetKind"
              :disabled="!targetReady || undefined"
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
            <MarSelect v-model="form.sessionId" filterable :loading="loadingTargets">
              <MarOption
                v-if="
                  form.sessionId &&
                  !sessions.some((item) => (item.externalSessionId ?? item.id) === form.sessionId)
                "
                :label="form.sessionId"
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
          <template v-if="form.targetKind === 'newSession'">
            <MarFormItem :label="msg('runner')" prop="runner">
              <MarSelect v-model="form.runner" :loading="loadingProfiles" @change="clearModel">
                <MarOption
                  v-for="item in profiles"
                  :key="item.runner"
                  :label="item.runner"
                  :value="item.runner"
                />
              </MarSelect>
              <small v-if="profileError" role="alert">{{
                errorSummary(profileError, msg('loadFailed'))
              }}</small>
            </MarFormItem>
            <MarFormItem :label="msg('modelPolicy')" prop="modelKind">
              <MarSelect
                v-model="form.modelKind"
                @change="
                  form.model = '';
                  form.effort = '';
                "
              >
                <MarOption :label="msg('defaultModel')" value="default" />
                <MarOption :label="msg('fixedModel')" value="fixed" />
              </MarSelect>
            </MarFormItem>
            <div v-if="form.modelKind === 'fixed'" class="fields">
              <MarFormItem :label="msg('model')" prop="model">
                <MarSelect v-model="form.model" filterable @change="form.effort = ''">
                  <MarOption
                    v-for="item in modelOptions"
                    :key="item.id"
                    :label="item.label"
                    :value="item.id"
                  />
                </MarSelect>
              </MarFormItem>
              <MarFormItem v-if="model?.supportedEfforts.length" :label="msg('effort')">
                <MarSelect v-model="form.effort" clearable>
                  <MarOption
                    v-for="effort in model.supportedEfforts"
                    :key="effort"
                    :label="effort"
                    :value="effort"
                  />
                </MarSelect>
              </MarFormItem>
            </div>
          </template>
          <MarFormItem :label="msg('name')" prop="name"
            ><MarInput v-model="form.name" maxlength="160"
          /></MarFormItem>
          <MarFormItem :label="msg('objective')" prop="objective"
            ><MarInput v-model="form.objective" type="textarea" :rows="5" maxlength="20000"
          /></MarFormItem>
          <div class="fields toggles">
            <MarFormItem :label="msg('enabled')"><MarSwitch v-model="form.enabled" /></MarFormItem>
            <MarFormItem :label="msg('terminalNotifications')">
              <MarSwitch v-model="form.notifyOnTerminal" :aria-describedby="notificationHintId" />
              <small :id="notificationHintId">{{ msg('notifyUserHint') }}</small>
            </MarFormItem>
          </div>
          <section
            v-if="editing?.detail.proposals.length"
            class="proposals"
            :aria-label="msg('proposals')"
          >
            <h3>{{ msg('proposals') }}</h3>
            <article v-for="proposal in editing.detail.proposals" :key="proposal.id">
              <strong v-if="proposal.name">{{ proposal.name }}</strong>
              <p v-if="proposal.objective" class="multiline">{{ proposal.objective }}</p>
              <p v-if="proposal.groups" class="multiline">
                {{ groupsFromProposal(proposal.groups) }}
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
          :disabled="readOnly || !!pending"
          label-position="top"
          :aria-label="msg('timeTab')"
          @submit.prevent="submit"
        >
          <fieldset v-for="(group, index) in form.groups" :key="group.id" class="time-group">
            <legend>{{ msg('group', { number: index + 1 }) }}</legend>
            <div class="fields">
              <MarFormItem :label="msg('days')">
                <MarSelect v-model="group.dayKind">
                  <MarOption
                    v-for="kind in ['anyDay', 'weekdays', 'monthDays', 'dates']"
                    :key="kind"
                    :value="kind"
                    :label="msg(kind)"
                  />
                </MarSelect>
              </MarFormItem>
              <MarFormItem :label="msg('time')">
                <MarSelect v-model="group.timeKind">
                  <MarOption :label="msg('explicitTimes')" value="times" />
                  <MarOption :label="msg('timeGrid')" value="grid" />
                </MarSelect>
              </MarFormItem>
            </div>
            <MarFormItem v-if="group.dayKind === 'weekdays'" :label="msg('weekdays')">
              <MarSelect v-model="group.weekdays" multiple>
                <MarOption
                  v-for="day in [1, 2, 3, 4, 5, 6, 0]"
                  :key="day"
                  :label="msg(`weekday${day}`)"
                  :value="day"
                />
              </MarSelect>
            </MarFormItem>
            <MarFormItem v-if="group.dayKind === 'dates'" :label="msg('dates')"
              ><MarInput v-model="group.dates" /><small>{{ msg('datesHint') }}</small></MarFormItem
            >
            <MarFormItem v-if="group.dayKind === 'monthDays'" :label="msg('monthDays')"
              ><MarInput v-model="group.monthDays" /><small>{{
                msg('monthDaysHint')
              }}</small></MarFormItem
            >
            <MarFormItem v-if="group.dayKind !== 'dates'" :label="msg('months')"
              ><MarInput v-model="group.months" /><small>{{
                msg('monthsHint')
              }}</small></MarFormItem
            >
            <MarFormItem
              :label="msg(group.timeKind === 'times' ? 'explicitTimes' : 'timeGrid')"
              :prop="`groups.${index}`"
            >
              <div v-if="group.timeKind === 'times'" class="time-values">
                <MarInput v-model="group.times" /><small>{{ msg('timesHint') }}</small>
              </div>
              <div v-else class="fields time-values">
                <MarFormItem :label="msg('hours')"
                  ><MarInput v-model="group.hours" /><small>{{
                    msg('hoursHint')
                  }}</small></MarFormItem
                >
                <MarFormItem :label="msg('minutes')"
                  ><MarInput v-model="group.minutes" /><small>{{
                    msg('minutesHint')
                  }}</small></MarFormItem
                >
              </div>
            </MarFormItem>
            <MarButton
              v-if="!readOnly && form.groups.length > 1"
              link
              :disabled="!!pending"
              @click="form.groups.splice(index, 1)"
              >{{ msg('removeGroup') }}</MarButton
            >
          </fieldset>
          <MarButton
            v-if="!readOnly"
            :disabled="form.groups.length >= 16 || !!pending"
            @click="form.groups.push(timeDraft(nextId++))"
            >{{ msg('addGroup') }}</MarButton
          >
          <MarFormItem :label="msg('grace')" prop="graceMinutes"
            ><MarInput v-model="form.graceMinutes" inputmode="numeric" maxlength="2" /><small>{{
              msg('graceHint')
            }}</small></MarFormItem
          >
          <section class="preview" aria-live="polite">
            <strong>{{ msg('preview') }}</strong>
            <p v-if="preview">{{ msg('nodeTimezone', { timezone: preview.timezone }) }}</p>
            <p v-else-if="saved">{{ msg('nodeTimezone', { timezone: saved.timezone }) }}</p>
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
        v-if="saved && !readOnly"
        type="danger"
        link
        :loading="pending === 'delete'"
        :disabled="!!pending"
        @click="remove"
        >{{ msg('remove') }}</MarButton
      >
      <MarButton :disabled="!!pending" @click="dialog?.handleClose()">{{
        msg(readOnly ? 'close' : 'cancel')
      }}</MarButton>
      <MarButton
        v-if="!readOnly"
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
.toggles {
  align-items: start;
}
.toggles :deep(.mar-ui-form-item__content) {
  display: grid;
  align-content: start;
  justify-items: start;
}
.time-values {
  width: 100%;
}
.time-group {
  border: 1px solid var(--mar-border-default);
  border-radius: var(--mar-radius-control);
  margin: 0 0 0.75rem;
  min-width: 0;
  padding: 0.75rem;
}
.time-group legend {
  color: var(--mar-text-secondary);
  padding-inline: 0.375rem;
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
