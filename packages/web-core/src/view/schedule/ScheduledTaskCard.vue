<script setup lang="ts">
import { computed, useTemplateRef } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import { readOverflowText } from '@myagentroam/mar-ui/tooltip';
import { translate } from '../../service/locale-preference-service.js';
import type { ScheduleCard, ScheduleSessionScope } from '../../service/scheduled-task-client.js';
import { managementDateTime } from '../../util/time-presentation.js';

// Presents one summary and emits navigation or task actions; it does not fetch or mutate a task.
const props = defineProps<{ task: ScheduleCard }>();
const emit = defineEmits<{
  edit: [];
  history: [];
  openTarget: [target: ScheduleSessionScope];
}>();
const msg = (key: string, args?: Record<string, string>) =>
  translate(`generated.scheduledSession.${key}`, args);
const titleAction = useTemplateRef<InstanceType<typeof MarButton>>('titleAction');
const title = useTemplateRef<HTMLElement>('title');
const preview = useTemplateRef<HTMLElement>('preview');
const workspaceLabel = useTemplateRef<HTMLElement>('workspaceLabel');
const sessionLabel = useTemplateRef<HTMLElement>('sessionLabel');
const session = computed(() =>
  props.task.targetKind === 'existing' ? props.task.sessionId : null
);
const targetLabel = computed(() =>
  session.value !== null
    ? (props.task.sessionTitle ?? session.value)
    : msg(props.task.targetKind === 'newSession' ? 'newSession' : 'unbound')
);
const sessionTarget = computed<ScheduleSessionScope | undefined>(() => {
  const { offline, nodeId, workspaceId } = props.task;
  const sessionId = session.value;
  if (!offline && sessionId !== null) return { nodeId, workspaceId, sessionId };
});
const repeatedSessionTitle = computed(
  () => sessionTarget.value !== undefined && targetLabel.value === props.task.name
);
const sessionActionLabel = computed(() => msg('openTaskSession', { name: targetLabel.value }));
const state = computed(() => {
  const { offline, targetKind, enabled, nextRunAt } = props.task;
  if (offline) return 'offline';
  if (targetKind === 'unbound') return 'unbound';
  if (!enabled) return 'paused';
  return nextRunAt === null ? 'finished' : 'enabled';
});
const nextRun = computed(() => {
  const timestamp = props.task.nextRunAt;
  if (timestamp === null) return undefined;
  const [date, clock] = managementDateTime(timestamp).split(' ');
  return { date, clock: clock!.slice(0, 5), iso: new Date(timestamp).toISOString() };
});
const previewTooltip = () => {
  const element = preview.value;
  return element && element.scrollHeight > element.clientHeight
    ? props.task.objectivePreview
    : undefined;
};

function openSession(): void {
  const target = sessionTarget.value;
  if (target) emit('openTarget', target);
}

function onCardClick(event: MouseEvent): void {
  if (props.task.offline || (event.target as Element).closest('button')) return;
  const card = event.currentTarget as HTMLElement;
  const selection = card.ownerDocument.getSelection();
  if (
    selection?.rangeCount &&
    !selection.isCollapsed &&
    selection.getRangeAt(0).intersectsNode(card)
  )
    return;
  titleAction.value?.focus({ preventScroll: true });
  emit('edit');
}
</script>

<template>
  <li class="card" :class="{ 'card--interactive': !task.offline }" @click="onCardClick">
    <article class="card-layout">
      <header class="card-heading">
        <h3>
          <MarButton
            v-if="!task.offline"
            ref="titleAction"
            class="card-title-action"
            aria-haspopup="dialog"
            v-tooltip="() => readOverflowText(title)"
            text
            @click="emit('edit')"
          >
            <span ref="title" class="clip">{{ task.name }}</span>
          </MarButton>
          <span v-else ref="title" v-tooltip="() => readOverflowText(title)" class="clip">{{
            task.name
          }}</span>
        </h3>
        <div class="card-context">
          <span
            ref="workspaceLabel"
            v-tooltip="() => readOverflowText(workspaceLabel)"
            class="clip"
          >
            {{ task.nodeName }} · {{ task.workspaceName }}
          </span>
          <MarButton
            v-if="sessionTarget"
            class="card-session-action"
            :aria-label="sessionActionLabel"
            v-tooltip="
              () => (repeatedSessionTitle ? sessionActionLabel : readOverflowText(sessionLabel))
            "
            text
            icon="external-link"
            @click="openSession"
          >
            <span v-if="!repeatedSessionTitle" ref="sessionLabel" class="clip">{{
              targetLabel
            }}</span>
          </MarButton>
          <span
            v-else
            ref="sessionLabel"
            v-tooltip="() => readOverflowText(sessionLabel)"
            class="clip"
            >{{ targetLabel }}</span
          >
        </div>
      </header>

      <p v-if="task.objectivePreview" ref="preview" v-tooltip="previewTooltip" class="objective">
        {{ task.objectivePreview }}
      </p>

      <dl class="card-schedule">
        <div>
          <dt>{{ msg('nextRun') }}</dt>
          <dd>
            <time v-if="nextRun" class="next-run" :datetime="nextRun.iso">
              <span class="run-clock">{{ nextRun.clock }}</span>
              <span class="run-date">{{ nextRun.date }}</span>
            </time>
            <span v-else class="no-upcoming">{{ msg('noUpcoming') }}</span>
          </dd>
        </div>
        <div class="schedule-state">
          <dt class="state-label">{{ msg('historyStatus') }}</dt>
          <dd :class="{ 'state--attention': state === 'unbound' }">{{ msg(state) }}</dd>
        </div>
        <div class="card-meta">
          <dt>{{ msg('owner') }}</dt>
          <dd>{{ task.ownerName ?? msg('notRecorded') }}</dd>
        </div>
        <div v-if="task.offline && task.syncedAt" class="card-meta">
          <dt>{{ msg('lastSynced') }}</dt>
          <dd>{{ managementDateTime(task.syncedAt) }}</dd>
        </div>
      </dl>

      <footer class="card-actions mar-row-actions mar-row-actions--wrap">
        <MarButton link :disabled="task.offline === true" icon="clock" @click="emit('history')">{{
          msg('history')
        }}</MarButton>
      </footer>
    </article>
  </li>
</template>

<style scoped>
.card {
  container: schedule-card / inline-size;
  min-inline-size: 0;
  padding: 1rem;
  background: var(--mar-bg-panel);
  border: 1px solid color-mix(in srgb, var(--mar-border-subtle) 48%, var(--mar-bg-panel));
  border-radius: var(--mar-radius-surface);
}
.card--interactive {
  cursor: pointer;
}
@media (hover: hover) {
  .card--interactive:hover:not(:has(.card-session-action:hover)) {
    background: color-mix(in srgb, var(--mar-bg-panel), var(--mar-fill-row-hover) 34%);
  }
}
.card:has(.card-title-action:focus-visible) {
  outline: 2px solid var(--mar-control-focus);
  outline-offset: 2px;
}
.card-layout {
  display: grid;
  min-block-size: 100%;
  grid-template-areas: 'heading' 'objective' 'schedule' 'actions';
  gap: 0.5rem 1.125rem;
}
.card-heading {
  grid-area: heading;
  min-inline-size: 0;
}
h3 {
  margin: 0;
  font-size: var(--mar-font-size-title);
  font-weight: 600;
  line-height: 1.35;
}
.card-title-action,
.card-session-action {
  max-inline-size: 100%;
  padding: 0;
  border: 0;
  font: inherit;
  letter-spacing: inherit;
  text-align: start;
}
.card-title-action {
  display: block;
  color: inherit;
}
.card-context {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin-block-start: 0.25rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}
.card-context > * {
  min-inline-size: 0;
}
.card-session-action {
  flex-shrink: 0;
  max-inline-size: 48%;
  --mar-ui-button-hover-bg: transparent;
  --mar-ui-button-active-bg: transparent;
  --mar-ui-button-hover-fg: var(--mar-text-primary);
  color: var(--mar-text-secondary);
}
.card-session-action :deep(.mar-ui-button__label) {
  min-inline-size: 0;
}
.card-title-action:focus-visible {
  outline: none;
}
p {
  margin: 0;
}
.clip {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.objective {
  grid-area: objective;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-clamp: 2;
  overflow: clip;
  overflow-wrap: anywhere;
  white-space: pre-line;
  color: var(--mar-text-secondary);
}
.card-schedule {
  grid-area: schedule;
  display: grid;
  align-content: start;
  gap: 0.25rem;
  margin: 0;
  font-size: var(--mar-font-size-meta);
  color: var(--mar-text-secondary);
}
.card-meta {
  display: flex;
  flex-wrap: wrap;
  color: var(--mar-text-muted);
  gap: 0.125rem 0.5rem;
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.next-run {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.125rem 0.5rem;
  font-variant-numeric: tabular-nums;
}
.run-clock {
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-title);
  font-weight: 600;
  line-height: 1.2;
}
.no-upcoming {
  display: block;
  padding-block: 0.25rem;
  color: var(--mar-text-muted);
}
.schedule-state {
  font-weight: 500;
}
.state-label {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.state--attention {
  color: var(--mar-color-warning-text);
}
.card-layout .card-actions {
  grid-area: actions;
  align-self: end;
  min-inline-size: 0;
  flex-wrap: wrap;
}
@container schedule-card (inline-size >= 23rem) {
  .card-layout {
    grid-template-areas: 'heading schedule' 'objective schedule' 'actions schedule';
    grid-template-columns: minmax(0, 1fr) minmax(0, 34%);
    grid-template-rows: auto 1fr auto;
  }
  .next-run {
    flex-direction: column;
  }
}
</style>
