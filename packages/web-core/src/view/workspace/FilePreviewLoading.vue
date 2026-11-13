<script setup lang="ts">
import BusyIndicator from '../common/BusyIndicator.vue';
import { translate } from '../../service/locale-preference-service.js';

withDefaults(defineProps<{ readonly overlay?: boolean; readonly variant?: 'page' | 'region' }>(), {
  overlay: false,
  variant: 'region'
});
</script>

<template>
  <div
    class="file-preview-loading"
    :class="{ 'is-overlay': overlay, 'mar-page-loading-state': variant === 'page' }"
    role="status"
    aria-live="polite"
    aria-busy="true"
    :aria-label="translate('generated.filePreviewDialog.loadingPreview')"
  >
    <BusyIndicator />
  </div>
</template>

<style scoped>
.file-preview-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  margin: 0;
  color: var(--mar-color-brand-text);
}

.file-preview-loading :deep(.mar-busy-indicator) {
  width: 1.25rem;
  height: 1.25rem;
}

.file-preview-loading.is-overlay {
  position: absolute;
  z-index: 1;
  inset: 0;
  background: var(--mar-bg-page);
}
</style>
