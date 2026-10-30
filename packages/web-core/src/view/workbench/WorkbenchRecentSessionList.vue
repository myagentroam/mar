<script setup lang="ts">
import { translate } from '../../service/locale-preference-service.js';
import SessionGroupTabs from '../common/SessionGroupTabs.vue';
import type { RecentRun } from '../../service/workbench-notification-service.js';
import { recentRunTimeReference } from '../../util/notification-presentation.js';

defineProps<{
  readonly sessionGroup: import('@myagentroam/protocol').SessionGroup;
  readonly runs: readonly RecentRun[];
  readonly hasUnreadSession: (nodeId: string, workspaceId: string, sessionId: string) => boolean;
  readonly mobileMode: boolean;
  readonly runTime: (run: RecentRun) => string;
}>();
const emit = defineEmits<{
  openRecentRun: [run: RecentRun];
  selectGroup: [group: import('@myagentroam/protocol').SessionGroup];
}>();
const RUN_STATUS_KEYS = {
  STARTING: 'workbenchNotificationCenter.runStatus.STARTING',
  RUNNING: 'workbenchNotificationCenter.runStatus.RUNNING',
  CANCELLING: 'workbenchNotificationCenter.runStatus.CANCELLING',
  SUCCEEDED: 'workbenchNotificationCenter.runStatus.SUCCEEDED',
  FAILED: 'workbenchNotificationCenter.runStatus.FAILED',
  CANCELLED: 'workbenchNotificationCenter.runStatus.CANCELLED',
  INTERRUPTED: 'workbenchNotificationCenter.runStatus.INTERRUPTED'
} as const satisfies Record<RecentRun['status'], string>;

function runDisplayStatus(run: RecentRun): RecentRun['status'] {
  return run.status === 'INTERRUPTED' && run.interruptionReason === 'USER_STOP'
    ? 'CANCELLED'
    : run.status;
}

function runStatusType(run: RecentRun): 'success' | 'danger' | 'warning' | 'info' {
  const status = runDisplayStatus(run);
  if (status === 'SUCCEEDED') return 'info';
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
    <SessionGroupTabs
      class="recent-session-groups"
      :model-value="sessionGroup"
      @update:model-value="emit('selectGroup', $event)"
    />
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
          <span class="recent-session-heading">
            <span class="recent-session-title">{{
              translate('workbenchNotificationCenter.recentRunTitle', {
                value0: run.workspaceName ?? run.workspaceId,
                value1: run.sessionTitle
              })
            }}</span>
            <span
              v-if="hasUnreadSession(run.nodeId, run.workspaceId, run.sessionId)"
              class="recent-session-unread mar-unread-label"
              >{{ translate('sessionGroups.unread') }}</span
            >
          </span>
          <el-tag size="small" :type="runStatusType(run)">{{
            translate(RUN_STATUS_KEYS[runDisplayStatus(run)])
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
  min-height: 0;
  overflow: hidden;
}
.recent-session-groups {
  margin-inline: 0.35rem;
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
.recent-session-heading {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.25rem;
}
.recent-session-title,
.recent-sessions-list small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.recent-session-title {
  font-weight: 400;
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
