<script setup lang="ts">
import type { ComposerReference } from '@myagentroam/protocol';
import {
  composerReferenceDescription,
  composerReferenceKey
} from '../../util/composer-reference.js';
import FileTypeIcon from '../workspace/FileTypeIcon.vue';
import MarIcon from '../common/MarIcon.vue';
defineProps<{ readonly references: readonly ComposerReference[] }>();
</script>

<template>
  <div v-if="references.length" class="message-reference-tags">
    <span
      v-for="reference in references"
      :key="composerReferenceKey(reference)"
      v-tooltip="composerReferenceDescription(reference)"
      class="message-reference-tag"
    >
      <MarIcon v-if="reference.type === 'quote'" name="quote" />
      <MarIcon v-else-if="reference.type === 'session'" name="recent-sessions" />
      <FileTypeIcon
        v-else
        :name="reference.path"
        :kind="reference.type === 'directory' ? 'DIRECTORY' : 'FILE'"
      />
      <span>{{ reference.label }}</span>
    </span>
  </div>
</template>

<style scoped>
.message-reference-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  min-width: 0;
}
.message-reference-tag {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  max-width: 100%;
  min-width: 0;
  border: 1px solid var(--mar-color-brand);
  border-radius: 999px;
  background: var(--mar-color-brand-subtle);
  color: var(--mar-color-brand-text);
  padding: 0.2rem 0.5rem;
  font-size: var(--mar-font-size-meta);
}
.message-reference-tag > span {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.message-reference-tag > :not(span) {
  flex-shrink: 0;
}
</style>
