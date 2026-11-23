<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { BROWSER_DOWNLOAD_PAGE_SIZE, type BrowserDownloadInfo } from '@myagentroam/protocol';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import type { WorkbenchBrowserService } from '../../service/workbench-browser-service.js';
import { translate as t } from '../../service/locale-preference-service.js';

const props = defineProps<{ browser: WorkbenchBrowserService }>();
const emit = defineEmits<{ close: [] }>();
const { snapshot, status } = props.browser;
const revision = computed(() => snapshot.value?.downloadVersion);
const offset = ref(0);
const refresh = ref(0);
const items = ref<BrowserDownloadInfo[]>([]);
const more = ref(false);
const loading = ref(false);
const failed = ref(false);
const cancelFailed = ref(false);
const canceling = ref<string>();
const labels = {
  downloading: 'browser.downloadPending',
  ready: 'browser.downloadReady',
  failed: 'browser.downloadFailure',
  canceled: 'browser.downloadCanceled'
} as const;

watch(
  [revision, status, offset, refresh],
  async ([_revision, attachmentState, start], _, cleanup) => {
    if (attachmentState !== 'ready') {
      items.value = [];
      more.value = false;
      loading.value = false;
      return;
    }
    const controller = new AbortController();
    cleanup(() => controller.abort());
    failed.value = false;
    loading.value = true;
    try {
      const result = await props.browser.downloads(start, controller.signal);
      if (!controller.signal.aborted) {
        items.value = result.items;
        more.value = result.more;
      }
    } catch {
      if (!controller.signal.aborted) failed.value = true;
    } finally {
      if (!controller.signal.aborted) loading.value = false;
    }
  },
  { immediate: true }
);

async function cancel(id: string): Promise<void> {
  canceling.value = id;
  cancelFailed.value = false;
  try {
    await props.browser.cancelDownload(id);
  } catch {
    cancelFailed.value = true;
  } finally {
    canceling.value = undefined;
  }
}
</script>

<template>
  <MarDialog
    :model-value="true"
    :title="t('browser.downloads')"
    @update:model-value="(open) => !open && emit('close')"
  >
    <p v-if="failed || cancelFailed" role="alert">{{ t('browser.downloadFailed') }}</p>
    <p v-if="status !== 'ready'" role="status">{{ t('browser.disconnected') }}</p>
    <p v-else-if="!items.length && !loading && !failed">{{ t('browser.noDownloads') }}</p>
    <ul v-if="items.length" class="download-items" :aria-busy="loading">
      <li v-for="item in items" :key="item.id" class="download-item">
        <span class="download-name">{{ item.name }}</span>
        <span role="status">{{ t(labels[item.state]) }}</span>
        <MarButton
          v-if="item.state === 'downloading'"
          text
          :disabled="!!canceling"
          @click="cancel(item.id)"
        >
          {{ t('browser.cancel') }}
        </MarButton>
        <MarButton
          v-else-if="item.state === 'ready'"
          tag="a"
          text
          :href="browser.downloadHref(item.id) ?? ''"
          download
        >
          {{ t('browser.downloadSave') }}
        </MarButton>
      </li>
    </ul>
    <template #footer>
      <MarButton v-if="failed" @click="refresh++">{{ t('browser.retry') }}</MarButton>
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
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem;
  padding-block: 0.4rem;
}
.download-name {
  flex: 1 1 10rem;
  min-inline-size: 0;
  overflow-wrap: anywhere;
}
</style>
