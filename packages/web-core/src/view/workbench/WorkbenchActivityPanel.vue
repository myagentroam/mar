<script setup lang="ts">
import '../session/session-markers.css';
import { computed, onBeforeUnmount, ref } from 'vue';
import { MarTabs, MarTabPane } from '@myagentroam/mar-ui/tabs';
import type { SessionGroup } from '@myagentroam/protocol';
import type {
  WorkbenchNotification,
  WorkbenchNotificationView,
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
  service: WorkbenchNotificationView;
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
</script>

<template>
  <section
    class="workbench-activity-panel"
    :class="{ 'mobile-mode': mobileMode }"
    :aria-label="translate('activityCenter.title')"
  >
    <MarTabs
      class="activity-tabs"
      appearance="workbench"
      :model-value="page"
      :label="translate('activityCenter.title')"
      @update:model-value="emit('update:page', $event)"
    >
      <template #label="{ tab }">
        <span class="mar-tab-label">{{ tab.label }}</span>
        <span
          v-if="tab.name === 'notifications' && service.unreadCount.value > 0"
          class="activity-unread-count mar-activity-count-badge"
          aria-hidden="true"
          >{{ service.unreadCount.value > 99 ? '99+' : service.unreadCount.value }}</span
        >
      </template>
      <MarTabPane
        name="recent-sessions"
        :label="translate('workbenchNotificationCenter.recentSessions')"
        class="activity-tabpanel activity-recent-content"
      >
        <template v-if="page === 'recent-sessions'">
          <p class="activity-running-count">
            {{ translate('activityCenter.activeTaskCount', { count: activeCount }) }}
          </p>
          <WorkbenchRecentSessionList
            :runs="visibleRuns"
            :snapshot-state="service.snapshotState.value"
            :retry-snapshot="service.load"
            :has-unread-session="service.hasUnreadSession"
            :session-group="sessionGroup"
            :run-time="runTime"
            @select-group="emit('update:sessionGroup', $event)"
            @open-recent-run="emit('openRecentRun', $event)"
          />
        </template>
      </MarTabPane>
      <MarTabPane
        name="notifications"
        :label="translate('generated.workbenchNotificationCenter.notifications')"
        :description="translate('activityCenter.unreadCount', { count: service.unreadCount.value })"
        class="activity-tabpanel activity-notification-content"
      >
        <WorkbenchNotificationList
          v-if="page === 'notifications'"
          :service="service"
          :uploads="uploads"
          :status-label="statusLabel"
          @open-notification="emit('openNotification', $event)"
          @retry-upload="emit('retryUpload', $event)"
          @cancel-upload="emit('cancelUpload', $event)"
          @remove-upload="emit('removeUpload', $event)"
        />
      </MarTabPane>
    </MarTabs>
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
.workbench-activity-panel:not(.mobile-mode) {
  border-radius: inherit;
  overflow: clip;
}
.activity-tabpanel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.activity-notification-content {
  flex: 1;
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
