<script setup lang="ts">
import MarIcon from '../common/MarIcon.vue';
import { computed } from 'vue';
import { formatDateTime as notificationTime } from '../../util/time-presentation.js';
import { translate } from '../../service/locale-preference-service.js';
import { fileSizeLabel } from '../../util/file-presentation.js';
import type { WorkspaceUploadTask } from '../../service/workspace-upload-service.js';
import type {
  WorkbenchNotification,
  WorkbenchNotificationView
} from '../../service/workbench-notification-service.js';

const props = defineProps<{
  service: WorkbenchNotificationView;
  uploads: readonly WorkspaceUploadTask[];
  statusLabel: (task: WorkspaceUploadTask) => string;
  previewId?: string | undefined;
}>();
const emit = defineEmits<{
  openNotification: [notification: WorkbenchNotification];
  retryUpload: [task: WorkspaceUploadTask];
  cancelUpload: [task: WorkspaceUploadTask];
  removeUpload: [task: WorkspaceUploadTask];
}>();
const transferTasks = computed(() =>
  props.uploads.filter(
    (task) =>
      ['QUEUED', 'UPLOADING', 'FAILED', 'INTERRUPTED'].includes(task.status) &&
      (props.previewId === undefined || `upload:${task.id}` === props.previewId)
  )
);
const visibleNotifications = computed(() => {
  const uploadIds = new Set(transferTasks.value.map((task) => `upload:${task.id}`));
  return props.service.notifications.value.filter(
    (item) =>
      !uploadIds.has(item.id) && (props.previewId === undefined || item.id === props.previewId)
  );
});
</script>

<template>
  <section
    class="workbench-notification-content"
    :aria-label="translate('generated.workbenchNotificationCenter.notifications')"
  >
    <header v-if="previewId === undefined" class="workbench-notification-toolbar">
      <span>{{
        translate('activityCenter.unreadCount', { count: service.unreadCount.value })
      }}</span>
      <el-button
        v-if="service.unreadCount.value > 0"
        class="workbench-notification-mark-all mar-text-action"
        link
        @click="service.markAllRead()"
      >
        {{ translate('generated.workbenchNotificationCenter.markAllRead') }}
      </el-button>
    </header>
    <div class="workbench-notification-section">
      <section
        v-if="transferTasks.length"
        class="workbench-notification-upload-list"
        :aria-label="translate('generated.workbenchNotificationCenter.fileTransfers')"
      >
        <div v-for="task in transferTasks" :key="task.id" class="workbench-notification-upload">
          <MarIcon name="upload" />
          <div>
            <strong v-tooltip="task.name">{{ task.name }}</strong>
            <small>
              <span class="workbench-upload-size"
                >{{ fileSizeLabel(task.receivedBytes) }} / {{ fileSizeLabel(task.size) }}</span
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
              class="mar-text-action"
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
              class="mar-icon-button mar-icon-action workbench-notification-delete"
              :aria-label="
                translate('generated.workbenchNotificationCenter.delete', {
                  value0: task.name
                })
              "
              @click="emit('removeUpload', task)"
            >
              <MarIcon name="delete" />
            </button>
            <el-button v-else class="mar-text-action" link @click="emit('cancelUpload', task)">
              {{ translate('generated.workbenchNotificationCenter.cancel') }}
            </el-button>
          </div>
        </div>
      </section>
      <p
        v-if="visibleNotifications.length === 0 && transferTasks.length === 0"
        class="workbench-notification-empty"
      >
        {{ translate('generated.workbenchNotificationCenter.noNotifications') }}
      </p>
      <ul v-else class="workbench-notification-list">
        <li
          v-for="notification in visibleNotifications"
          :key="notification.id"
          :class="{ unread: !notification.read }"
        >
          <button type="button" @click="emit('openNotification', notification)">
            <span class="workbench-notification-title">
              <strong>{{ notification.title }}</strong>
              <span v-if="!notification.read" class="notification-unread-label mar-unread-label">{{
                translate('generated.workbenchNotificationCenter.unread')
              }}</span>
            </span>
            <small>{{ notification.message }}</small>
            <time :datetime="new Date(notification.updatedAt).toISOString()">{{
              notificationTime(notification.updatedAt)
            }}</time>
          </button>
          <button
            class="mar-icon-button mar-icon-action workbench-notification-delete"
            :aria-label="
              translate('generated.workbenchNotificationCenter.deleteNotification', {
                value0: notification.title
              })
            "
            type="button"
            @click="service.remove(notification.id)"
          >
            <MarIcon name="delete" />
          </button>
        </li>
      </ul>
    </div>
  </section>
</template>
<style scoped>
.workbench-notification-content {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.workbench-notification-toolbar {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.25rem 0.5rem;
  padding: 0.5rem 0.65rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}
.workbench-notification-section {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.workbench-notification-mark-all {
  flex: none;
  font-size: var(--mar-font-size-meta);
}
.workbench-notification-content button:not(.el-button) {
  font: inherit;
}
.workbench-notification-content button:not(.mar-icon-button, .mar-icon-action, .el-button) {
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
  font-size: var(--mar-font-size-meta);
  font-weight: 400;
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
.workbench-notification-content .workbench-notification-delete {
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
</style>
