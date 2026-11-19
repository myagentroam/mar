<script setup lang="ts">
import type { SessionGroup } from '@myagentroam/protocol';
import { computed } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import MarSegmented from './MarSegmented.vue';

defineProps<{
  modelValue: SessionGroup;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: SessionGroup];
}>();
const options = computed(
  () =>
    [
      {
        value: 'MAIN',
        label: translate('sessionGroups.mainTab'),
        accessibleLabel: translate('sessionGroups.main')
      },
      {
        value: 'CHILD',
        label: translate('sessionGroups.childTab'),
        accessibleLabel: translate('sessionGroups.child')
      }
    ] satisfies { value: SessionGroup; label: string; accessibleLabel: string }[]
);
</script>

<template>
  <div class="session-group-tabs">
    <MarSegmented
      :model-value="modelValue"
      :options="options"
      :label="translate('sessionGroups.label')"
      block
      compact
      @update:model-value="emit('update:modelValue', $event)"
    />
  </div>
</template>

<style scoped>
.session-group-tabs {
  display: flex;
  flex-shrink: 0;
  min-width: 0;
  padding-block: 0.25rem;
}
</style>
