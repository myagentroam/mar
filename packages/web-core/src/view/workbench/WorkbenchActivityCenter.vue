<script setup lang="ts">
import '../session/session-markers.css';
import { MarPopover } from '@myagentroam/mar-ui/popover';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { SessionGroup } from '@myagentroam/protocol';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import WorkbenchActivityPanel from './WorkbenchActivityPanel.vue';
import WorkbenchNotificationList from './WorkbenchNotificationList.vue';
import type {
  WorkbenchNotification,
  WorkbenchNotificationView,
  RecentRun
} from '../../service/workbench-notification-service.js';
import type { WorkspaceUploadTask } from '../../service/workspace-upload-service.js';
import { activeRecentRunStatus } from '../../util/notification-presentation.js';
import { translate } from '../../service/locale-preference-service.js';
import { consoleKeyboardShortcutService } from '../../service/console-keyboard-shortcut-service.js';
import { activityToggleKeys, shortcutKeyLabel } from '../../service/console-shortcut-keys.js';

const props = withDefaults(
  defineProps<{
    service: WorkbenchNotificationView;
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
const activeRuns = computed(() =>
  props.service.recentRuns.value.filter((run) => activeRecentRunStatus(run.status))
);
const entryDescription = computed(() =>
  [
    translate('activityCenter.activeTaskCount', { count: activeRuns.value.length }),
    translate('activityCenter.unreadCount', { count: props.service.unreadCount.value })
  ].join(', ')
);
function dismissPreview(): void {
  if (dismissTimer !== undefined) clearTimeout(dismissTimer);
  dismissTimer = undefined;
  // Retain the preview identity while the popover finishes its leave transition.
  previewVisible.value = false;
}
function showPreview(id: string): void {
  dismissPreview();
  previewId.value = id;
  previewVisible.value = true;
  dismissTimer = setTimeout(dismissPreview, 8_000);
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
    if (id !== undefined) showPreview(id);
  }
);
watch(
  [() => props.service.webUpdatePreviewId.value, open, page, () => props.previewSuppressed],
  ([id, panelOpen, currentPage, suppressed]) => {
    if (id === undefined || suppressed || (panelOpen && currentPage !== 'notifications')) return;
    if (props.service.takeWebUpdatePreview(id) && !panelOpen) showPreview(id);
  },
  { immediate: true, flush: 'post' }
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
let unregisterShortcut: (() => void) | undefined;
let unregisterEscape: (() => void) | undefined;
onMounted(() => {
  unregisterShortcut = consoleKeyboardShortcutService.register({
    command: 'activityCenter.toggle',
    priority: 30,
    scope: 'global',
    keys: activityToggleKeys,
    when: () => true,
    execute: (event) => {
      if (!event.repeat) toggle();
      return 'HANDLED';
    }
  });
  unregisterEscape = consoleKeyboardShortcutService.register({
    command: 'activityCenter.dismiss',
    priority: 110,
    scope: 'overlay',
    keys: [{ key: 'Escape' }],
    when: () => popoverOpen.value,
    execute: () => {
      popoverOpen.value = false;
      return 'HANDLED';
    }
  });
});
onBeforeUnmount(() => {
  dismissPreview();
  unregisterShortcut?.();
  unregisterEscape?.();
});
</script>

<template>
  <div class="workbench-activity-center" :class="{ 'mobile-mode': mobileMode }">
    <span ref="trigger" class="activity-reference">
      <button
        class="activity-center-trigger"
        :class="{ active: open }"
        type="button"
        :aria-label="translate('activityCenter.title')"
        :aria-description="entryDescription"
        :aria-keyshortcuts="activityToggleKeys.map((key) => shortcutKeyLabel(key, true)).join(' ')"
        :aria-expanded="open"
        @click.stop="toggle"
      >
        <MarIcon name="recent-sessions" aria-hidden="true" />
        <span
          v-if="service.unreadCount.value > 0"
          class="activity-entry-count mar-activity-count-badge"
          aria-hidden="true"
          >{{ service.unreadCount.value > 99 ? '99+' : service.unreadCount.value }}</span
        >
        <span
          v-if="activeRuns.length > 0"
          class="activity-entry-running mar-icon-status-badge"
          aria-hidden="true"
        />
      </button>
    </span>
    <MarPopover
      v-if="trigger"
      v-model:visible="popoverOpen"
      :virtual-ref="trigger"
      trigger="click"
      :hide-after="0"
      :placement="mobileMode ? 'bottom-start' : 'right-start'"
      width="min(390px, calc(100vw - 16px))"
      :show-arrow="!mobileMode && previewId !== undefined"
      popper-class="workbench-activity-popover mar-content-popover"
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
    </MarPopover>
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
  --activity-marker-surface: var(--mar-bg-page);
  flex: none;
  width: 100%;
}
.activity-reference {
  display: flex;
  width: calc(100% - 4px);
  margin: 0 2px;
}
.activity-center-trigger {
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
  color: var(--mar-text-primary);
}
.activity-center-trigger:focus-visible {
  outline-offset: -2px;
}
.activity-entry-count {
  position: absolute;
  top: max(4px, calc(50% - 18px));
  right: max(4px, calc(50% - 18px));
  box-shadow: 0 0 0 1.5px var(--activity-marker-surface);
  pointer-events: none;
}
.activity-entry-running {
  --mar-icon-status-surface: var(--activity-marker-surface);
  bottom: calc(50% - 13px);
  right: calc(50% - 13px);
}
.workbench-activity-center.mobile-mode {
  --activity-marker-surface: var(--mar-bg-chrome);
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
  max-height: min(24rem, calc(100dvh - var(--mar-sidebar-header-height) - 1rem));
  border-radius: inherit;
  overflow: hidden;
}
:global(.workbench-activity-popover.mar-ui-popover) {
  --mar-ui-popup-padding: 0;
}
:global(.workbench-activity-popover > .mar-ui-popup__content) {
  overflow: visible;
}
</style>
