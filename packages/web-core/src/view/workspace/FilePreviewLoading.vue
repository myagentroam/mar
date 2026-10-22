<script setup lang="ts">
import { Loading } from '@element-plus/icons-vue';
import { translate } from '../../service/LocalePreferenceService.js';

withDefaults(defineProps<{ readonly overlay?: boolean }>(), { overlay: false });
</script>

<template>
  <div
    class="file-preview-loading"
    :class="{ 'is-overlay': overlay }"
    role="status"
    aria-live="polite"
    aria-busy="true"
  >
    <el-icon class="is-loading" aria-hidden="true"><Loading /></el-icon>
    <span>{{ translate('generated.filePreviewDialog.loadingPreview') }}</span>
  </div>
</template>

<style scoped>
.file-preview-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  margin: 0;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  text-align: center;
}

.file-preview-loading.is-overlay {
  position: absolute;
  z-index: 1;
  inset: 0;
  background: var(--mar-bg-page);
}

.file-preview-loading .el-icon {
  font-size: 1.25rem;
}

@media (prefers-reduced-motion: reduce) {
  .file-preview-loading :deep(.is-loading) {
    animation: none;
  }
}
</style>
