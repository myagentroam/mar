<script setup lang="ts">
import { formatDateTime as notificationTime } from '../../util/time-presentation.js';
import { translate } from '../../service/LocalePreferenceService.js';
import { Bell, Delete, UploadFilled } from '@element-plus/icons-vue';
import type { RecentRun } from '../../service/WorkbenchNotificationService.js';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  activeRecentRunStatus,
  elapsedDurationLabel,
  recentRunTimeReference
} from '../../util/notification-presentation.js';
import { fileSizeLabel } from '../../util/file-presentation.js';
import type { WorkspaceUploadTask } from '../../service/WorkspaceUploadService.js';
import type {
  WorkbenchNotification,
  WorkbenchNotificationService
} from '../../service/WorkbenchNotificationService.js';

const props = defineProps<{
  readonly service: WorkbenchNotificationService;
  readonly uploads: readonly WorkspaceUploadTask[];
  readonly statusLabel: (task: WorkspaceUploadTask) => string;
  readonly triggerLabel?: string;
  readonly mobileMode?: boolean;
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
const open = ref(false);
const autoPreview = ref(false);
const currentTime = ref(Date.now());
const center = ref<HTMLElement>();
const panel = ref<HTMLElement>();
let dismissTimer: ReturnType<typeof setTimeout> | undefined;
let elapsedTimer: ReturnType<typeof setInterval> | undefined;
const AUTO_PREVIEW_MS = 8_000;
const RUN_STATUS_KEYS = {
  STARTING: 'workbenchNotificationCenter.runStatus.STARTING',
  RUNNING: 'workbenchNotificationCenter.runStatus.RUNNING',
  CANCELLING: 'workbenchNotificationCenter.runStatus.CANCELLING',
  SUCCEEDED: 'workbenchNotificationCenter.runStatus.SUCCEEDED',
  FAILED: 'workbenchNotificationCenter.runStatus.FAILED',
  CANCELLED: 'workbenchNotificationCenter.runStatus.CANCELLED',
  INTERRUPTED: 'workbenchNotificationCenter.runStatus.INTERRUPTED'
} as const satisfies Record<RecentRun['status'], string>;
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
const visibleRecentRuns = computed(() => props.service.recentRuns.value);

watch(
  () => props.service.notificationRevision.value,
  (revision, previous) => {
    if (revision === 0 || previous === undefined) return;
    showTemporarily();
  }
);

function showTemporarily(): void {
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
  autoPreview.value = false;
  open.value = false;
  emit('openNotification', notification);
}

function openRecentRun(run: RecentRun): void {
  autoPreview.value = false;
  open.value = false;
  emit('openRecentRun', run);
}

function runStatusLabel(status: RecentRun['status']): string {
  return translate(RUN_STATUS_KEYS[status]);
}

function runStatusType(
  status: RecentRun['status']
): 'primary' | 'success' | 'danger' | 'warning' | 'info' {
  if (status === 'SUCCEEDED') return 'success';
  if (status === 'FAILED') return 'danger';
  if (status === 'STARTING' || status === 'RUNNING') return 'primary';
  if (status === 'CANCELLING' || status === 'INTERRUPTED') return 'warning';
  return 'info';
}

function recentRunTime(run: RecentRun): string {
  if (!activeRecentRunStatus(run.status)) return notificationTime(recentRunTimeReference(run));
  return translate('workbenchNotificationCenter.runningElapsed', {
    duration: elapsedDurationLabel(currentTime.value - run.startedAt),
    startedAt: notificationTime(run.startedAt)
  });
}

function closeWhenClickOutside(event: PointerEvent): void {
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

function onNotificationShortcut(event: KeyboardEvent): void {
  const target = event.target;
  if (
    event.isComposing ||
    !event.shiftKey ||
    (!event.ctrlKey && !event.metaKey) ||
    event.key.toLowerCase() !== 'e' ||
    (target instanceof Element && target.closest('.terminal-dock') !== null)
  )
    return;
  event.preventDefault();
  toggle();
}

onMounted(() => {
  elapsedTimer = setInterval(() => {
    currentTime.value = Date.now();
  }, 1_000);
  document.addEventListener('pointerdown', closeWhenClickOutside);
  window.addEventListener('keydown', onNotificationShortcut, true);
});
onBeforeUnmount(() => {
  if (dismissTimer !== undefined) clearTimeout(dismissTimer);
  if (elapsedTimer !== undefined) clearInterval(elapsedTimer);
  document.removeEventListener('pointerdown', closeWhenClickOutside);
  window.removeEventListener('keydown', onNotificationShortcut, true);
});

const emit = defineEmits<{
  openNotification: [notification: WorkbenchNotification];
  openRecentRun: [run: RecentRun];
  retryUpload: [task: WorkspaceUploadTask];
  cancelUpload: [task: WorkspaceUploadTask];
  removeUpload: [task: WorkspaceUploadTask];
}>();
</script>

<template>
  <div ref="center" :class="['workbench-notification-center', { 'mobile-mode': mobileMode }]">
    <button
      class="workbench-notification-trigger icon-button utility-control"
      type="button"
      :aria-label="translate('generated.workbenchNotificationCenter.openNotificationCenter')"
      :aria-expanded="open"
      @click="toggle"
    >
      <el-icon><Bell /></el-icon>
      <span v-if="triggerLabel" class="workbench-notification-trigger-label">{{
        triggerLabel
      }}</span>
      <span v-if="service.unreadCount.value" class="workbench-notification-badge">{{
        service.unreadCount.value
      }}</span>
    </button>
    <Teleport to="body" :disabled="!mobileMode">
      <Transition name="workbench-notification-panel">
        <aside
          v-if="open"
          ref="panel"
          :class="['workbench-notification-panel', { 'mobile-mode': mobileMode }]"
          :aria-label="translate('generated.workbenchNotificationCenter.notificationCenter')"
        >
          <header>
            <strong>{{ translate('generated.workbenchNotificationCenter.notifications') }}</strong>
            <button
              v-if="service.unreadCount.value > 0"
              class="workbench-notification-mark-all"
              type="button"
              @click="service.markAllRead()"
            >
              {{ translate('generated.workbenchNotificationCenter.markAllRead') }}
            </button>
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
                <el-icon><UploadFilled /></el-icon>
                <div>
                  <strong :title="task.name">{{ task.name }}</strong>
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
                  <button
                    v-if="task.status === 'FAILED' || task.status === 'INTERRUPTED'"
                    type="button"
                    @click="emit('retryUpload', task)"
                  >
                    {{
                      task.file === undefined
                        ? translate('generated.workbenchNotificationCenter.resume')
                        : translate('generated.workbenchNotificationCenter.retry')
                    }}
                  </button>
                  <button
                    v-if="task.status === 'FAILED' || task.status === 'INTERRUPTED'"
                    type="button"
                    class="workbench-notification-delete"
                    :aria-label="
                      translate('generated.workbenchNotificationCenter.delete', {
                        value0: task.name
                      })
                    "
                    @click="emit('removeUpload', task)"
                  >
                    <el-icon><Delete /></el-icon>
                  </button>
                  <button v-else type="button" @click="emit('cancelUpload', task)">
                    {{ translate('generated.workbenchNotificationCenter.cancel') }}
                  </button>
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
                    <span v-if="!notification.read" class="notification-unread-label">{{
                      translate('generated.workbenchNotificationCenter.unread')
                    }}</span>
                  </span>
                  <small>{{ notification.message }}</small>
                  <time :datetime="new Date(notification.updatedAt).toISOString()">{{
                    notificationTime(notification.updatedAt)
                  }}</time>
                </button>
                <button
                  class="workbench-notification-delete"
                  :aria-label="
                    translate('generated.workbenchNotificationCenter.deleteNotification', {
                      value0: notification.title
                    })
                  "
                  type="button"
                  @click="remove(notification.id)"
                >
                  <el-icon><Delete /></el-icon>
                </button>
              </li>
            </ul>
          </div>
          <template v-if="!autoPreview">
            <header class="workbench-recent-runs-header">
              <strong>{{ translate('generated.workbenchNotificationCenter.recentTasks') }}</strong>
            </header>
            <p v-if="service.recentRuns.value.length === 0" class="workbench-notification-empty">
              {{ translate('generated.workbenchNotificationCenter.noRecentTasks') }}
            </p>
            <ul v-else class="workbench-recent-run-list">
              <li v-for="run in visibleRecentRuns" :key="`${run.nodeId}:${run.runId}`">
                <button type="button" @click="openRecentRun(run)">
                  <span
                    class="workbench-recent-run-title"
                    :title="
                      translate('workbenchNotificationCenter.recentRunTitle', {
                        value0: run.workspaceName ?? run.workspaceId,
                        value1: run.sessionTitle
                      })
                    "
                  >
                    {{
                      translate('workbenchNotificationCenter.recentRunTitle', {
                        value0: run.workspaceName ?? run.workspaceId,
                        value1: run.sessionTitle
                      })
                    }}
                  </span>
                  <el-tag size="small" :type="runStatusType(run.status)">{{
                    runStatusLabel(run.status)
                  }}</el-tag>
                  <small :title="run.userMessage">{{ run.userMessage }}</small>
                  <time :datetime="new Date(recentRunTimeReference(run)).toISOString()">{{
                    recentRunTime(run)
                  }}</time>
                </button>
              </li>
            </ul>
          </template>
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
.workbench-notification-center.mobile-mode .workbench-notification-trigger {
  display: grid;
  width: 52px;
  min-width: 52px;
  height: var(--sidebar-header-height);
  place-items: center;
  border: 0;
  border-bottom: 2px solid transparent;
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
  border: 1px solid var(--mar-bg-panel);
  border-radius: 9px;
  background: var(--mar-color-brand);
  color: var(--mar-color-on-accent);
  font-size: var(--mar-font-size-nano);
  line-height: 13px;
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
  border-radius: 8px;
  background: color-mix(in srgb, var(--mar-bg-panel) 97%, transparent);
  box-shadow: 0 14px 30px var(--mar-shadow-medium);
  backdrop-filter: blur(10px);
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
.workbench-notification-mark-all {
  flex: none;
  font-size: var(--mar-font-size-meta);
}
.workbench-notification-panel button {
  border: 0;
  background: transparent;
  color: var(--mar-color-brand-text);
  cursor: pointer;
  font: inherit;
}
.workbench-notification-upload-list,
.workbench-notification-list,
.workbench-recent-run-list {
  max-width: 100%;
  margin: 0;
  padding: 0;
}
.workbench-notification-section {
  min-height: 0;
  max-height: min(calc(6 * 44px), 35dvh);
  flex: 0 0 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.workbench-notification-section .workbench-notification-upload-list,
.workbench-notification-section .workbench-notification-list {
  max-height: none;
  overflow: visible;
}
.workbench-recent-runs-header {
  border-top: 1px solid var(--mar-border-default);
}
.workbench-recent-run-list {
  min-height: 0;
  flex: 0 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.workbench-recent-run-list > li {
  max-width: 100%;
  overflow: hidden;
  border-bottom: 1px solid var(--mar-fill-hover);
  min-height: 44px;
}
.workbench-recent-run-list > li > button {
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.12rem 0.6rem;
  padding: 0.32rem 0.65rem;
  text-align: left;
}
.workbench-recent-run-title,
.workbench-recent-run-list small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workbench-recent-run-title {
  min-width: 0;
  color: var(--el-text-color-primary);
  font-size: var(--mar-font-size-meta);
  font-weight: 500;
  line-height: 1.35;
}
.workbench-recent-run-list small {
  grid-column: 1;
  grid-row: 2;
  min-width: 0;
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
}
.workbench-recent-run-list .el-tag,
.workbench-recent-run-list time {
  grid-column: 2;
  justify-self: end;
}
.workbench-recent-run-list .el-tag {
  grid-row: 1;
  height: 20px;
  padding: 0 0.38rem;
  font-size: var(--mar-font-size-meta);
  line-height: 18px;
}
.workbench-recent-run-list time {
  grid-row: 2;
  align-self: center;
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
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
.workbench-notification-upload > .el-icon {
  color: var(--mar-color-brand-text);
}
.workbench-notification-upload-actions {
  display: flex;
  align-items: center;
  gap: 0.2rem;
}
.workbench-notification-upload strong,
.workbench-notification-upload small,
.workbench-notification-list strong,
.workbench-notification-list small {
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
  font-size: var(--mar-font-size-body);
  line-height: 1.35;
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
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: 0.6rem;
  text-align: left;
}
.workbench-notification-list > li > button:first-child strong,
.workbench-notification-list > li > button:first-child small {
  grid-column: 1;
}
.workbench-notification-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  color: var(--el-text-color-primary);
}
.workbench-notification-title strong {
  min-width: 0;
  color: inherit;
}
.notification-unread-label {
  flex: none;
  border: 1px solid var(--mar-border-strong);
  border-radius: 3px;
  background: var(--mar-bg-page);
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-nano);
  font-weight: 600;
  line-height: 1;
  padding: 2px 4px;
}
.workbench-notification-list time {
  grid-row: 1 / span 2;
  grid-column: 2;
  align-self: center;
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
  font-variant-numeric: tabular-nums;
}
.workbench-notification-panel .workbench-notification-delete {
  display: grid;
  min-width: 24px;
  min-height: 24px;
  place-items: center;
  color: var(--mar-text-neutral-control);
}
html[data-theme='vscode-dark-2026'] .workbench-notification-panel .workbench-notification-delete {
  color: var(--mar-text-faint);
}
.workbench-notification-panel .workbench-notification-delete:hover,
.workbench-notification-panel .workbench-notification-delete:focus-visible {
  color: var(--mar-text-tertiary);
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
