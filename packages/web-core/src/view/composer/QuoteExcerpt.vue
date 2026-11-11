<script setup lang="ts">
// Presents the saved snapshot only; it never resolves or reads its source.
import { computed, ref } from 'vue';
import type { ComposerReference } from '@myagentroam/protocol';
import { composerReferenceDescription } from '../../util/composer-reference.js';
import { translate } from '../../service/locale-preference-service.js';
import MarIcon from '../common/MarIcon.vue';

const props = defineProps<{
  readonly reference: Extract<ComposerReference, { type: 'quote' }>;
  readonly collapsible?: boolean;
}>();
const expanded = ref(false);
const long = computed(
  () => props.reference.text.length > 400 || props.reference.text.split('\n').length > 8
);
</script>

<template>
  <blockquote class="quote-excerpt">
    <div class="quote-excerpt-source">
      <MarIcon name="quote" /><span>{{ composerReferenceDescription(reference) }}</span>
    </div>
    <div class="quote-excerpt-text" :class="{ collapsed: collapsible && long && !expanded }">
      {{ reference.text }}
    </div>
    <el-button
      v-if="collapsible && long"
      link
      size="small"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      {{ translate(expanded ? 'composer.collapseQuote' : 'composer.expandQuote') }}
    </el-button>
  </blockquote>
</template>

<style scoped>
.quote-excerpt {
  min-width: 0;
  margin: 0;
  padding: 0.35rem 0 0.35rem 0.7rem;
  border-left: 2px solid var(--mar-border-strong);
}
.quote-excerpt-source {
  display: flex;
  align-items: flex-start;
  gap: 0.35rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  overflow-wrap: anywhere;
}
.quote-excerpt-source > svg {
  flex-shrink: 0;
}
.quote-excerpt-text {
  margin-top: 0.35rem;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-body);
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.quote-excerpt-text.collapsed {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 8;
  overflow: hidden;
}
</style>
