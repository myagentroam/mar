<script setup lang="ts">
import { Check, Close } from '@element-plus/icons-vue';
import { translate } from '../../service/LocalePreferenceService.js';

defineProps<{
  readonly title: string;
  readonly statusLabel?: string;
  readonly decidable: boolean;
  readonly disabled: boolean;
}>();

const emit = defineEmits<{ decide: [decision: 'APPROVED' | 'REJECTED'] }>();
</script>

<template>
  <section class="approval-item-card">
    <div class="approval-heading">
      <strong class="approval-title">{{ title }}</strong>
      <span v-if="statusLabel" class="approval-status">{{ statusLabel }}</span>
    </div>
    <slot />
    <div v-if="decidable" class="approval-actions">
      <el-button
        type="primary"
        size="small"
        :icon="Check"
        :disabled="disabled"
        @click="emit('decide', 'APPROVED')"
      >
        {{ translate('generated.conversationApprovals.allow') }}
      </el-button>
      <el-button
        size="small"
        :icon="Close"
        :disabled="disabled"
        @click="emit('decide', 'REJECTED')"
      >
        {{ translate('generated.conversationApprovals.deny') }}
      </el-button>
    </div>
  </section>
</template>

<style scoped>
.approval-item-card {
  display: grid;
  gap: 0.45rem;
  min-width: 0;
  overflow-wrap: anywhere;
}

.approval-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem;
  color: var(--mar-conversation-muted);
  font-size: var(--mar-font-size-meta);
}

.approval-title {
  font-size: inherit;
}

.approval-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.approval-actions :deep(.el-button) {
  width: 100%;
  min-width: 0;
  margin: 0;
}

@media (max-width: 767px) {
  .approval-actions :deep(.el-button) {
    min-height: 2rem;
    height: auto;
    padding: 0.4rem 0.75rem;
  }
}
</style>
