<script setup lang="ts">
import { useTemplateRef, type Component } from 'vue';
import type { MarIconName } from '../../icons/icon-shapes.js';
import { resolveMarIcon } from '../../icons/mar-icons.js';
import { useMarUiLocale } from '../../locale/index.js';

defineOptions({ inheritAttrs: false });
defineProps<{
  type?: 'text' | 'password';
  disabled?: boolean;
  readonly?: boolean;
  clearable?: boolean;
  prefixIcon?: MarIconName | Component;
  suffixIcon?: MarIconName | Component;
  clearIcon?: MarIconName | Component;
}>();
const model = defineModel<string>();
const emit = defineEmits<{ clear: []; change: [value: string] }>();
const locale = useMarUiLocale();
const input = useTemplateRef('input');

function clear() {
  model.value = '';
  emit('change', '');
  emit('clear');
  input.value?.focus();
}
</script>

<template>
  <span class="mar-ui-input" :class="$attrs.class" :style="$attrs.style">
    <component
      :is="resolveMarIcon(prefixIcon)"
      v-if="prefixIcon"
      class="mar-ui-input__icon"
      aria-hidden="true"
    />
    <input
      v-bind="{ ...$attrs, class: undefined, style: undefined }"
      ref="input"
      v-model="model"
      class="mar-ui-input__field"
      :type="type ?? 'text'"
      :disabled="disabled"
      :readonly="readonly"
      @change="emit('change', ($event.target as HTMLInputElement).value)"
    />
    <button
      v-if="clearable && model && !disabled && !readonly"
      type="button"
      class="mar-ui-input__clear"
      :aria-label="locale.clear"
      @mousedown.prevent
      @click="clear"
    >
      <component :is="resolveMarIcon(clearIcon ?? 'clear-input')" aria-hidden="true" />
    </button>
    <component
      :is="resolveMarIcon(suffixIcon)"
      v-if="suffixIcon"
      class="mar-ui-input__icon"
      aria-hidden="true"
    />
  </span>
</template>

<style scoped>
.mar-ui-input {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  width: 100%;
  min-width: 0;
  min-height: 32px;
  padding-inline: 11px;
  border-radius: var(--mar-ui-radius-control);
  background: var(--mar-ui-bg-panel);
  box-shadow: 0 0 0 1px var(--mar-ui-input-border) inset;
  color: var(--mar-ui-text-secondary);
  font-size: var(--mar-ui-font-size-input);
}
.mar-ui-input:hover {
  box-shadow: 0 0 0 1px var(--mar-ui-input-border-hover) inset;
}
.mar-ui-input:focus-within {
  box-shadow: 0 0 0 1px var(--mar-ui-color-brand) inset;
}
.mar-ui-input:has(input:disabled) {
  background: var(--mar-ui-fill-soft);
  box-shadow: 0 0 0 1px var(--mar-ui-border-subtle) inset;
  color: var(--mar-ui-text-disabled);
  cursor: not-allowed;
}
.mar-ui-input__field {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--mar-ui-text-primary);
  font: inherit;
  line-height: 1.4;
}
.mar-ui-input__field::placeholder {
  color: var(--mar-ui-text-secondary);
}
.mar-ui-input__field:disabled {
  color: inherit;
  cursor: inherit;
}
.mar-ui-input__icon {
  flex: none;
}
.mar-ui-input__clear {
  display: inline-grid;
  place-items: center;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  visibility: hidden;
}
.mar-ui-input:is(:hover, :focus-within) .mar-ui-input__clear {
  visibility: visible;
}
.mar-ui-input__clear:focus-visible {
  outline: 2px solid var(--mar-ui-color-brand);
}
@media (forced-colors: active) {
  .mar-ui-input {
    border: 1px solid CanvasText;
  }
  .mar-ui-input:focus-within {
    outline: 2px solid Highlight;
  }
}
</style>
