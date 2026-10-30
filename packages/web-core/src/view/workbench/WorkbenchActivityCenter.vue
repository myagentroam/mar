<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElPopover } from 'element-plus';
import type { SessionGroup } from '@myagentroam/protocol';
import MarIcon from '../common/MarIcon.vue';
import WorkbenchActivityPanel from './WorkbenchActivityPanel.vue';
import WorkbenchNotificationList from './WorkbenchNotificationList.vue';
import type {
  WorkbenchNotification,
  WorkbenchNotificationService,
  RecentRun
} from '../../service/workbench-notification-service.js';
import type { WorkspaceUploadTask } from '../../service/workspace-upload-service.js';
import { activeRecentRunStatus } from '../../util/notification-presentation.js';
import { translate } from '../../service/locale-preference-service.js';

const props = withDefaults(
  defineProps<{
    service: WorkbenchNotificationService;
    uploads: readonly WorkspaceUploadTask[];
    statusLabel: (task: WorkspaceUploadTask) => string;
    mobileMode: boolean;
    mobileOpen?: boolean;
    mobilePresented?: boolean | undefined;
    mobilePanelTarget?: HTMLElement | undefined;
    previewSuppressed?: boolean;
  }>(),
  { mobilePresented: undefined }
);
const emit = defineEmits<{
  'update:mobileOpen': [open: boolean];
  openRecentRun: [run: RecentRun];
  openNotification: [notification: WorkbenchNotification];
  retryUpload: [task: WorkspaceUploadTask];
  cancelUpload: [task: WorkspaceUploadTask];
  removeUpload: [task: WorkspaceUploadTask];
}>();
const trigger = ref<HTMLElement>();
const desktopOpen = ref(false);
const page = ref<'recent-sessions' | 'notifications'>('recent-sessions');
const sessionGroup = ref<SessionGroup>('MAIN');
const previewId = ref<string>();
const previewVisible = ref(false);
let dismissTimer: ReturnType<typeof setTimeout> | undefined;
const open = computed({
  get: () => (props.mobileMode ? props.mobileOpen === true : desktopOpen.value),
  set: (value: boolean) => {
    if (props.mobileMode) emit('update:mobileOpen', value);
    else desktopOpen.value = value;
  }
});
const popoverOpen = computed({
  get: () => previewVisible.value || (!props.mobileMode && open.value),
  set: (value: boolean) => {
    if (!value) {
      dismissPreview();
      if (!props.mobileMode) open.value = false;
    }
  }
});
const runningCount = computed(
  () => props.service.recentRuns.value.filter((run) => activeRecentRunStatus(run.status)).length
);
const entryDescription = computed(() =>
  [
    translate('activityCenter.runningCount', { count: runningCount.value }),
    translate('activityCenter.unreadCount', { count: props.service.unreadCount.value })
  ].join(', ')
);
function dismissPreview(): void {
  if (dismissTimer !== undefined) clearTimeout(dismissTimer);
  dismissTimer = undefined;
  // Retain the preview identity while the popover finishes its leave transition.
  previewVisible.value = false;
}
watch(
  open,
  (visible) => {
    dismissPreview();
    if (!visible) return;
    previewId.value = undefined;
    page.value = props.service.unreadCount.value > 0 ? 'notifications' : 'recent-sessions';
    void props.service.load().catch(() => undefined);
  },
  { immediate: true }
);
watch(
  () => props.service.notificationRevision.value,
  () => {
    if (open.value || props.previewSuppressed) return;
    const id = props.service.previewNotificationId.value;
    if (id === undefined) return;
    dismissPreview();
    previewId.value = id;
    previewVisible.value = true;
    dismissTimer = setTimeout(dismissPreview, 8_000);
  }
);
watch(
  () => props.previewSuppressed,
  (suppressed) => {
    if (suppressed) dismissPreview();
  }
);
watch(
  () => props.service.notifications.value,
  (notifications) => {
    if (previewId.value !== undefined && !notifications.some((item) => item.id === previewId.value))
      dismissPreview();
  }
);
watch(
  () => props.mobileMode,
  () => {
    desktopOpen.value = false;
    dismissPreview();
  }
);
function toggle(): void {
  dismissPreview();
  open.value = !open.value;
}
function selectNotification(notification: WorkbenchNotification): void {
  dismissPreview();
  open.value = false;
  emit('openNotification', notification);
}
function selectRun(run: RecentRun): void {
  open.value = false;
  emit('openRecentRun', run);
}
function onShortcut(event: KeyboardEvent): void {
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
  toggle();
}
function onEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !popoverOpen.value) return;
  event.stopPropagation();
  popoverOpen.value = false;
}
onMounted(() => {
  window.addEventListener('keydown', onShortcut, true);
  window.addEventListener('keydown', onEscape);
});
onBeforeUnmount(() => {
  dismissPreview();
  window.removeEventListener('keydown', onShortcut, true);
  window.removeEventListener('keydown', onEscape);
});
</script>

<template>
  <div class="workbench-activity-center" :class="{ 'mobile-mode': mobileMode }">
    <span ref="trigger" class="activity-reference">
      <span
        v-tooltip="{
          content: `${translate('activityCenter.shortcut')}\n${entryDescription}`,
          placement: mobileMode ? 'bottom' : 'right'
        }"
        class="mar-tooltip-control"
      >
        <button
          class="activity-center-trigger"
          :class="{ active: open }"
          type="button"
          :aria-label="translate('activityCenter.title')"
          :aria-description="entryDescription"
          :aria-expanded="open"
          @click.stop="toggle"
        >
          <MarIcon name="recent-sessions" aria-hidden="true" />
          <span
            v-if="service.unreadCount.value > 0"
            class="activity-entry-count"
            aria-hidden="true"
            >{{ service.unreadCount.value > 99 ? '99+' : service.unreadCount.value }}</span
          >
          <span v-if="runningCount > 0" class="activity-entry-running" aria-hidden="true" />
        </button>
      </span>
    </span>
    <ElPopover
      v-if="trigger"
      v-model:visible="popoverOpen"
      virtual-triggering
      :virtual-ref="trigger"
      trigger="click"
      :trigger-keys="[]"
      :hide-after="0"
      :placement="mobileMode ? 'bottom-start' : 'right-start'"
      width="min(390px, calc(100vw - 16px))"
      :show-arrow="false"
      :popper-options="{ modifiers: [{ name: 'preventOverflow', options: { padding: 8 } }] }"
      :persistent="false"
      popper-class="workbench-activity-popover"
    >
      <WorkbenchNotificationList
        v-if="previewId !== undefined"
        class="activity-preview"
        :service="service"
        :uploads="uploads"
        :status-label="statusLabel"
        :preview-id="previewId"
        @open-notification="selectNotification"
        @retry-upload="emit('retryUpload', $event)"
        @cancel-upload="emit('cancelUpload', $event)"
        @remove-upload="emit('removeUpload', $event)"
      />
      <WorkbenchActivityPanel
        v-else-if="!mobileMode"
        v-model:page="page"
        v-model:session-group="sessionGroup"
        :service="service"
        :uploads="uploads"
        :status-label="statusLabel"
        :mobile-mode="false"
        @open-recent-run="selectRun"
        @open-notification="selectNotification"
        @retry-upload="emit('retryUpload', $event)"
        @cancel-upload="emit('cancelUpload', $event)"
        @remove-upload="emit('removeUpload', $event)"
      />
    </ElPopover>
    <Teleport
      v-if="mobileMode && (mobilePresented ?? open) && mobilePanelTarget"
      :to="mobilePanelTarget"
    >
      <WorkbenchActivityPanel
        v-model:page="page"
        v-model:session-group="sessionGroup"
        :service="service"
        :uploads="uploads"
        :status-label="statusLabel"
        :mobile-mode="true"
        @open-recent-run="selectRun"
        @open-notification="selectNotification"
        @retry-upload="emit('retryUpload', $event)"
        @cancel-upload="emit('cancelUpload', $event)"
        @remove-upload="emit('removeUpload', $event)"
      />
    </Teleport>
  </div>
</template>

<style scoped>
.workbench-activity-center {
  flex: none;
  width: 100%;
}
.activity-reference {
  display: flex;
  width: calc(100% - 4px);
  margin: 0 2px;
}
.activity-reference > .mar-tooltip-control {
  width: 100%;
}
.activity-center-trigger {
  --activity-marker-surface: var(--mar-bg-chrome);
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
.activity-center-trigger .mar-icon {
  font-size: 1.25rem;
}
.activity-center-trigger:hover {
  --activity-marker-surface: var(--mar-fill-row-hover);
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}
.activity-center-trigger.active {
  --activity-marker-surface: var(--mar-fill-selection);
  background: var(--mar-fill-selection);
  color: var(--mar-color-brand-text);
}
.activity-center-trigger:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: -2px;
}
.activity-entry-count {
  position: absolute;
  top: calc(50% - 18px);
  right: calc(50% - 18px);
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  box-sizing: border-box;
  padding: 0 4px;
  border-radius: var(--mar-radius-marker);
  background: var(--mar-color-brand);
  color: var(--mar-color-on-accent);
  box-shadow: 0 0 0 1.5px var(--activity-marker-surface);
  font-size: var(--mar-font-size-nano);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  line-height: 16px;
  pointer-events: none;
}
.activity-entry-running {
  position: absolute;
  bottom: calc(50% - 13px);
  right: calc(50% - 13px);
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--mar-color-brand);
  box-shadow: 0 0 0 1.5px var(--activity-marker-surface);
  pointer-events: none;
}
.workbench-activity-center.mobile-mode {
  width: 36px;
}
.mobile-mode .activity-reference {
  width: 100%;
  margin: 0;
}
.mobile-mode .activity-center-trigger {
  width: 36px;
  min-height: 0;
  height: 36px;
  padding: 2px 6px;
}
.mobile-mode .activity-center-trigger .mar-icon {
  font-size: 22px;
}
.activity-preview {
  max-height: min(24rem, calc(100dvh - var(--sidebar-header-height) - 1rem));
}
:global(.workbench-activity-popover.el-popover) {
  padding: 0;
}
</style>
