<script setup lang="ts">
import MarIcon from '../common/MarIcon.vue';
import { ElPopover } from 'element-plus';
import WorkbenchRecentSessionList from './WorkbenchRecentSessionList.vue';
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
  readonly mobileOpen?: boolean;
  readonly mobilePresented?: boolean;
  readonly mobilePanelTarget?: HTMLElement | undefined;
}>();
const emit = defineEmits<{
  openRecentRun: [run: RecentRun];
  'update:mobileOpen': [open: boolean];
}>();
const desktopOpen = ref(false);
const trigger = ref<HTMLElement>();
const open = computed({
  get: () => (props.mobileMode ? props.mobileOpen === true : desktopOpen.value),
  set: (value: boolean) => {
    if (props.mobileMode) emit('update:mobileOpen', value);
    else desktopOpen.value = value;
  }
});
watch(
  () => props.mobileMode,
  () => {
    desktopOpen.value = false;
  }
);
const currentTime = ref(Date.now());
const activeSessionCount = computed(
  () => props.service.recentRuns.value.filter((run) => activeRecentRunStatus(run.status)).length
);
let elapsedTimer: ReturnType<typeof setInterval> | undefined;

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
    <ElPopover
      v-if="!mobileMode && trigger"
      v-model:visible="open"
      virtual-triggering
      :virtual-ref="trigger"
      trigger="click"
      :hide-after="0"
      placement="right-start"
      width="min(390px, calc(100vw - 16px))"
      :show-arrow="false"
      :popper-options="{ modifiers: [{ name: 'preventOverflow', options: { padding: 8 } }] }"
      :persistent="false"
      popper-class="recent-sessions-popover"
    >
      <WorkbenchRecentSessionList
        :runs="service.recentRuns.value"
        :mobile-mode="false"
        :run-time="runTime"
        @open-recent-run="openSession"
      />
    </ElPopover>
    <span ref="trigger" class="recent-sessions-reference">
      <span
        v-tooltip="{
          content: translate('workbenchNotificationCenter.recentSessions'),
          placement: mobileMode ? 'bottom' : 'right'
        }"
        class="mar-tooltip-control"
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
          @click="mobileMode && (open = !open)"
          @keydown.esc.stop="open = false"
        >
          <MarIcon name="recent-sessions" aria-hidden="true" />
          <span v-if="activeSessionCount" class="recent-sessions-badge" aria-hidden="true">{{
            activeSessionCount
          }}</span>
        </button></span
      >
    </span>
    <Teleport
      v-if="mobileMode && (mobilePresented ?? open) && mobilePanelTarget"
      :to="mobilePanelTarget"
    >
      <WorkbenchRecentSessionList
        :runs="service.recentRuns.value"
        :mobile-mode="true"
        :run-time="runTime"
        @open-recent-run="openSession"
      />
    </Teleport>
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
  font-size: 22px;
}
:global(.recent-sessions-popover.el-popover) {
  padding: 0;
}
</style>
