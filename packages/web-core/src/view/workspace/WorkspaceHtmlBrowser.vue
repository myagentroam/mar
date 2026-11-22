<script setup lang="ts">
import { MarButton } from '@myagentroam/mar-ui/button';
import { computed, inject, onBeforeUnmount, shallowRef, watch } from 'vue';
import { createHtmlPreviewService } from '../../service/html-preview-service.js';
import { createScopedHttpService } from '../../service/scoped-http-service.js';
import { WORKBENCH_HTTP_KEY } from '../../service/workbench-http-service.js';
import { translate } from '../../service/locale-preference-service.js';
import { filePreviewErrorMessage } from '../../util/error-presentation.js';
import HtmlPreviewFrame from './HtmlPreviewFrame.vue';
import { MarIcon } from '@myagentroam/mar-ui/icons';

// Owns the toolbar's connection to the visible preview document. HtmlPreviewFrame owns frame swaps.
type HistoryDirection = 'back' | 'forward';
type NavigationResult = { committed: Promise<unknown>; finished: Promise<unknown> };
interface PreviewNavigation extends EventTarget {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly currentEntry: { readonly key: string } | null;
  back(): NavigationResult;
  forward(): NavigationResult;
}

function navigationFor(view: Window | null | undefined): PreviewNavigation | undefined {
  return (view as (Window & { navigation?: PreviewNavigation }) | null | undefined)?.navigation;
}

const props = defineProps<{
  nodeId: string;
  workspaceId: string;
  path: string;
  openVersion?: number | undefined;
  csrfToken: string;
  renewCsrfToken: () => Promise<string>;
}>();
const emit = defineEmits<{ source: [path: string]; external: [path: string] }>();
const preview = createHtmlPreviewService(
  inject(WORKBENCH_HTTP_KEY, undefined) ??
    createScopedHttpService({
      csrfToken: () => props.csrfToken,
      renewCsrfToken: () => props.renewCsrfToken()
    })
);
const state = preview.state;
const targetKey = computed(() => JSON.stringify([props.nodeId, props.workspaceId, props.path]));
const frame = shallowRef<InstanceType<typeof HtmlPreviewFrame> | null>(null);
const busy = computed(() => state.value.loading || frame.value?.rendering === true);
const history = shallowRef({ back: false, forward: false });
const workbenchNavigation = navigationFor(window);
let workbenchEntryKey = workbenchNavigation?.currentEntry?.key;
let workbenchHistoryVersion = 0;
let pendingHistoryVersion: number | undefined;
let activeHistoryVersion: number | undefined;
let activeFrame: HTMLIFrameElement | undefined;
let navigation: PreviewNavigation | undefined;

function syncHistory(): void {
  const entryKey = workbenchNavigation?.currentEntry?.key;
  if (entryKey !== workbenchEntryKey) {
    workbenchEntryKey = entryKey;
    workbenchHistoryVersion++;
  }
  // Preview entries still share the tab's traversal timeline. Do not cross a workbench entry.
  const available = entryKey !== undefined && activeHistoryVersion === workbenchHistoryVersion;
  history.value = {
    back: available && navigation?.canGoBack === true,
    forward: available && navigation?.canGoForward === true
  };
}

function bindHistory(): void {
  // contentDocument is null across origins. Never traverse the parent tab's joint history.
  const next = navigationFor(activeFrame?.contentDocument?.defaultView);
  if (next !== navigation) {
    navigation?.removeEventListener('currententrychange', syncHistory);
    navigation = next;
    navigation?.addEventListener('currententrychange', syncHistory);
  }
  syncHistory();
}

function onPreviewLoad(element: HTMLIFrameElement): void {
  if (element !== activeFrame) {
    activeFrame = element;
    activeHistoryVersion = pendingHistoryVersion;
  }
  bindHistory();
}

function traverse(direction: HistoryDirection): void {
  bindHistory();
  if (!navigation || !history.value[direction]) return;
  const { committed, finished } = navigation[direction]();
  // Traversals can be superseded or canceled; the browser events report what actually committed.
  void Promise.allSettled([committed, finished]);
}

// Only a duplicate grant request is blocked; a stalled frame can be replaced.
function reload(): void {
  void preview.open({ nodeId: props.nodeId, workspaceId: props.workspaceId, path: props.path });
}
workbenchNavigation?.addEventListener('currententrychange', syncHistory);
watch(
  () => state.value.url,
  (url) => {
    // Capture the boundary before the replacement starts navigating, not when it finishes loading.
    syncHistory();
    pendingHistoryVersion = url ? workbenchHistoryVersion : undefined;
  },
  { flush: 'sync' }
);
watch([targetKey, () => props.openVersion], reload, { immediate: true });
onBeforeUnmount(() => {
  workbenchNavigation?.removeEventListener('currententrychange', syncHistory);
  activeFrame = undefined;
  bindHistory();
  preview.release();
});
</script>

<template>
  <section class="html-browser">
    <header>
      <span class="html-browser-file-name" v-tooltip="path">{{ path.split('/').at(-1) }}</span>
      <div class="html-browser-actions">
        <MarButton
          class="mar-icon-action"
          text
          circle
          icon="chevron-left"
          v-tooltip="translate('htmlPreview.back')"
          :aria-label="translate('htmlPreview.back')"
          :disabled="!history.back"
          @click="traverse('back')"
        />
        <MarButton
          class="mar-icon-action"
          text
          circle
          icon="chevron-right"
          v-tooltip="translate('htmlPreview.forward')"
          :aria-label="translate('htmlPreview.forward')"
          :disabled="!history.forward"
          @click="traverse('forward')"
        />
        <MarButton
          class="mar-icon-action"
          text
          circle
          v-tooltip="translate('htmlPreview.reload')"
          :aria-label="translate('htmlPreview.reload')"
          :disabled="state.loading"
          :aria-busy="busy || undefined"
          @click="reload"
          ><MarIcon :name="busy ? 'loading-action' : 'refresh'"
        /></MarButton>
        <MarButton
          class="mar-icon-action"
          text
          circle
          v-tooltip="translate('htmlPreview.source')"
          :aria-label="translate('htmlPreview.source')"
          @click="emit('source', path)"
          ><MarIcon name="document"
        /></MarButton>
        <MarButton
          class="mar-icon-action"
          text
          circle
          v-tooltip="translate('htmlPreview.external')"
          :aria-label="translate('htmlPreview.external')"
          @click="emit('external', path)"
          ><MarIcon name="external-link"
        /></MarButton>
      </div>
    </header>
    <p v-if="state.error !== undefined" class="html-browser-error" role="alert">
      {{ filePreviewErrorMessage(state.error, path) }}
    </p>
    <HtmlPreviewFrame
      :key="targetKey"
      ref="frame"
      :url="state.url"
      :loading="state.loading"
      :title="path"
      retain-on-reload
      @load="onPreviewLoad"
    />
  </section>
</template>

<style scoped>
.html-browser {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}
header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
}
.html-browser-file-name {
  flex: 1 1 8rem;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--mar-text-primary);
}
.html-browser-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.25rem;
}
.html-browser-actions :deep(.mar-ui-button + .mar-ui-button) {
  margin-left: 0;
}
.html-browser-error {
  margin: 0.5rem;
  color: var(--mar-color-warning-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
