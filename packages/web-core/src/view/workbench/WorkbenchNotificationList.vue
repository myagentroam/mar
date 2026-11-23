<script setup lang="ts">
import '../session/session-markers.css';
import './activity-list.css';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import { computed, ref } from 'vue';
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
const notificationGroups = computed(() => [
  {
    kind: 'updates',
    items: visibleNotifications.value.filter((item) => item.kind === 'web-update')
  },
  { kind: 'transfers', items: [] },
  {
    kind: 'notifications',
    items: visibleNotifications.value.filter((item) => item.kind !== 'web-update')
  }
]);
const hasMarkableUnread = computed(() =>
  props.service.notifications.value.some(
    (item) => item.kind !== 'web-update' && !item.read && item.expiresAt > Date.now()
  )
);
const retrying = ref(false);
const showSnapshotStatus = computed(
  () =>
    props.previewId === undefined &&
    (retrying.value || props.service.snapshotState.value !== 'ready')
);

async function retrySnapshot(): Promise<void> {
  if (retrying.value || props.service.snapshotState.value !== 'failed') return;
  retrying.value = true;
  try {
    await props.service.load();
  } catch {
    // The snapshot state owns the in-place failure feedback.
  } finally {
    retrying.value = false;
  }
}
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
      <MarButton
        v-if="hasMarkableUnread"
        class="workbench-notification-mark-all mar-text-action"
        link
        @click="service.markAllRead()"
      >
        {{ translate('generated.workbenchNotificationCenter.markAllRead') }}
      </MarButton>
    </header>
    <div class="workbench-notification-section">
      <div
        v-if="
          showSnapshotStatus || (visibleNotifications.length === 0 && transferTasks.length === 0)
        "
        class="workbench-notification-empty"
      >
        <MarButton
          v-if="showSnapshotStatus && (retrying || service.snapshotState.value === 'failed')"
          link
          :aria-disabled="retrying || undefined"
          :aria-busy="retrying || undefined"
          :aria-label="retrying ? translate('common.loading') : undefined"
          @click="retrySnapshot"
        >
          <MarBusyIndicator v-if="retrying" class="mar-read-loading-indicator" />
          <template v-else>{{ translate('common.loadFailedRetry') }}</template>
        </MarButton>
        <span
          v-else-if="showSnapshotStatus"
          role="progressbar"
          :aria-label="translate('common.loading')"
        >
          <MarBusyIndicator class="mar-read-loading-indicator" />
        </span>
        <template v-else>{{
          translate('generated.workbenchNotificationCenter.noNotifications')
        }}</template>
      </div>
      <template v-for="group in notificationGroups" :key="group.kind">
        <section
          v-if="group.kind === 'transfers' && transferTasks.length"
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
              <MarButton
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
              </MarButton>
              <button
                v-if="task.status === 'FAILED' || task.status === 'INTERRUPTED'"
                type="button"
                class="mar-icon-button mar-icon-action workbench-notification-delete"
                v-tooltip="
                  translate('generated.workbenchNotificationCenter.delete', {
                    value0: task.name
                  })
                "
                :aria-label="
                  translate('generated.workbenchNotificationCenter.delete', {
                    value0: task.name
                  })
                "
                @click="emit('removeUpload', task)"
              >
                <MarIcon name="delete" />
              </button>
              <MarButton v-else class="mar-text-action" link @click="emit('cancelUpload', task)">
                {{ translate('generated.workbenchNotificationCenter.cancel') }}
              </MarButton>
            </div>
          </div>
        </section>
        <ul v-else-if="group.items.length" class="workbench-notification-list mar-activity-list">
          <li
            v-for="notification in group.items"
            :key="notification.id"
            :class="{ unread: !notification.read }"
          >
            <button type="button" @click="emit('openNotification', notification)">
              <span class="workbench-notification-title">
                <strong>{{
                  notification.kind === 'web-update'
                    ? translate('webUpdate.title')
                    : notification.title
                }}</strong>
                <span
                  v-if="!notification.read"
                  class="notification-unread-label mar-unread-label"
                  >{{ translate('generated.workbenchNotificationCenter.unread') }}</span
                >
              </span>
              <small>{{
                notification.kind === 'web-update'
                  ? translate('webUpdate.message', { value0: notification.version })
                  : notification.message
              }}</small>
              <time :datetime="new Date(notification.updatedAt).toISOString()">{{
                notificationTime(notification.updatedAt)
              }}</time>
            </button>
            <button
              v-if="notification.kind !== 'web-update'"
              class="mar-icon-button mar-icon-action mar-icon-action--inline workbench-notification-delete"
              v-tooltip="
                translate('generated.workbenchNotificationCenter.deleteNotification', {
                  value0: notification.title
                })
              "
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
      </template>
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
.workbench-notification-content button:not(.mar-ui-button) {
  font: inherit;
}
.workbench-notification-content button:not(.mar-icon-button, .mar-icon-action, .mar-ui-button) {
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
  padding: 0.32rem 0.65rem;
  font-size: var(--mar-font-size-meta);
}
.workbench-notification-upload + .workbench-notification-upload,
.workbench-notification-list > li + li,
.workbench-notification-section > * + * > :first-child {
  border-top: 1px solid var(--mar-border-subtle);
}
.workbench-notification-upload > .mar-icon {
  color: var(--mar-text-secondary);
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
  color: var(--mar-text-secondary);
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
  accent-color: var(--mar-control-primary-bg);
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
  color: var(--mar-text-primary);
}
.workbench-notification-title strong {
  min-width: 0;
  color: inherit;
}
.workbench-notification-list time {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  font-variant-numeric: tabular-nums;
}
.workbench-notification-content .workbench-notification-delete {
  --mar-ui-action-icon-size: 14px;
  display: grid;
  min-width: 24px;
  min-height: 24px;
  place-items: center;
}
.workbench-notification-empty {
  margin: 0;
  padding: 1.2rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  text-align: center;
}
</style>
