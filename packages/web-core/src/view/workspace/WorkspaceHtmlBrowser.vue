<script setup lang="ts">
import { inject, onBeforeUnmount, watch } from 'vue';
import { createHtmlPreviewService } from '../../service/html-preview-service.js';
import { createScopedHttpService } from '../../service/scoped-http-service.js';
import { WORKBENCH_HTTP_KEY } from '../../service/workbench-http-service.js';
import { translate } from '../../service/locale-preference-service.js';
import { filePreviewErrorMessage } from '../../util/error-presentation.js';
import HtmlPreviewFrame from './HtmlPreviewFrame.vue';
import MarIcon from '../common/MarIcon.vue';

const props = defineProps<{
  nodeId: string;
  workspaceId: string;
  path: string;
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
function reload(): void {
  void preview.open({ nodeId: props.nodeId, workspaceId: props.workspaceId, path: props.path });
}
watch(() => [props.nodeId, props.workspaceId, props.path], reload, { immediate: true });
onBeforeUnmount(preview.release);
</script>

<template>
  <section class="html-browser">
    <header>
      <span class="html-browser-file-name" v-tooltip="path">{{ path.split('/').at(-1) }}</span>
      <div class="html-browser-actions">
        <el-button
          class="mar-icon-action"
          text
          circle
          size="small"
          v-tooltip="translate('htmlPreview.reload')"
          :aria-label="translate('htmlPreview.reload')"
          @click="reload"
          ><MarIcon name="refresh"
        /></el-button>
        <el-button
          class="mar-icon-action"
          text
          circle
          size="small"
          v-tooltip="translate('htmlPreview.source')"
          :aria-label="translate('htmlPreview.source')"
          @click="emit('source', path)"
          ><MarIcon name="document"
        /></el-button>
        <el-button
          class="mar-icon-action"
          text
          circle
          size="small"
          v-tooltip="translate('htmlPreview.external')"
          :aria-label="translate('htmlPreview.external')"
          @click="emit('external', path)"
          ><MarIcon name="external-link"
        /></el-button>
      </div>
    </header>
    <p v-if="state.error !== undefined" class="html-browser-error" role="alert">
      {{ filePreviewErrorMessage(state.error, path) }}
    </p>
    <HtmlPreviewFrame :url="state.url" :loading="state.loading" :title="path" />
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
.html-browser-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
.html-browser-error {
  margin: 0.5rem;
  color: var(--mar-color-warning-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
