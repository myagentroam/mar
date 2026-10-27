<script setup lang="ts">
import MarIcon from '../common/MarIcon.vue';
import { ElPopover } from 'element-plus';
import WorkbenchRecentSessionList from './WorkbenchRecentSessionList.vue';
import SessionStateBadge from '../common/SessionStateBadge.vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import type {
  RecentRun,
  WorkbenchNotificationService
} from '../../service/workbench-notification-service.js';
import {
  activeRecentRunStatus,
  elapsedDurationLabel,
  recentRunTimeReference
} from '../../util/notification-presentation.js';
import { formatDateTime } from '../../util/time-presentation.js';

const props = defineProps<{
  readonly service: Pick<
    WorkbenchNotificationService,
    'recentRuns' | 'load' | 'sessionGroupState' | 'hasUnreadSession' | 'sessionGroupTarget'
  >;
  readonly mobileMode: boolean;
  readonly mobileOpen?: boolean;
  readonly mobilePresented?: boolean;
  readonly mobilePanelTarget?: HTMLElement | undefined;
}>();
const emit = defineEmits<{
  openRecentRun: [run: RecentRun];
  openSessionTarget: [target: { nodeId: string; workspaceId: string; sessionId: string }];
  'update:mobileOpen': [open: boolean];
}>();
const desktopOpen = ref(false);
const sessionGroup = ref<import('@myagentroam/protocol').SessionGroup>('MAIN');
const groupState = computed(() => props.service.sessionGroupState());
const hasUnreadSessions = computed(
  () => groupState.value.MAIN.unread || groupState.value.CHILD.unread
);
const visibleRuns = computed(() =>
  props.service.recentRuns.value.filter(
    (run) => (run.sessionGroup ?? 'MAIN') === sessionGroup.value
  )
);
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
const entryDescription = computed(() =>
  [
    translate('workbenchNotificationCenter.recentSessionsCount', {
      count: activeSessionCount.value
    }),
    hasUnreadSessions.value ? translate('sessionGroups.unread') : ''
  ]
    .filter(Boolean)
    .join(', ')
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

function onRecentSessionsShortcut(event: KeyboardEvent): void {
  if (
    event.isComposing ||
    event.altKey ||
    !event.shiftKey ||
    (!event.ctrlKey && !event.metaKey) ||
    event.key.toLowerCase() !== 'e' ||
    (event.target instanceof Element && event.target.closest('.terminal-dock') !== null)
  )
    return;
  event.preventDefault();
  if (event.repeat) return;
  if (!props.mobileMode && !open.value) trigger.value?.querySelector('button')?.focus();
  open.value = !open.value;
}

onMounted(() => window.addEventListener('keydown', onRecentSessionsShortcut, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onRecentSessionsShortcut, true));

function openSession(run: RecentRun): void {
  open.value = false;
  emit('openRecentRun', run);
}

function activateGroupMarker(group: import('@myagentroam/protocol').SessionGroup): void {
  const target = props.service.sessionGroupTarget(group);
  if (target === undefined) return;
  open.value = false;
  emit('openSessionTarget', target);
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
        :runs="visibleRuns"
        :has-unread-session="service.hasUnreadSession"
        :session-group="sessionGroup"
        :group-state="groupState"
        @select-group="sessionGroup = $event"
        @activate-group-marker="activateGroupMarker"
        :mobile-mode="false"
        :run-time="runTime"
        @open-recent-run="openSession"
      />
    </ElPopover>
    <span ref="trigger" class="recent-sessions-reference">
      <span
        v-tooltip="{
          content: `${translate('workbenchNotificationCenter.recentSessionsShortcut')}\n${entryDescription}`,
          placement: mobileMode ? 'bottom' : 'right'
        }"
        class="mar-tooltip-control"
        ><button
          type="button"
          :class="['recent-sessions-trigger', { active: open }]"
          :aria-label="translate('workbenchNotificationCenter.recentSessions')"
          :aria-description="entryDescription"
          :aria-expanded="open"
          @click="mobileMode && (open = !open)"
          @keydown.esc.stop="open = false"
        >
          <MarIcon name="recent-sessions" aria-hidden="true" />
          <SessionStateBadge
            v-if="!mobileMode"
            class="recent-sessions-badge"
            :class="{ 'recent-sessions-count-only': activeSessionCount > 0 && !hasUnreadSessions }"
            :running="activeSessionCount"
            :unread="hasUnreadSessions"
          />
          <span
            v-else-if="activeSessionCount > 0 || hasUnreadSessions"
            class="recent-sessions-badge recent-sessions-mobile-badge"
            :class="{ 'recent-sessions-unread-only': activeSessionCount === 0 }"
            aria-hidden="true"
          >
            <SessionStateBadge :running="activeSessionCount" :unread="false" />
            <span v-if="hasUnreadSessions" class="recent-sessions-mobile-unread" />
          </span></button
      ></span>
    </span>
    <Teleport
      v-if="mobileMode && (mobilePresented ?? open) && mobilePanelTarget"
      :to="mobilePanelTarget"
    >
      <WorkbenchRecentSessionList
        :runs="visibleRuns"
        :has-unread-session="service.hasUnreadSession"
        :session-group="sessionGroup"
        :group-state="groupState"
        @select-group="sessionGroup = $event"
        @activate-group-marker="activateGroupMarker"
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
  --recent-sessions-marker-surface: var(--mar-bg-chrome);
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
  --recent-sessions-marker-surface: var(--mar-fill-row-hover);
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}
.recent-sessions-trigger.active {
  --recent-sessions-marker-surface: var(--mar-fill-selection);
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
  right: 0;
  max-width: calc(100% + 2px);
  pointer-events: none;
}
.recent-sessions-count-only {
  right: 4px;
  max-width: calc(100% - 4px);
}
.recent-sessions-badge :deep(.session-state-count) {
  flex: none;
}
.recent-sessions-badge :deep(.session-state-unread) {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
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
.recent-sessions-mobile-badge {
  right: calc(50% - 14px);
  max-width: none;
}
.recent-sessions-mobile-unread {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 6px;
  height: 6px;
  border-radius: 2px;
  background: var(--mar-text-secondary);
  box-shadow: 0 0 0 1px var(--recent-sessions-marker-surface);
}
.recent-sessions-unread-only .recent-sessions-mobile-unread {
  top: 3px;
  right: 1px;
  width: 8px;
  height: 8px;
}
:global(.recent-sessions-popover.el-popover) {
  padding: 0;
}
</style>
