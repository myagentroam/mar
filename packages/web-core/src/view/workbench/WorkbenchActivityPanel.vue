<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import type { SessionGroup } from '@myagentroam/protocol';
import type {
  WorkbenchNotification,
  WorkbenchNotificationService,
  RecentRun
} from '../../service/workbench-notification-service.js';
import type { WorkspaceUploadTask } from '../../service/workspace-upload-service.js';
import { translate } from '../../service/locale-preference-service.js';
import {
  activeRecentRunStatus,
  elapsedDurationLabel,
  recentRunTimeReference
} from '../../util/notification-presentation.js';
import { formatDateTime } from '../../util/time-presentation.js';
import WorkbenchRecentSessionList from './WorkbenchRecentSessionList.vue';
import WorkbenchNotificationList from './WorkbenchNotificationList.vue';

const props = defineProps<{
  service: WorkbenchNotificationService;
  uploads: readonly WorkspaceUploadTask[];
  statusLabel: (task: WorkspaceUploadTask) => string;
  page: 'recent-sessions' | 'notifications';
  sessionGroup: SessionGroup;
  mobileMode: boolean;
}>();
const emit = defineEmits<{
  'update:page': [value: 'recent-sessions' | 'notifications'];
  'update:sessionGroup': [value: SessionGroup];
  openRecentRun: [run: RecentRun];
  openNotification: [notification: WorkbenchNotification];
  retryUpload: [task: WorkspaceUploadTask];
  cancelUpload: [task: WorkspaceUploadTask];
  removeUpload: [task: WorkspaceUploadTask];
}>();
const tabs = ['recent-sessions', 'notifications'] as const;
const visibleRuns = computed(() =>
  props.service.recentRuns.value.filter(
    (run) => (run.sessionGroup ?? 'MAIN') === props.sessionGroup
  )
);
const activeCount = computed(
  () => props.service.recentRuns.value.filter((run) => activeRecentRunStatus(run.status)).length
);
const currentTime = ref(Date.now());
const timer = setInterval(() => {
  currentTime.value = Date.now();
}, 1_000);
onBeforeUnmount(() => clearInterval(timer));
function runTime(run: RecentRun): string {
  if (!activeRecentRunStatus(run.status)) return formatDateTime(recentRunTimeReference(run));
  return translate('workbenchNotificationCenter.runningElapsed', {
    duration: elapsedDurationLabel(currentTime.value - run.startedAt),
    startedAt: formatDateTime(run.startedAt)
  });
}
function navigate(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next =
    event.key === 'Home'
      ? tabs[0]
      : event.key === 'End'
        ? tabs[1]
        : props.page === tabs[0]
          ? tabs[1]
          : tabs[0];
  emit('update:page', next);
  (event.currentTarget as HTMLElement).parentElement
    ?.querySelector<HTMLButtonElement>(`[data-page="${next}"]`)
    ?.focus();
}
</script>

<template>
  <section
    class="workbench-activity-panel"
    :class="{ 'mobile-mode': mobileMode }"
    :aria-label="translate('activityCenter.title')"
  >
    <div class="activity-tabs" role="tablist" :aria-label="translate('activityCenter.title')">
      <button
        v-for="tab in tabs"
        :key="tab"
        type="button"
        role="tab"
        :data-page="tab"
        :aria-selected="page === tab"
        :aria-description="
          tab === 'notifications'
            ? translate('activityCenter.unreadCount', { count: service.unreadCount.value })
            : undefined
        "
        :tabindex="page === tab ? 0 : -1"
        @click="emit('update:page', tab)"
        @keydown="navigate"
      >
        {{
          translate(
            tab === 'recent-sessions'
              ? 'workbenchNotificationCenter.recentSessions'
              : 'generated.workbenchNotificationCenter.notifications'
          )
        }}
        <span
          v-if="tab === 'notifications' && service.unreadCount.value > 0"
          class="activity-unread-count mar-activity-count-badge"
          aria-hidden="true"
          >{{ service.unreadCount.value > 99 ? '99+' : service.unreadCount.value }}</span
        >
      </button>
    </div>
    <div
      v-if="page === 'recent-sessions'"
      class="activity-recent-content"
      role="tabpanel"
      :aria-label="translate('workbenchNotificationCenter.recentSessions')"
    >
      <p class="activity-running-count">
        {{ translate('activityCenter.runningCount', { count: activeCount }) }}
      </p>
      <WorkbenchRecentSessionList
        :runs="visibleRuns"
        :has-unread-session="service.hasUnreadSession"
        :session-group="sessionGroup"
        :mobile-mode="mobileMode"
        :run-time="runTime"
        @select-group="emit('update:sessionGroup', $event)"
        @open-recent-run="emit('openRecentRun', $event)"
      />
    </div>
    <WorkbenchNotificationList
      v-else
      role="tabpanel"
      :service="service"
      :uploads="uploads"
      :status-label="statusLabel"
      @open-notification="emit('openNotification', $event)"
      @retry-upload="emit('retryUpload', $event)"
      @cancel-upload="emit('cancelUpload', $event)"
      @remove-upload="emit('removeUpload', $event)"
    />
  </section>
</template>

<style scoped>
.workbench-activity-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: min(38rem, calc(100dvh - 2rem));
  color: var(--mar-text-primary);
}
.workbench-activity-panel.mobile-mode {
  flex: 1;
  height: 100%;
  max-height: none;
}
.activity-tabs {
  flex: none;
  display: flex;
  align-items: stretch;
  gap: 0.25rem;
  padding: 0.45rem 0.65rem 0;
  border-bottom: 1px solid var(--mar-border-default);
}
.activity-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  border: 0;
  border-radius: var(--mar-radius-control) var(--mar-radius-control) 0 0;
  padding: 0.5rem 0.65rem;
  background: transparent;
  color: var(--mar-text-secondary);
  font: inherit;
  font-size: var(--mar-font-size-meta);
  cursor: pointer;
}
.activity-tabs button:hover {
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}
.activity-tabs button[aria-selected='true'] {
  background: var(--mar-fill-selection);
  color: var(--mar-text-primary);
}
.activity-tabs button:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: -2px;
}
.activity-recent-content {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.activity-running-count {
  flex: none;
  margin: 0;
  padding: 0.5rem 0.65rem 0.25rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  font-variant-numeric: tabular-nums;
}
</style>
