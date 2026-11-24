<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { BROWSER_DOWNLOAD_PAGE_SIZE, type BrowserDownloadInfo } from '@myagentroam/protocol';
import { MarButton } from '@myagentroam/mar-ui/button';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import { MarProgress } from '@myagentroam/mar-ui/progress';
import { MarMessageBox } from '../../service/message-box-service.js';
import type { WorkbenchBrowserService } from '../../service/workbench-browser-service.js';
import { translate as t } from '../../service/locale-preference-service.js';
import { fileSizeLabel } from '../../util/file-presentation.js';
import { errorCode } from '../../util/api-error.js';

/** Owns list pagination and row actions for the open Browser download dialog. */
const props = defineProps<{ browser: WorkbenchBrowserService; saveWorkspace?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const { snapshot, status } = props.browser;
const revision = computed(() => snapshot.value?.downloadVersion);
const hasProgress = computed(() => snapshot.value?.startedDownloadCount !== undefined);
const canDelete = computed(() => snapshot.value?.activeDownloadCount !== undefined);
const lifetime = new AbortController();
onBeforeUnmount(() => lifetime.abort());
const offset = ref(0);
const refresh = ref(0);
const items = ref<BrowserDownloadInfo[]>([]);
const more = ref(false);
const loading = ref(false);
const failed = ref(false);
const changing = ref<string>();
const actionFailure = ref<{ id: string; action: 'cancel' | 'delete' }>();
const saveFeedback = ref<{
  id: string;
  path: string;
  outcome: keyof typeof saveLabels;
}>();
const saveLabels = {
  saved: 'browser.downloadWorkspaceSaved',
  unknown: 'browser.downloadWorkspaceUnknown',
  exists: 'browser.downloadWorkspaceExists',
  invalid: 'browser.downloadWorkspaceInvalid',
  failed: 'browser.downloadFailed'
} as const;
const labels = {
  downloading: 'browser.downloadPending',
  failed: 'browser.downloadFailure',
  canceled: 'browser.downloadCanceled'
} as const;

function progressLabel(item: BrowserDownloadInfo): string {
  if (item.receivedBytes === undefined) return t(labels.downloading);
  const received = fileSizeLabel(item.receivedBytes);
  return item.totalBytes
    ? t('browser.downloadProgressTotal', { received, total: fileSizeLabel(item.totalBytes) })
    : t('browser.downloadProgressReceived', { received });
}

watch(
  [status, offset, refresh],
  ([attachmentState, start], _, cleanup) => {
    if (attachmentState !== 'ready') {
      items.value = [];
      more.value = false;
      loading.value = false;
      failed.value = false;
      actionFailure.value = undefined;
      return;
    }
    const controller = new AbortController();
    failed.value = false;
    loading.value = true;
    let running = false;
    let queued = false;
    const load = async () => {
      if (running) {
        queued = true;
        return;
      }
      running = true;
      do {
        queued = false;
        try {
          const result = await props.browser.downloads(start, controller.signal);
          if (controller.signal.aborted) return;
          if (!result.items.length && start > 0) {
            offset.value = Math.max(0, start - BROWSER_DOWNLOAD_PAGE_SIZE);
            return;
          }
          items.value = result.items;
          more.value = result.more;
          failed.value = false;
        } catch {
          if (!controller.signal.aborted) failed.value = true;
        } finally {
          if (!controller.signal.aborted) loading.value = false;
        }
      } while (queued && !controller.signal.aborted);
      running = false;
    };
    // Keep the current request alive when a newer progress revision arrives.
    const stop = watch([revision, hasProgress], () => void load(), { immediate: true });
    cleanup(() => {
      stop();
      controller.abort();
    });
  },
  { immediate: true }
);

async function change(item: BrowserDownloadInfo, action: 'cancel' | 'delete'): Promise<void> {
  if (changing.value) return;
  if (action === 'delete' && item.state === 'ready') {
    try {
      await MarMessageBox.confirm(
        t('browser.downloadDeleteConfirm', { name: item.name }),
        t('browser.downloadDelete'),
        {
          signal: lifetime.signal,
          confirmButtonType: 'danger',
          confirmButtonText: t('browser.delete'),
          cancelButtonText: t('browser.cancel')
        }
      );
    } catch {
      return;
    }
  }
  if (lifetime.signal.aborted || status.value !== 'ready') return;
  changing.value = item.id;
  actionFailure.value = undefined;
  try {
    if (action === 'cancel') await props.browser.cancelDownload(item.id);
    else await props.browser.deleteDownload(item.id);
  } catch {
    actionFailure.value = { id: item.id, action };
  } finally {
    changing.value = undefined;
  }
}

async function saveToWorkspace(item: BrowserDownloadInfo): Promise<void> {
  const href = props.browser.downloadHref(item.id);
  const browserId = props.browser.browserId();
  if (!href || !browserId || changing.value) return;
  changing.value = item.id;
  saveFeedback.value = undefined;
  try {
    const { value: path } = await MarMessageBox.prompt(
      t('browser.downloadWorkspaceHint'),
      t('browser.downloadWorkspace'),
      {
        signal: lifetime.signal,
        inputValue: item.name,
        confirmButtonText: t('browser.downloadWorkspace'),
        cancelButtonText: t('browser.cancel'),
        inputValidator: (value) => value.trim().length > 0 && value.length <= 4096
      }
    );
    if (lifetime.signal.aborted || props.browser.downloadHref(item.id) !== href) return;
    let outcome: keyof typeof saveLabels = 'saved';
    try {
      await props.browser.saveDownloadToWorkspace(item.id, path);
    } catch (error) {
      switch (errorCode(error)) {
        case 'BROWSER_OUTCOME_UNKNOWN':
        case 'NETWORK_UNAVAILABLE':
        case 'REQUEST_FAILED_502':
        case 'REQUEST_FAILED_503':
        case 'REQUEST_FAILED_504':
          outcome = 'unknown';
          break;
        case 'FILE_ALREADY_EXISTS':
          outcome = 'exists';
          break;
        case 'FILE_NOT_FOUND':
        case 'FILE_PATH_ESCAPE':
          outcome = 'invalid';
          break;
        default:
          outcome = 'failed';
      }
    }
    if (!lifetime.signal.aborted && props.browser.browserId() === browserId)
      saveFeedback.value = { id: item.id, path, outcome };
  } catch {
    // Closing the destination prompt does not dispatch a save.
  } finally {
    changing.value = undefined;
  }
}
</script>

<template>
  <MarDialog
    :model-value="true"
    :title="t('browser.downloads')"
    width="min(560px, calc(100vw - 32px))"
    @update:model-value="(open) => !open && emit('close')"
  >
    <p v-if="status !== 'ready'" class="download-notice" role="status">
      {{ t('browser.disconnected') }}
    </p>
    <p v-else-if="failed" class="download-notice download-error" role="alert">
      {{ t('browser.downloadFailed') }}
    </p>
    <div v-else-if="!items.length && loading" class="download-notice" role="status">
      <MarBusyIndicator aria-hidden="true" />
      {{ t('browser.downloadLoading') }}
    </div>
    <div v-else-if="!items.length" class="download-empty">
      <MarIcon name="download" />
      <span>{{ t('browser.noDownloads') }}</span>
    </div>
    <ul v-if="items.length" class="download-items" :aria-busy="loading">
      <li
        v-for="item in items"
        :key="item.id"
        class="download-item"
        :class="{ 'download-item-ready': item.state === 'ready' }"
      >
        <span class="download-file-icon"><MarIcon name="document" /></span>
        <div class="download-details">
          <span class="download-name">{{ item.name }}</span>
          <span v-if="item.state === 'ready' && item.size !== undefined" class="download-meta">
            {{ fileSizeLabel(item.size) }}
          </span>
          <div v-else-if="item.state === 'downloading'" class="download-progress-row">
            <span class="download-meta">{{ progressLabel(item) }}</span>
            <MarProgress
              :indeterminate="item.totalBytes === undefined || item.receivedBytes === undefined"
              :percentage="
                item.totalBytes
                  ? Math.floor(((item.receivedBytes ?? 0) / item.totalBytes) * 100)
                  : 0
              "
              :stroke-width="4"
              :aria-label="`${t(labels.downloading)} ${item.name}`"
              :aria-valuetext="item.receivedBytes === undefined ? undefined : progressLabel(item)"
            />
          </div>
          <span
            v-else-if="item.state !== 'ready'"
            class="download-meta"
            :class="{ 'download-error': item.state === 'failed' }"
          >
            {{ t(labels[item.state]) }}
          </span>
        </div>
        <div class="download-actions">
          <MarButton
            v-if="item.state === 'downloading'"
            text
            :disabled="!!changing"
            :loading="changing === item.id"
            @click="change(item, 'cancel')"
            >{{ t('browser.cancel') }}</MarButton
          >
          <MarButton
            v-if="item.state === 'ready'"
            text
            tag="a"
            :href="browser.downloadHref(item.id) ?? ''"
            :disabled="changing === item.id || status !== 'ready'"
            download
            >{{ t('browser.downloadSave') }}</MarButton
          >
          <MarButton
            v-if="item.state === 'ready' && saveWorkspace"
            text
            :aria-disabled="!!changing"
            @click="saveToWorkspace(item)"
            >{{ t('browser.downloadWorkspace') }}</MarButton
          >
          <MarButton
            v-if="canDelete && item.state !== 'downloading'"
            text
            icon="delete"
            :aria-label="t('browser.downloadDelete')"
            v-tooltip="t('browser.downloadDelete')"
            :disabled="!!changing"
            :loading="changing === item.id"
            @click="change(item, 'delete')"
          />
        </div>
        <p
          v-if="saveFeedback?.id === item.id"
          class="download-action-error"
          :class="{
            'download-error': saveFeedback.outcome !== 'saved' && saveFeedback.outcome !== 'unknown'
          }"
          :role="saveFeedback.outcome === 'saved' ? 'status' : 'alert'"
        >
          {{ t(saveLabels[saveFeedback.outcome], { path: saveFeedback.path }) }}
        </p>
        <p
          v-if="actionFailure?.id === item.id"
          class="download-action-error download-error"
          role="alert"
        >
          {{
            t(
              actionFailure.action === 'cancel'
                ? 'browser.downloadCancelFailed'
                : 'browser.downloadDeleteFailed'
            )
          }}
        </p>
      </li>
    </ul>
    <template v-if="status === 'ready' && (failed || offset || more)" #footer>
      <MarButton v-if="failed" @click="refresh++">{{ t('common.retry') }}</MarButton>
      <MarButton
        v-if="offset || more"
        :disabled="!offset || loading"
        @click="offset -= BROWSER_DOWNLOAD_PAGE_SIZE"
        >{{ t('browser.previous') }}</MarButton
      >
      <MarButton
        v-if="offset || more"
        :disabled="!more || loading"
        @click="offset += BROWSER_DOWNLOAD_PAGE_SIZE"
        >{{ t('browser.next') }}</MarButton
      >
    </template>
  </MarDialog>
</template>

<style scoped>
.download-items {
  list-style: none;
  margin: 0;
  padding: 0;
}
.download-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.5rem 0.75rem;
  padding-block: 0.75rem;
}
.download-item + .download-item {
  border-block-start: 1px solid var(--mar-ui-border-default);
}
.download-file-icon {
  display: grid;
  place-items: center;
  inline-size: 2rem;
  block-size: 2rem;
  border-radius: var(--mar-ui-radius-control);
  background: var(--mar-ui-fill-soft);
  color: var(--mar-ui-text-secondary);
}
.download-details {
  display: grid;
  gap: 0.15rem;
  min-inline-size: 0;
}
.download-name {
  overflow-wrap: anywhere;
  font-weight: 500;
}
.download-meta {
  color: var(--mar-ui-text-secondary);
  font-size: var(--mar-ui-font-size-meta);
  font-variant-numeric: tabular-nums;
}
.download-actions {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.download-progress-row {
  display: grid;
  gap: 0.3rem;
}
.download-notice,
.download-empty {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  padding-block: 0.75rem;
  color: var(--mar-ui-text-secondary);
}
.download-empty {
  flex-direction: column;
  padding-block: 2rem;
}
.download-action-error {
  grid-column: 2 / -1;
  margin: 0;
  font-size: var(--mar-ui-font-size-meta);
  overflow-wrap: anywhere;
}
.download-error {
  color: var(--mar-ui-control-color-danger);
}
@media (max-width: 480px) {
  .download-item-ready {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .download-item-ready .download-actions {
    grid-column: 2;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
}
</style>
