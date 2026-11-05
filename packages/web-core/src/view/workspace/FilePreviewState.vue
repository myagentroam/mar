<script setup lang="ts">
import { translate } from '../../service/locale-preference-service.js';

defineProps<{ readonly message: string; readonly retryable?: boolean }>();
const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <section class="file-preview-state" role="status">
    <p>{{ message }}</p>
    <slot name="actions"
      ><el-button v-if="retryable" size="small" @click="emit('retry')">
        {{ translate('common.retry') }}
      </el-button></slot
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

.file-preview-state :deep(.el-button) {
  flex-shrink: 0;
}
</style>
