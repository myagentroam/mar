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
  box-sizing: border-box;
  min-block-size: var(--mar-ui-compact-control-size, 24px);
  padding: 0 0.625rem;
  border: 1px solid var(--mar-ui-border-default);
  border-radius: var(--mar-ui-radius-control);
  color: var(--mar-ui-text-secondary);
  background: var(--mar-ui-bg-panel);
  font: inherit;
  font-size: var(--mar-ui-font-size-control);
  line-height: 1.35;
  white-space: nowrap;
  cursor: pointer;
}
.mar-ui-check-tag:hover {
  color: var(--mar-ui-text-primary);
  background: var(--mar-ui-fill-row-hover);
}
.mar-ui-check-tag[data-checked='true'] {
  border-color: var(--mar-ui-border-medium);
  color: var(--mar-ui-text-primary);
  background: var(--mar-ui-fill-selection);
}
.mar-ui-check-tag:focus-visible {
  outline: 2px solid var(--mar-ui-control-focus);
  outline-offset: -2px;
}
@media (forced-colors: active) {
  .mar-ui-check-tag[aria-pressed='true'] {
    border-color: Highlight;
    color: HighlightText;
    background: Highlight;
  }
  .mar-ui-check-tag[aria-pressed='true']:focus-visible {
    outline-color: HighlightText;
  }
}
</style>
