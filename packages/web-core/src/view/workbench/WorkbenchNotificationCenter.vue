<script setup lang="ts">
import MarIcon from '../common/MarIcon.vue';
import { formatDateTime as notificationTime } from '../../util/time-presentation.js';
import { translate } from '../../service/locale-preference-service.js';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { fileSizeLabel } from '../../util/file-presentation.js';
import type { WorkspaceUploadTask } from '../../service/workspace-upload-service.js';
import type {
  WorkbenchNotification,
  WorkbenchNotificationService
} from '../../service/workbench-notification-service.js';

const props = defineProps<{
  readonly service: WorkbenchNotificationService;
  readonly uploads: readonly WorkspaceUploadTask[];
  readonly statusLabel: (task: WorkspaceUploadTask) => string;
  readonly triggerLabel?: string;
  readonly mobileMode?: boolean;
  readonly mobileOpen?: boolean;
  readonly mobilePresented?: boolean;
  readonly mobilePanelTarget?: HTMLElement | undefined;
}>();

const transferTasks = computed(() =>
  props.uploads.filter(
    (task) =>
      task.status === 'QUEUED' ||
      task.status === 'UPLOADING' ||
      task.status === 'FAILED' ||
      task.status === 'INTERRUPTED'
  )
);
const activeUploadIds = computed(
  () => new Set(transferTasks.value.map((task) => `upload:${task.id}`))
);
const visibleNotifications = computed(() => {
  return props.service.notifications.value.filter(
    (notification) => !activeUploadIds.value.has(notification.id)
  );
});
const autoPreview = ref(false);
const desktopOpen = ref(false);
const open = computed({
  get: () =>
    props.mobileMode && !autoPreview.value ? props.mobileOpen === true : desktopOpen.value,
  set: (value: boolean) => {
    if (props.mobileMode && !autoPreview.value) emit('update:mobileOpen', value);
    else desktopOpen.value = value;
  }
});
const center = ref<HTMLElement>();
const panel = ref<HTMLElement>();
let dismissTimer: ReturnType<typeof setTimeout> | undefined;
const AUTO_PREVIEW_MS = 8_000;
const previewTransferTasks = computed(() => {
  if (!autoPreview.value) return transferTasks.value;
  const newest = props.service.notifications.value.find(
    (item) => item.id === props.service.previewNotificationId.value
  );
  if (newest === undefined || !newest.id.startsWith('upload:')) return [];
  const task = transferTasks.value.find((item) => `upload:${item.id}` === newest.id);
  return task === undefined ? [] : [task];
});
const previewNotifications = computed(() => {
  if (!autoPreview.value) return visibleNotifications.value;
  const newest = props.service.notifications.value.find(
    (item) => item.id === props.service.previewNotificationId.value
  );
  return newest === undefined || activeUploadIds.value.has(newest.id) ? [] : [newest];
});

watch(
  () => props.service.notificationRevision.value,
  (revision, previous) => {
    if (revision === 0 || previous === undefined) return;
    showTemporarily();
  }
);

function showTemporarily(): void {
  if (props.mobileMode && props.mobileOpen) return;
  if (dismissTimer !== undefined) clearTimeout(dismissTimer);
  autoPreview.value = true;
  open.value = true;
  dismissTimer = setTimeout(() => {
    dismissTimer = undefined;
    open.value = false;
  }, AUTO_PREVIEW_MS);
}

function toggle(): void {
  if (dismissTimer !== undefined) clearTimeout(dismissTimer);
  dismissTimer = undefined;
  if (autoPreview.value) {
    desktopOpen.value = false;
    autoPreview.value = false;
    open.value = true;
    void props.service.load().catch(() => undefined);
    return;
  }
  open.value = !open.value;
  if (open.value) void props.service.load().catch(() => undefined);
}

function remove(id: string): void {
  props.service.remove(id);
}

function openNotification(notification: WorkbenchNotification): void {
  if (dismissTimer !== undefined) clearTimeout(dismissTimer);
  dismissTimer = undefined;
  desktopOpen.value = false;
  autoPreview.value = false;
  open.value = false;
  emit('openNotification', notification);
}

function closeWhenOutside(event: Event): void {
  if (props.mobileMode && !autoPreview.value) return;
  const target = event.target;
  if (
    !open.value ||
    !(target instanceof Node) ||
    center.value?.contains(target) ||
    panel.value?.contains(target)
  )
    return;
  if (dismissTimer !== undefined) clearTimeout(dismissTimer);
  dismissTimer = undefined;
  autoPreview.value = false;
  open.value = false;
}

onMounted(() => {
  document.addEventListener('pointerdown', closeWhenOutside);
  document.addEventListener('focusin', closeWhenOutside);
});
onBeforeUnmount(() => {
  if (dismissTimer !== undefined) clearTimeout(dismissTimer);
  document.removeEventListener('pointerdown', closeWhenOutside);
  document.removeEventListener('focusin', closeWhenOutside);
});

watch(
  () => props.mobileMode,
  () => {
    if (dismissTimer !== undefined) clearTimeout(dismissTimer);
    dismissTimer = undefined;
    desktopOpen.value = false;
    autoPreview.value = false;
  }
);

const emit = defineEmits<{
  'update:mobileOpen': [open: boolean];
  openNotification: [notification: WorkbenchNotification];
  retryUpload: [task: WorkspaceUploadTask];
  cancelUpload: [task: WorkspaceUploadTask];
  removeUpload: [task: WorkspaceUploadTask];
}>();
</script>

<template>
  <div ref="center" :class="['workbench-notification-center', { 'mobile-mode': mobileMode }]">
    <span
      v-tooltip="translate('generated.workbenchNotificationCenter.openNotificationCenter')"
      class="mar-tooltip-control"
      ><button
        :class="[
          'workbench-notification-trigger',
          'icon-button',
          { 'utility-control': !mobileMode }
        ]"
        type="button"
        :aria-label="translate('generated.workbenchNotificationCenter.openNotificationCenter')"
        :aria-expanded="open"
        @click="toggle"
      >
        <MarIcon name="notification" aria-hidden="true" />
        <span v-if="triggerLabel" class="workbench-notification-trigger-label">{{
          triggerLabel
        }}</span>
        <span v-if="service.unreadCount.value" class="workbench-notification-badge">{{
          service.unreadCount.value
        }}</span>
      </button></span
    >
    <Teleport :to="mobileMode && !autoPreview ? (mobilePanelTarget ?? 'body') : 'body'">
      <Transition name="workbench-notification-panel">
        <aside
          v-if="
            (mobileMode && !autoPreview ? (mobilePresented ?? open) : open) &&
            (!mobileMode || autoPreview || mobilePanelTarget)
          "
          ref="panel"
          :class="[
            'workbench-notification-panel',
            { 'mobile-mode': mobileMode, 'drawer-mode': mobileMode && !autoPreview }
          ]"
          :aria-label="translate('generated.workbenchNotificationCenter.notificationCenter')"
        >
          <header v-if="!mobileMode || autoPreview || service.unreadCount.value > 0">
            <strong v-if="!mobileMode || autoPreview">{{
              translate('generated.workbenchNotificationCenter.notifications')
            }}</strong>
            <el-button
              v-if="service.unreadCount.value > 0"
              class="workbench-notification-mark-all utility-control"
              link
              @click="service.markAllRead()"
            >
              {{ translate('generated.workbenchNotificationCenter.markAllRead') }}
            </el-button>
          </header>
          <div class="workbench-notification-section">
            <section
              v-if="previewTransferTasks.length"
              class="workbench-notification-upload-list"
              :aria-label="translate('generated.workbenchNotificationCenter.fileTransfers')"
            >
              <div
                v-for="task in previewTransferTasks"
                :key="task.id"
                class="workbench-notification-upload"
              >
                <MarIcon name="upload" />
                <div>
                  <strong v-tooltip="task.name">{{ task.name }}</strong>
                  <small>
                    <span class="workbench-upload-size"
                      >{{ fileSizeLabel(task.receivedBytes) }} /
                      {{ fileSizeLabel(task.size) }}</span
                    >
                    ·
                    {{ statusLabel(task) }}
                    <template v-if="task.error"> · {{ task.error }}</template>
                    <template v-if="task.cleanupUnconfirmed">
                      · {{ translate('errors.UPLOAD_CLEANUP_UNCONFIRMED') }}</template
                    >
                  </small>
                  <progress :value="task.receivedBytes" :max="Math.max(task.size, 1)" />
                </div>
                <div class="workbench-notification-upload-actions">
                  <el-button
                    v-if="task.status === 'FAILED' || task.status === 'INTERRUPTED'"
                    class="utility-control"
                    link
                    @click="emit('retryUpload', task)"
                  >
                    {{
                      task.file === undefined
                        ? translate('generated.workbenchNotificationCenter.resume')
                        : translate('generated.workbenchNotificationCenter.retry')
                    }}
                  </el-button>
                  <button
                    v-if="task.status === 'FAILED' || task.status === 'INTERRUPTED'"
                    type="button"
                    class="icon-button utility-control workbench-notification-delete"
                    :aria-label="
                      translate('generated.workbenchNotificationCenter.delete', {
                        value0: task.name
                      })
                    "
                    @click="emit('removeUpload', task)"
                  >
                    <MarIcon name="delete" />
                  </button>
                  <el-button
                    v-else
                    class="utility-control"
                    link
                    @click="emit('cancelUpload', task)"
                  >
                    {{ translate('generated.workbenchNotificationCenter.cancel') }}
                  </el-button>
                </div>
              </div>
            </section>
            <p
              v-if="previewNotifications.length === 0 && previewTransferTasks.length === 0"
              class="workbench-notification-empty"
            >
              {{ translate('generated.workbenchNotificationCenter.noNotifications') }}
            </p>
            <ul v-else class="workbench-notification-list">
              <li
                v-for="notification in previewNotifications"
                :key="notification.id"
                :class="{ unread: !notification.read }"
              >
                <button type="button" @click="openNotification(notification)">
                  <span class="workbench-notification-title">
                    <strong>{{ notification.title }}</strong>
                    <span
                      v-if="!notification.read"
                      class="notification-unread-label mar-unread-label"
                      >{{ translate('generated.workbenchNotificationCenter.unread') }}</span
                    >
                  </span>
                  <small>{{ notification.message }}</small>
                  <time :datetime="new Date(notification.updatedAt).toISOString()">{{
                    notificationTime(notification.updatedAt)
                  }}</time>
                </button>
                <button
                  class="icon-button utility-control workbench-notification-delete"
                  :aria-label="
                    translate('generated.workbenchNotificationCenter.deleteNotification', {
                      value0: notification.title
                    })
                  "
                  type="button"
                  @click="remove(notification.id)"
                >
                  <MarIcon name="delete" />
                </button>
              </li>
            </ul>
          </div>
        </aside>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.workbench-notification-center {
  position: relative;
  margin-left: auto;
}
.workbench-notification-trigger {
  position: relative;
  display: grid;
  width: var(--mar-utility-control-size);
  height: var(--mar-utility-control-size);
  place-items: center;
}
.workbench-notification-trigger-label {
  font-size: var(--mar-font-size-meta);
}
.workbench-notification-center.mobile-mode {
  display: flex;
  box-sizing: border-box;
  width: 52px;
  height: var(--sidebar-header-height);
  align-items: center;
  justify-content: center;
  padding: 4px 8px 5px;
}
.mobile-mode .workbench-notification-trigger {
  width: 36px;
  min-width: 36px;
  height: 36px;
  flex: 0 0 auto;
  border: 0;
  border-radius: var(--mar-radius-selection);
  padding: 2px 6px;
}
.mobile-mode .workbench-notification-trigger .mar-icon {
  width: 22px;
  height: 22px;
  font-size: 22px;
  line-height: 22px;
}
.mobile-mode .workbench-notification-trigger:hover {
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}
.mobile-mode .workbench-notification-trigger[aria-expanded='true'] {
  background: var(--mar-fill-selection);
  color: var(--mar-color-brand-text);
}
.workbench-notification-panel.mobile-mode {
  --notification-panel-header-height: var(--sidebar-header-height);
  z-index: 50;
}
.workbench-notification-badge {
  position: absolute;
  top: calc(50% - 15px);
  right: calc(50% - 14px);
  min-width: 14px;
  box-sizing: border-box;
  padding: 1px 0.1875rem;
  border: 0;
  border-radius: var(--mar-radius-marker);
  background: var(--mar-color-brand);
  color: var(--mar-color-on-accent);
  font-size: var(--mar-font-size-nano);
  font-weight: 500;
  line-height: 1.4;
  text-align: center;
}
.workbench-notification-panel {
  --notification-panel-header-height: var(--mar-workbench-header-height);
  --notification-panel-gap: 0.5rem;
  --notification-panel-top: calc(
    var(--notification-panel-header-height) + var(--notification-panel-gap)
  );
  position: fixed;
  z-index: 30;
  top: var(--notification-panel-top);
  right: var(--notification-panel-gap);
  box-sizing: border-box;
  display: flex;
  max-height: calc(
    100dvh - var(--notification-panel-top) - var(--notification-panel-gap) -
      env(safe-area-inset-bottom, 0px)
  );
  flex-direction: column;
  width: min(390px, calc(100vw - 1rem));
  overflow: hidden;
  border: 1px solid var(--mar-border-default);
  border-radius: var(--mar-radius-surface);
  background: var(--mar-control-bg-color-overlay);
  box-shadow: 0 14px 30px var(--mar-shadow-medium);
}
.workbench-notification-panel > header {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--mar-border-default);
  padding: 0.55rem 0.7rem;
  font-size: var(--mar-font-size-meta);
}
.workbench-notification-panel.drawer-mode {
  position: static;
  width: 100%;
  max-height: none;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  background: transparent;
}
.drawer-mode .workbench-notification-section {
  max-height: none;
  overflow: visible;
}
.workbench-notification-mark-all {
  flex: none;
  font-size: var(--mar-font-size-meta);
}
.workbench-notification-panel button:not(.el-button) {
  font: inherit;
}
.workbench-notification-panel button:not(.icon-button, .utility-control, .el-button) {
  border: 0;
  background: transparent;
  color: var(--mar-text-primary);
  cursor: pointer;
}
.workbench-notification-upload-list,
.workbench-notification-list {
  max-width: 100%;
  margin: 0;
  padding: 0;
}
.workbench-notification-section {
  min-height: 0;
  max-height: min(calc(6 * 44px), 35dvh);
  flex: 0 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
}

@media (min-width: 768px) {
  .workbench-notification-section {
    max-height: min(24rem, 55dvh);
  }
}
.workbench-notification-section .workbench-notification-upload-list,
.workbench-notification-section .workbench-notification-list {
  max-height: none;
  overflow: visible;
}
.workbench-notification-upload {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 0.5rem;
  align-items: center;
  border-bottom: 1px solid var(--mar-fill-hover);
  padding: 0.55rem 0.65rem;
  font-size: var(--mar-font-size-meta);
}
.workbench-notification-upload,
.workbench-notification-list > li {
  box-sizing: border-box;
  min-height: 44px;
}
.workbench-notification-list > li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.5rem;
  align-items: center;
  border-bottom: 1px solid var(--mar-fill-hover);
  padding: 0.32rem 0.65rem;
  font-size: var(--mar-font-size-meta);
}
.workbench-notification-upload > .mar-icon {
  color: var(--mar-color-brand-text);
}
.workbench-notification-upload-actions {
  display: flex;
  align-items: center;
  gap: 0.2rem;
}
.workbench-notification-upload strong,
.workbench-notification-upload small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workbench-notification-upload small,
.workbench-notification-list small {
  color: var(--mar-text-muted);
}
.workbench-notification-list > li > button:first-child strong {
  font-size: var(--mar-font-size-body);
  font-weight: 500;
  line-height: 1.35;
}
.workbench-notification-list > li > button:first-child small {
  font-size: var(--mar-font-size-meta);
  line-height: 1.5;
  white-space: pre-wrap;
}
.workbench-upload-size {
  display: inline-block;
  min-width: 17ch;
  font-variant-numeric: tabular-nums;
}
.workbench-notification-upload progress {
  width: 100%;
  height: 5px;
  accent-color: var(--mar-color-brand);
}
.workbench-notification-list > li.unread {
  border-left: 2px solid var(--mar-border-strong);
  background: var(--mar-bg-subtle);
}
.workbench-notification-list > li > button:first-child {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.2rem;
  padding: 0;
  text-align: left;
}
.workbench-notification-list > li > button:first-child strong,
.workbench-notification-list > li > button:first-child small {
  overflow-wrap: anywhere;
}
.workbench-notification-title {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 6px;
  color: var(--el-text-color-primary);
}
.workbench-notification-title strong {
  min-width: 0;
  color: inherit;
}
.workbench-notification-list time {
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
  font-variant-numeric: tabular-nums;
}
.workbench-notification-panel .workbench-notification-delete {
  --mar-action-icon-size: 14px;
  display: grid;
  min-width: 24px;
  min-height: 24px;
  place-items: center;
}
.workbench-notification-empty {
  margin: 0;
  padding: 1.2rem;
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
  text-align: center;
}
.workbench-notification-panel-enter-active,
.workbench-notification-panel-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}
.workbench-notification-panel-enter-from,
.workbench-notification-panel-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
@media (prefers-reduced-motion: reduce) {
  .workbench-notification-panel-enter-active,
  .workbench-notification-panel-leave-active {
    transition: none;
  }
}
</style>
