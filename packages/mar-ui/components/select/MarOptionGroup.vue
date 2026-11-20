<script setup lang="ts">
import { inject, provide, useId } from 'vue';
import { optionContext, optionGroupId } from './option-context.js';

defineProps<{ label: string }>();

const labelId = useId();
const select = inject(optionContext);
provide(optionGroupId, labelId);
</script>

<template>
  <div
    class="mar-ui-option-group"
    role="group"
    :aria-labelledby="labelId"
    :hidden="select && !select.groupVisible(labelId)"
  >
    <div :id="labelId" class="mar-ui-option-group__label">{{ label }}</div>
    <slot />
  </div>
</template>

<style scoped>
.mar-ui-option-group__label {
  min-height: var(--mar-ui-compact-control-size);
  padding-inline: var(--mar-ui-compact-option-padding-inline);
  color: var(--mar-ui-text-secondary);
  font-size: var(--mar-ui-font-size-meta);
  line-height: var(--mar-ui-compact-control-size);
  overflow-wrap: anywhere;
}
</style>
