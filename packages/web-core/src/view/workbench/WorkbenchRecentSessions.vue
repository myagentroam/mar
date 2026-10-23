<script setup lang="ts">
import MarIcon from '../common/MarIcon.vue';
import { tooltipOptions } from '../../util/tooltip.js';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { translate } from '../../service/LocalePreferenceService.js';
import type {
  RecentRun,
  WorkbenchNotificationService
} from '../../service/WorkbenchNotificationService.js';
import {
  activeRecentRunStatus,
  elapsedDurationLabel,
  recentRunTimeReference
} from '../../util/notification-presentation.js';
import { formatDateTime } from '../../util/time-presentation.js';

const props = defineProps<{
  readonly service: Pick<WorkbenchNotificationService, 'recentRuns' | 'load'>;
  readonly mobileMode: boolean;
}>();
const emit = defineEmits<{ openRecentRun: [run: RecentRun] }>();
const open = ref(false);
const currentTime = ref(Date.now());
const activeSessionCount = computed(
  () => props.service.recentRuns.value.filter((run) => activeRecentRunStatus(run.status)).length
);
let elapsedTimer: ReturnType<typeof setInterval> | undefined;

const RUN_STATUS_KEYS = {
  STARTING: 'workbenchNotificationCenter.runStatus.STARTING',
  RUNNING: 'workbenchNotificationCenter.runStatus.RUNNING',
  CANCELLING: 'workbenchNotificationCenter.runStatus.CANCELLING',
  SUCCEEDED: 'workbenchNotificationCenter.runStatus.SUCCEEDED',
  FAILED: 'workbenchNotificationCenter.runStatus.FAILED',
  CANCELLED: 'workbenchNotificationCenter.runStatus.CANCELLED',
  INTERRUPTED: 'workbenchNotificationCenter.runStatus.INTERRUPTED'
} as const satisfies Record<RecentRun['status'], string>;

function stopElapsedTimer(): void {
  if (elapsedTimer !== undefined) clearInterval(elapsedTimer);
  elapsedTimer = undefined;
}

watch(open, (visible) => {
  stopElapsedTimer();
  if (!visible) return;
  currentTime.value = Date.now();
  elapsedTimer = setInterval(() => {
    currentTime.value = Date.now();
  }, 1_000);
  void props.service.load().catch(() => undefined);
});
onBeforeUnmount(stopElapsedTimer);

function openSession(run: RecentRun): void {
  open.value = false;
  emit('openRecentRun', run);
}

function runStatusType(
  status: RecentRun['status']
): 'primary' | 'success' | 'danger' | 'warning' | 'info' {
  if (status === 'SUCCEEDED') return 'primary';
  if (status === 'FAILED') return 'danger';
  if (status === 'STARTING' || status === 'RUNNING') return 'success';
  if (status === 'CANCELLING' || status === 'INTERRUPTED') return 'warning';
  return 'info';
}

function runTime(run: RecentRun): string {
  if (!activeRecentRunStatus(run.status)) return formatDateTime(recentRunTimeReference(run));
  return translate('workbenchNotificationCenter.runningElapsed', {
    duration: elapsedDurationLabel(currentTime.value - run.startedAt),
    startedAt: formatDateTime(run.startedAt)
  });
}
</script>

<template>
  <div :class="['recent-sessions-entry', { 'mobile-mode': mobileMode }]">
    <el-popover
      v-model:visible="open"
      trigger="click"
      :hide-after="0"
      :placement="mobileMode ? 'bottom-start' : 'right-start'"
      width="min(390px, calc(100vw - 16px))"
      :show-arrow="false"
      :popper-options="{ modifiers: [{ name: 'preventOverflow', options: { padding: 8 } }] }"
      :persistent="false"
      popper-class="recent-sessions-popover"
    >
      <template #reference>
        <span class="recent-sessions-reference">
          <el-tooltip
            v-bind="tooltipOptions"
            :placement="mobileMode ? 'bottom' : 'right'"
            :content="translate('workbenchNotificationCenter.recentSessions')"
            ><span class="mar-tooltip-control"
              ><button
                type="button"
                :class="['recent-sessions-trigger', { active: open }]"
                :aria-label="translate('workbenchNotificationCenter.recentSessions')"
                :aria-description="
                  translate('workbenchNotificationCenter.recentSessionsCount', {
                    count: activeSessionCount
                  })
                "
                :aria-expanded="open"
                @keydown.esc.stop="open = false"
              >
                <MarIcon name="recent-sessions" aria-hidden="true" />
                <span v-if="activeSessionCount" class="recent-sessions-badge" aria-hidden="true">{{
                  activeSessionCount
                }}</span>
              </button></span
            ></el-tooltip
          >
        </span>
      </template>
      <section
        class="recent-sessions-panel"
        :aria-label="translate('workbenchNotificationCenter.recentSessions')"
        @keydown.esc.stop="open = false"
      >
        <header>{{ translate('workbenchNotificationCenter.recentSessions') }}</header>
        <p v-if="service.recentRuns.value.length === 0" class="recent-sessions-empty">
          {{ translate('workbenchNotificationCenter.noRecentSessions') }}
        </p>
        <ul v-else class="recent-sessions-list">
          <li v-for="run in service.recentRuns.value" :key="`${run.nodeId}:${run.runId}`">
            <button type="button" @click="openSession(run)">
              <el-tooltip
                v-bind="tooltipOptions"
                :content="
                  translate('workbenchNotificationCenter.recentRunTitle', {
                    value0: run.workspaceName ?? run.workspaceId,
                    value1: run.sessionTitle
                  })
                "
                ><span class="recent-session-title">{{
                  translate('workbenchNotificationCenter.recentRunTitle', {
                    value0: run.workspaceName ?? run.workspaceId,
                    value1: run.sessionTitle
                  })
                }}</span></el-tooltip
              >
              <el-tag size="small" :type="runStatusType(run.status)">{{
                translate(RUN_STATUS_KEYS[run.status])
              }}</el-tag>
              <el-tooltip v-bind="tooltipOptions" :content="run.userMessage"
                ><small>{{ run.userMessage }}</small></el-tooltip
              >
              <time :datetime="new Date(recentRunTimeReference(run)).toISOString()">{{
                runTime(run)
              }}</time>
            </button>
          </li>
        </ul>
      </section>
    </el-popover>
  </div>
</template>

<style scoped>
.recent-sessions-entry {
  flex: none;
  width: 100%;
}
.recent-sessions-reference {
  display: flex;
  width: calc(100% - 4px);
  margin: 0 2px;
}
.recent-sessions-reference > .mar-tooltip-control {
  width: 100%;
}
.recent-sessions-trigger {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  min-height: var(--mar-rail-item-height);
  margin: 0;
  padding: 3px 0;
  border: 0;
  border-radius: var(--mar-radius-selection);
  background: transparent;
  color: var(--mar-text-secondary);
  cursor: pointer;
}
.recent-sessions-trigger .mar-icon {
  font-size: 1.25rem;
}
.recent-sessions-trigger:hover {
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}
.recent-sessions-trigger.active {
  background: var(--mar-fill-selection);
  color: var(--mar-color-brand-text);
}
.recent-sessions-trigger:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: -2px;
}
.recent-sessions-badge {
  position: absolute;
  top: calc(50% - 15px);
  right: calc(50% - 14px);
  min-width: 14px;
  border: 1px solid var(--mar-bg-panel);
  border-radius: var(--mar-radius-marker);
  background: var(--mar-color-brand);
  color: var(--mar-color-on-accent);
  font-size: var(--mar-font-size-nano);
  line-height: 13px;
  text-align: center;
}
.mobile-mode {
  width: 36px;
}
.mobile-mode .recent-sessions-reference {
  width: 100%;
  margin: 0;
}
.mobile-mode .recent-sessions-trigger {
  width: 36px;
  min-height: 0;
  height: 36px;
  margin: 0;
  padding: 2px 6px;
}
.mobile-mode .recent-sessions-trigger .mar-icon {
  font-size: 18px;
}
:global(.recent-sessions-popover.el-popover) {
  padding: 0;
}
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
