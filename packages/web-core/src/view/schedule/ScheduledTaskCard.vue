<script setup lang="ts">
import { computed, useTemplateRef } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarIconGraphic } from '@myagentroam/mar-ui/icons';
import { MarTag } from '@myagentroam/mar-ui/tag';
import { readOverflowText } from '@myagentroam/mar-ui/tooltip';
import { translate } from '../../service/locale-preference-service.js';
import type { ScheduleCard, ScheduleScope } from '../../service/scheduled-task-client.js';
import { managementDateTime } from '../../util/time-presentation.js';

// Presents one summary and emits navigation or task actions; it does not fetch or mutate a task.
const props = defineProps<{ task: ScheduleCard }>();
const emit = defineEmits<{
  open: [];
  history: [];
  openTarget: [target: ScheduleScope & { sessionId?: string }];
}>();
const msg = (key: string, args?: Record<string, string>) =>
  translate(`generated.scheduledSession.${key}`, args);
const title = useTemplateRef<HTMLElement>('title');
const preview = useTemplateRef<HTMLElement>('preview');
const nodeName = useTemplateRef<HTMLElement>('nodeName');
const session = computed(() =>
  props.task.targetKind === 'existing' ? props.task.sessionId : null
);
const targetLabel = computed(() =>
  session.value !== null
    ? (props.task.sessionTitle ?? session.value)
    : msg(props.task.targetKind === 'newSession' ? 'newSession' : 'unbound')
);
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

function openTarget(sessionId?: string): void {
  const { nodeId, workspaceId } = props.task;
  emit('openTarget', { nodeId, workspaceId, ...(sessionId === undefined ? {} : { sessionId }) });
}
</script>

<template>
  <li class="card">
    <header class="card-heading">
      <span class="schedule-icon"><MarIconGraphic name="calendar-check" aria-hidden="true" /></span>
      <h3>
        <MarButton
          v-if="!task.mine && !task.offline"
          v-tooltip="() => readOverflowText(title)"
          link
          @click="emit('open')"
        >
          <span ref="title" class="clip">{{ task.name }}</span>
        </MarButton>
        <span v-else ref="title" v-tooltip="() => readOverflowText(title)" class="clip">{{
          task.name
        }}</span>
      </h3>
      <MarTag :type="state === 'enabled' ? 'success' : 'info'">{{ msg(state) }}</MarTag>
    </header>

    <div class="resource">
      <MarIconGraphic name="folder" aria-hidden="true" />
      <MarButton
        v-if="!task.offline"
        v-tooltip="msg('openTaskWorkspace', { name: task.workspaceName })"
        class="resource-link"
        link
        @click="openTarget()"
        >{{ task.workspaceName }}</MarButton
      >
      <span v-else class="wrap">{{ task.workspaceName }}</span>
      <span aria-hidden="true">·</span>
      <span ref="nodeName" v-tooltip="() => readOverflowText(nodeName)" class="clip">{{
        task.nodeName
      }}</span>
    </div>
    <div class="resource">
      <MarIconGraphic name="conversation" aria-hidden="true" />
      <MarButton
        v-if="session !== null && !task.offline"
        v-tooltip="msg('openTaskSession', { name: targetLabel })"
        class="resource-link"
        link
        @click="openTarget(session)"
        >{{ targetLabel }}</MarButton
      >
      <span v-else class="wrap">{{ targetLabel }}</span>
    </div>
    <p v-if="task.objectivePreview" ref="preview" v-tooltip="previewTooltip" class="objective">
      {{ task.objectivePreview }}
    </p>

    <dl class="card-facts">
      <div class="next-run">
        <dt><MarIconGraphic name="clock" aria-hidden="true" />{{ msg('nextRun') }}</dt>
        <dd>
          {{ task.nextRunAt === null ? msg('noUpcoming') : managementDateTime(task.nextRunAt) }}
        </dd>
      </div>
      <div>
        <dt>{{ msg('owner') }}</dt>
        <dd>{{ task.ownerName ?? msg('notRecorded') }}</dd>
      </div>
      <div v-if="task.offline && task.syncedAt">
        <dt>{{ msg('lastSynced') }}</dt>
        <dd>{{ managementDateTime(task.syncedAt) }}</dd>
      </div>
    </dl>
    <div class="card-actions mar-row-actions mar-row-actions--wrap">
      <MarButton
        v-if="task.mine"
        link
        :disabled="task.offline === true"
        icon="edit"
        @click="emit('open')"
        >{{ msg('editTask') }}</MarButton
      >
      <MarButton link :disabled="task.offline === true" icon="clock" @click="emit('history')">{{
        msg('history')
      }}</MarButton>
    </div>
  </li>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  min-inline-size: 0;
  padding: 0.875rem;
  border: 1px solid var(--mar-border-default);
  border-radius: var(--mar-radius-surface);
  background: var(--mar-bg-panel);
}
.card-heading {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.5rem;
  margin-block-end: 0.125rem;
}
.schedule-icon {
  display: grid;
  place-items: center;
  inline-size: 2rem;
  block-size: 2rem;
  border-radius: var(--mar-radius-control);
  background: var(--mar-bg-subtle);
  color: var(--mar-text-secondary);
}
.schedule-icon svg {
  inline-size: 1rem;
  block-size: 1rem;
}
h3 {
  margin: 0;
  font-size: var(--mar-font-size-title);
}
h3 :deep(button) {
  max-inline-size: 100%;
  padding-inline: 0;
  color: inherit;
  font-size: inherit;
  font-weight: inherit;
}
.resource,
.next-run dt {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}
.resource {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}
.resource > svg,
.next-run dt > svg {
  flex: none;
  inline-size: 1rem;
  block-size: 1rem;
}
.resource-link {
  min-inline-size: 0;
  padding-inline: 0;
  color: var(--mar-link-text);
  font-size: inherit;
  text-decoration: underline;
  text-underline-offset: 0.16em;
}
.resource-link :deep(.mar-ui-button__label),
.clip {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wrap {
  min-inline-size: 0;
  overflow-wrap: anywhere;
}
.objective {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  white-space: pre-line;
  margin: 0.125rem 0 0.5rem;
}
.card-facts {
  display: grid;
  gap: 0.375rem;
  margin: auto 0 0;
  padding-block-start: 0.375rem;
  font-size: var(--mar-font-size-meta);
}
.card-facts > div {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.125rem 0.5rem;
}
.card-facts .next-run {
  border-radius: var(--mar-radius-control);
  padding: 0.5rem;
  background: var(--mar-bg-subtle);
}
dt {
  color: var(--mar-text-secondary);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.next-run dd {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.card-actions {
  padding-block-start: 0.375rem;
  border-block-start: 1px solid var(--mar-border-subtle);
}
</style>
