<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue';
import { createHtmlPreviewService } from '../../service/html-preview-service.js';
import { createScopedHttpService } from '../../service/scoped-http-service.js';
import { translate } from '../../service/locale-preference-service.js';
import HtmlPreviewFrame from './HtmlPreviewFrame.vue';

const props = defineProps<{
  nodeId: string;
  workspaceId: string;
  path?: string | undefined;
  csrfToken: string;
  renewCsrfToken: () => Promise<string>;
}>();
const emit = defineEmits<{ source: [path: string]; external: [path: string] }>();
const preview = createHtmlPreviewService(
  createScopedHttpService({
    csrfToken: () => props.csrfToken,
    renewCsrfToken: () => props.renewCsrfToken()
  })
);
const state = preview.state;
const trusted = computed(
  () => state.value.url !== undefined && new URL(state.value.url).hostname === location.hostname
);
function reload(): void {
  if (props.path !== undefined)
    void preview.open({ nodeId: props.nodeId, workspaceId: props.workspaceId, path: props.path });
}
watch(
  () => [props.nodeId, props.workspaceId, props.path],
  () => {
    if (props.path === undefined) preview.release();
    else reload();
  },
  { immediate: true }
);
onBeforeUnmount(preview.release);
</script>

<template>
  <section class="html-browser">
    <p v-if="!path" class="empty">{{ translate('htmlPreview.empty') }}</p>
    <template v-else>
      <header>
        <code v-tooltip="path">{{ path.split('/').at(-1) }}</code>
        <el-button text @click="reload">{{ translate('htmlPreview.reload') }}</el-button>
        <el-button text @click="emit('source', path)">{{
          translate('htmlPreview.source')
        }}</el-button>
        <el-button text @click="emit('external', path)">{{
          translate('htmlPreview.external')
        }}</el-button>
      </header>
      <p v-if="state.url" class="warning">
        {{ translate(trusted ? 'htmlPreview.trustedWarning' : 'htmlPreview.isolatedWarning') }}
      </p>
      <p v-if="state.error" class="error">{{ translate('htmlPreview.unavailable') }}</p>
      <HtmlPreviewFrame :url="state.url" :loading="state.loading" :title="path" />
    </template>
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
code {
  flex: 1 1 8rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty,
.warning,
.error {
  margin: 0.5rem;
  color: var(--mar-text-secondary);
}
.error {
  color: var(--mar-color-danger-text);
}
</style>
