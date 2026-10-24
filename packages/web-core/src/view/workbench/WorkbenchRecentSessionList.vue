<script setup lang="ts">
import { translate } from '../../service/LocalePreferenceService.js';
import type { RecentRun } from '../../service/WorkbenchNotificationService.js';
import { recentRunTimeReference } from '../../util/notification-presentation.js';

defineProps<{
  readonly runs: readonly RecentRun[];
  readonly mobileMode: boolean;
  readonly runTime: (run: RecentRun) => string;
}>();
const emit = defineEmits<{ openRecentRun: [run: RecentRun] }>();
const RUN_STATUS_KEYS = {
  STARTING: 'workbenchNotificationCenter.runStatus.STARTING',
  RUNNING: 'workbenchNotificationCenter.runStatus.RUNNING',
  CANCELLING: 'workbenchNotificationCenter.runStatus.CANCELLING',
  SUCCEEDED: 'workbenchNotificationCenter.runStatus.SUCCEEDED',
  FAILED: 'workbenchNotificationCenter.runStatus.FAILED',
  CANCELLED: 'workbenchNotificationCenter.runStatus.CANCELLED',
  INTERRUPTED: 'workbenchNotificationCenter.runStatus.INTERRUPTED'
} as const satisfies Record<RecentRun['status'], string>;

function runStatusType(
  status: RecentRun['status']
): 'primary' | 'success' | 'danger' | 'warning' | 'info' {
  if (status === 'SUCCEEDED') return 'primary';
  if (status === 'FAILED') return 'danger';
  if (status === 'STARTING' || status === 'RUNNING') return 'success';
  if (status === 'CANCELLING' || status === 'INTERRUPTED') return 'warning';
  return 'info';
}
</script>

<template>
  <section
    class="recent-sessions-panel"
    :class="{ 'drawer-mode': mobileMode }"
    :aria-label="translate('workbenchNotificationCenter.recentSessions')"
  >
    <header v-if="!mobileMode">
      {{ translate('workbenchNotificationCenter.recentSessions') }}
    </header>
    <p v-if="runs.length === 0" class="recent-sessions-empty">
      {{ translate('workbenchNotificationCenter.noRecentSessions') }}
    </p>
    <ul v-else class="recent-sessions-list">
      <li v-for="run in runs" :key="`${run.nodeId}:${run.runId}`">
        <button
          v-tooltip="
            translate('workbenchNotificationCenter.recentRunTitle', {
              value0: run.workspaceName ?? run.workspaceId,
              value1: run.sessionTitle
            })
          "
          type="button"
          @click="emit('openRecentRun', run)"
        >
          <span class="recent-session-title">{{
            translate('workbenchNotificationCenter.recentRunTitle', {
              value0: run.workspaceName ?? run.workspaceId,
              value1: run.sessionTitle
            })
          }}</span>
          <el-tag size="small" :type="runStatusType(run.status)">{{
            translate(RUN_STATUS_KEYS[run.status])
          }}</el-tag>
          <small v-tooltip="run.userMessage">{{ run.userMessage }}</small>
          <time :datetime="new Date(recentRunTimeReference(run)).toISOString()">{{
            runTime(run)
          }}</time>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.recent-sessions-panel {
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - var(--sidebar-header-height) - 2rem - env(safe-area-inset-bottom, 0px));
  overflow: hidden;
}
.recent-sessions-panel > header {
  flex: none;
  padding: 0.55rem 0.7rem;
  border-bottom: 1px solid var(--mar-border-default);
  font-size: var(--mar-font-size-meta);
  font-weight: 600;
  color: var(--mar-text-primary);
}
.recent-sessions-panel.drawer-mode {
  max-height: none;
  overflow: visible;
}
.drawer-mode .recent-sessions-list {
  overflow: visible;
}
.recent-sessions-empty {
  margin: 0;
  padding: 1.2rem;
  color: var(--mar-text-muted);
  text-align: center;
  font-size: var(--mar-font-size-meta);
}
.recent-sessions-list {
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  list-style: none;
}
.recent-sessions-list > li {
  border-bottom: 1px solid var(--mar-fill-hover);
}
.recent-sessions-list button {
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.12rem 0.6rem;
  padding: 0.32rem 0.65rem;
  border: 0;
  background: transparent;
  color: var(--mar-text-primary);
  font: inherit;
  font-size: var(--mar-font-size-meta);
  text-align: left;
  cursor: pointer;
}
.recent-sessions-list button:hover {
  background: var(--mar-fill-row-hover);
}
.recent-sessions-list button:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: -2px;
}
.recent-session-title,
.recent-sessions-list small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.recent-session-title {
  font-weight: 500;
  line-height: 1.35;
}
.recent-sessions-list small {
  grid-column: 1 / -1;
  grid-row: 2;
  color: var(--mar-text-muted);
  font-size: inherit;
}
.recent-sessions-list .el-tag {
  grid-column: 2;
  justify-self: end;
}
.recent-sessions-list .el-tag {
  grid-row: 1;
  height: 20px;
  padding: 0 0.38rem;
  font-size: inherit;
  line-height: 18px;
}
.recent-sessions-list time {
  grid-column: 1 / -1;
  grid-row: 3;
  min-width: 0;
  max-width: 100%;
  justify-self: start;
  align-self: center;
  color: var(--mar-text-muted);
}
.recent-sessions-list .el-tag--success {
  --el-tag-text-color: var(--mar-color-success-text);
}
</style>
