<script setup lang="ts">
import type { ComposerQuoteTarget } from '../../model/composer-quote.js';
import type { createToolChangeReviewService } from '../../service/tool-change-review-service.js';
import WorkspaceFileTabs from './WorkspaceFileTabs.vue';
import WorkspaceGitDiffPage from './WorkspaceGitDiffPage.vue';

const props = defineProps<{
  review: ReturnType<typeof createToolChangeReviewService>;
  quoteTarget?: ComposerQuoteTarget | undefined;
}>();
const emit = defineEmits<{ openSource: [path: string]; error: [error: unknown] }>();

function download(diff: unknown, path: string): void {
  const text = (diff as { text?: string } | undefined)?.text;
  if (typeof text !== 'string') return;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${path.split('/').at(-1) ?? 'changes'}.diff`;
  anchor.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <WorkspaceFileTabs
    v-if="review.tabs.tabs.value.length"
    :tabs="review.tabs.tabs.value"
    :active-tab-id="review.tabs.activeTabId.value"
    @activate="review.tabs.activate"
    @close="review.tabs.remove"
    @close-all="review.clear"
    @move="review.tabs.move"
  >
    <template #default="{ tab, active, registerPageHandle, requestClose }">
      <WorkspaceGitDiffPage
        :quote-target="props.quoteTarget"
        :ref="registerPageHandle"
        v-show="active"
        :tab="tab"
        :active="active"
        :load="props.review.load"
        @close="requestClose"
        @edit="emit('openSource', tab.path)"
        @load-error="emit('error', $event)"
        @download="download($event, tab.path)"
      />
    </template>
  </WorkspaceFileTabs>
</template>
