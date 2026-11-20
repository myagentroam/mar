<script setup lang="ts">
defineProps<{ checked?: boolean }>();
const emit = defineEmits<{ change: [checked: boolean]; 'update:checked': [checked: boolean] }>();
</script>

<template>
  <button
    type="button"
    class="mar-ui-check-tag"
    :data-checked="checked"
    :aria-pressed="$attrs.role === 'tab' ? undefined : checked"
    @click="
      emit('update:checked', !checked);
      emit('change', !checked);
    "
  >
    <slot />
  </button>
</template>

<style scoped>
.mar-ui-check-tag {
  padding: 0.375rem 0.625rem;
  border: none;
  border-radius: var(--mar-ui-radius-control);
  color: var(--mar-ui-text-secondary);
  background: var(--mar-ui-bg-subtle);
  font: inherit;
  cursor: pointer;
}
.mar-ui-check-tag:hover {
  color: var(--mar-ui-text-primary);
  background: var(--mar-ui-fill-row-hover);
}
.mar-ui-check-tag[data-checked='true'] {
  color: var(--mar-ui-text-primary);
  background: var(--mar-ui-fill-selection);
}
.mar-ui-check-tag:focus-visible {
  outline: 2px solid var(--mar-ui-color-brand);
  outline-offset: -2px;
}
</style>
