<script setup lang="ts">
import { MarButton } from '@myagentroam/mar-ui/button';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import { translate } from '../../service/locale-preference-service.js';

const props = defineProps<{
  readonly message: string;
  readonly retryable?: boolean;
  readonly retrying?: boolean;
}>();
const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <section class="file-preview-state">
    <p v-if="!retrying" role="status">{{ message }}</p>
    <slot name="actions"
      ><MarButton
        v-if="retryable"
        link
        size="small"
        :aria-disabled="retrying || undefined"
        :aria-busy="retrying || undefined"
        :aria-label="retrying ? translate('generated.filePreviewDialog.loadingPreview') : undefined"
        @click="!props.retrying && emit('retry')"
      >
        <MarBusyIndicator v-if="retrying" class="preview-retry-spinner" />
        <template v-else>{{ translate('common.retry') }}</template>
      </MarButton></slot
    >
  </section>
</template>

<style scoped>
.file-preview-state {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: safe center;
  gap: 0.75rem;
  overflow: auto;
  padding: 1rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  text-align: center;
}

.file-preview-state p {
  max-width: 100%;
  flex-shrink: 0;
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.file-preview-state :deep(.mar-ui-button) {
  flex-shrink: 0;
}

.file-preview-state :deep(.mar-ui-button--inline) {
  border-width: 0;
}

.preview-retry-spinner {
  width: 1.25rem;
  height: 1.25rem;
  color: var(--mar-color-brand-text);
}
</style>
