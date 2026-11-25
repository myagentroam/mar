<script setup lang="ts">
import { computed, useTemplateRef } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarTag } from '@myagentroam/mar-ui/tag';
import { readOverflowText } from '@myagentroam/mar-ui/tooltip';
import { translate } from '../../service/locale-preference-service.js';
import type { ScheduleCard, ScheduleSessionScope } from '../../service/scheduled-task-client.js';
import { managementDateTime } from '../../util/time-presentation.js';

// Presents one summary and emits navigation or task actions; it does not fetch or mutate a task.
const props = defineProps<{ task: ScheduleCard }>();
const emit = defineEmits<{
  details: [];
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
const state = computed(() => {
  const { offline, targetKind, enabled, nextRunAt } = props.task;
  if (offline) return 'offline';
  if (targetKind === 'unbound') return 'unbound';
  if (!enabled) return 'paused';
  return nextRunAt === null ? 'finished' : 'enabled';
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
  emit('details');
}
</script>

<template>
  <li class="card" :class="{ 'card--interactive': !task.offline }" @click="onCardClick">
    <header class="card-heading">
      <h3>
        <MarButton
          v-if="!task.offline"
          ref="titleAction"
          class="card-title-action"
          aria-haspopup="dialog"
          v-tooltip="() => readOverflowText(title)"
          text
          @click="emit('details')"
        >
          <span ref="title" class="clip">{{ task.name }}</span>
        </MarButton>
        <span v-else ref="title" v-tooltip="() => readOverflowText(title)" class="clip">{{
          task.name
        }}</span>
      </h3>
      <MarTag :type="state === 'enabled' ? 'success' : 'info'">{{ msg(state) }}</MarTag>
    </header>

    <p
      ref="workspaceLabel"
      v-tooltip="() => readOverflowText(workspaceLabel)"
      class="workspace-label clip"
    >
      {{ task.nodeName }} · {{ task.workspaceName }}
    </p>
    <p>
      <MarButton
        v-if="sessionTarget"
        class="card-session-action"
        :aria-label="msg('openTaskSession', { name: targetLabel })"
        v-tooltip="() => readOverflowText(sessionLabel)"
        text
        @click="openSession"
      >
        <span ref="sessionLabel" class="clip">{{ targetLabel }}</span>
      </MarButton>
      <span v-else ref="sessionLabel" v-tooltip="() => readOverflowText(sessionLabel)" class="clip">
        {{ targetLabel }}
      </span>
    </p>
    <p v-if="task.objectivePreview" ref="preview" v-tooltip="previewTooltip" class="objective">
      {{ task.objectivePreview }}
    </p>

    <dl class="card-facts">
      <div>
        <dt>{{ msg('owner') }}</dt>
        <dd>{{ task.ownerName ?? msg('notRecorded') }}</dd>
      </div>
      <div>
        <dt>{{ msg('nextRun') }}</dt>
        <dd class="next-run">
          {{ task.nextRunAt === null ? msg('noUpcoming') : managementDateTime(task.nextRunAt) }}
        </dd>
      </div>
      <div v-if="task.offline && task.syncedAt">
        <dt>{{ msg('lastSynced') }}</dt>
        <dd>{{ managementDateTime(task.syncedAt) }}</dd>
      </div>
    </dl>
    <footer class="mar-row-actions mar-row-actions--wrap">
      <MarButton
        v-if="task.mine"
        link
        :disabled="task.offline === true"
        icon="edit"
        @click="emit('edit')"
        >{{ msg('editTask') }}</MarButton
      >
      <MarButton link :disabled="task.offline === true" icon="clock" @click="emit('history')">{{
        msg('history')
      }}</MarButton>
    </footer>
  </li>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  min-inline-size: 0;
  padding: 1rem;
  background: var(--mar-bg-panel);
  border: 1px solid var(--mar-border-default);
  border-block-start-color: color-mix(
    in srgb,
    var(--mar-border-default),
    var(--mar-text-primary) 14%
  );
  border-radius: var(--mar-radius-control);
  box-shadow: inset 0 -2px var(--mar-shadow-soft);
}
.card--interactive {
  cursor: pointer;
}
@media (hover: hover) {
  .card--interactive:hover {
    background: color-mix(in srgb, var(--mar-bg-panel), var(--mar-fill-row-hover) 42%);
    border-block-start-color: var(--mar-border-medium);
  }
}
.card--interactive:active {
  box-shadow: inset 0 1px var(--mar-shadow-soft);
}
.card:has(.card-title-action:focus-visible) {
  outline: 2px solid var(--mar-control-focus);
  outline-offset: 2px;
}
.card-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}
h3 {
  min-inline-size: 0;
  margin: 0;
  font-size: var(--mar-font-size-title);
}
.card-title-action,
.card-session-action {
  display: block;
  max-inline-size: 100%;
  padding: 0;
  border: 0;
  color: inherit;
  font: inherit;
  letter-spacing: inherit;
  text-align: start;
}
@media (hover: hover) {
  .card .card-session-action:hover {
    background: var(--mar-fill-row-hover);
    color: var(--mar-text-primary);
  }
}
.card-title-action:focus-visible {
  outline: none;
}
p {
  margin: 0;
}
.workspace-label,
dt {
  color: var(--mar-text-secondary);
}
.clip {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.objective {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  white-space: pre-line;
}
.card-facts {
  display: grid;
  gap: 0.375rem;
  margin: auto 0 0;
  padding-block: 0.375rem;
}
.card-facts > div {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.125rem 0.5rem;
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.next-run {
  font-variant-numeric: tabular-nums;
}
</style>
