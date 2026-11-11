<script setup lang="ts">
// Owns only preview visibility; removal and the saved reference remain with the draft owner.
import { computed, ref } from 'vue';
import { ClickOutside as vClickOutside, type PopoverInstance } from 'element-plus';
import type { ComposerReference } from '@myagentroam/protocol';
import { translate } from '../../service/locale-preference-service.js';
import { composerReferenceLabel } from '../../util/composer-reference.js';
import MarIcon from '../common/MarIcon.vue';
import QuoteExcerpt from './QuoteExcerpt.vue';

const props = defineProps<{
  readonly reference: Extract<ComposerReference, { type: 'quote' }>;
  readonly disabled: boolean;
}>();
const emit = defineEmits<{ remove: [] }>();
// Gate delayed native hover/focus events after an explicit dismissal.
const open = ref(false);
const popover = ref<PopoverInstance>();
const content = ref<HTMLElement>();
function close(): void {
  open.value = false;
  popover.value?.hide();
}
const summary = computed(() => composerReferenceLabel(props.reference));
</script>

<template>
  <span v-click-outside:[content]="close" class="composer-quote-tag composer-file-reference-state">
    <el-popover
      ref="popover"
      v-model:visible="open"
      :disabled="!open"
      :trigger="['hover', 'focus']"
      :show-after="0"
      placement="top-start"
      :width="420"
      :show-arrow="false"
      :persistent="false"
      :popper-style="{ maxWidth: 'calc(100vw - 2rem)' }"
    >
      <template #reference>
        <button
          class="quote-tag-preview"
          type="button"
          :aria-label="translate('composer.previewQuote', { name: summary })"
          @mouseenter="open = true"
          @focus="open = true"
          @click="open = true"
          @keydown.esc.stop="close"
        >
          <MarIcon name="quote" /><span>{{ summary }}</span>
        </button>
      </template>
      <div
        ref="content"
        class="quote-tag-content"
        role="region"
        :aria-label="translate('composer.quote')"
        tabindex="0"
        @keydown.esc.stop="close"
      >
        <QuoteExcerpt :reference="reference" />
      </div>
    </el-popover>
    <button
      class="quote-tag-remove"
      type="button"
      :disabled="disabled"
      :aria-label="translate('composer.removeQuote', { name: summary })"
      @click="emit('remove')"
    >
      <MarIcon name="close" />
    </button>
  </span>
</template>

<style scoped>
.composer-quote-tag {
  display: inline-flex;
  align-items: stretch;
  min-width: 0;
  max-width: min(18rem, 100%);
  border: 1px solid var(--mar-color-brand);
  border-radius: 999px;
  background: var(--mar-color-brand-subtle);
  color: var(--mar-color-brand-text);
  font-size: var(--mar-font-size-meta);
}
.quote-tag-preview,
.quote-tag-remove {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
  padding: 0.2rem 0.45rem;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.quote-tag-preview span {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.quote-tag-preview svg,
.quote-tag-remove {
  flex-shrink: 0;
}
.quote-tag-remove {
  padding-inline: 0.25rem;
  margin-right: 0.2rem;
}
.quote-tag-preview:hover,
.quote-tag-remove:not(:disabled):hover {
  background: var(--mar-fill-row-hover);
}
.quote-tag-content {
  max-height: min(24rem, 55dvh);
  overflow: auto;
  overscroll-behavior: contain;
}
</style>
