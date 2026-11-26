<script setup lang="ts">
import { translate } from '../../../service/locale-preference-service.js';
import type { WhiteboardEntryChanges } from '../../../util/whiteboard-operation-presentation.js';

defineProps<{
  owner: string | undefined;
  receipt: string | undefined;
  entryChanges: WhiteboardEntryChanges | undefined;
}>();
</script>

<template>
  <p v-if="owner || receipt" class="whiteboard-detail mar-conversation-detail-text">
    <template v-if="owner">
      <span class="tool-detail-meta"
        >{{ translate('presentation.whiteboardDetail.boardAgentId') }}:</span
      >
      {{ owner }}
    </template>
    <span v-if="owner && receipt" aria-hidden="true"> · </span>
    {{ receipt }}
  </p>
  <template v-if="entryChanges">
    <ul v-if="entryChanges.entries.length" class="whiteboard-entry-changes">
      <li v-for="(entry, index) in entryChanges.entries" :key="index">
        <p class="mar-conversation-detail-text">{{ entry }}</p>
      </li>
    </ul>
    <p v-if="entryChanges.removedCount" class="mar-conversation-detail-text">
      {{
        entryChanges.removedCount === 1
          ? translate('presentation.whiteboardDetail.removedOne')
          : translate('presentation.whiteboardDetail.removed', { count: entryChanges.removedCount })
      }}
    </p>
    <p v-if="entryChanges.truncated" class="tool-detail-meta">
      {{ translate('presentation.whiteboardDetail.changesTruncated') }}
    </p>
  </template>
</template>

<style scoped>
.whiteboard-entry-changes {
  margin: 0;
  padding-inline-start: 1.25em;
}
</style>
