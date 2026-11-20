<script setup lang="ts">
import { MarIcon } from '../../icons/index.js';

withDefaults(
  defineProps<{
    title?: string;
    subTitle?: string | undefined;
    icon?: 'success' | 'error' | 'info' | 'warning';
  }>(),
  { icon: 'info' }
);
</script>

<template>
  <div class="mar-ui-result" :data-type="icon">
    <slot name="icon"><MarIcon :name="icon" size="64" /></slot>
    <p v-if="title">{{ title }}</p>
    <p v-if="subTitle" class="mar-ui-result__subtitle">{{ subTitle }}</p>
  </div>
</template>

<style scoped>
.mar-ui-result {
  display: grid;
  justify-items: center;
  gap: 0.5rem;
  padding: 1.5rem;
  color: var(--mar-ui-text-primary);
  text-align: center;
  overflow-wrap: anywhere;
}
.mar-ui-result > svg {
  color: var(--mar-ui-text-secondary);
}
[data-type='success'] > svg {
  color: var(--mar-ui-color-success-text);
}
[data-type='warning'] > svg {
  color: var(--mar-ui-color-warning-text);
}
[data-type='error'] > svg {
  color: var(--mar-ui-color-danger-text);
}
p {
  margin: 0;
  font-size: var(--mar-ui-font-size-body);
}
.mar-ui-result__subtitle {
  color: var(--mar-ui-text-secondary);
}
</style>
