<script setup lang="ts">
import { computed, type Component, type PropType } from 'vue';
import type { MarIconName } from '../../icons/icon-shapes.js';
import { resolveMarIcon } from '../../icons/mar-icons.js';

const props = defineProps({
  type: { type: String as PropType<'default' | 'primary' | 'danger'>, default: 'default' },
  nativeType: { type: String as PropType<'button' | 'submit'>, default: 'button' },
  text: Boolean,
  link: Boolean,
  icon: [String, Object, Function] as PropType<MarIconName | Component>,
  loadingIcon: [String, Object, Function] as PropType<MarIconName | Component>,
  disabled: Boolean,
  loading: Boolean
});
const spinner = computed(() => resolveMarIcon(props.loadingIcon ?? 'loading-action'));
</script>

<template>
  <button
    class="mar-ui-button"
    :class="[
      `mar-ui-button--${type}`,
      {
        'mar-ui-button--ghost': text && !link,
        'mar-ui-button--inline': link,
        'mar-ui-button--disabled': disabled,
        'mar-ui-button--text-only': !icon && $slots.default
      }
    ]"
    :type="nativeType"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
  >
    <span v-if="icon || $slots.default || loading" class="mar-ui-button__icon" aria-hidden="true">
      <component :is="spinner" v-if="loading" class="mar-ui-button__spinner" />
      <component :is="resolveMarIcon(icon)" v-else-if="icon" />
    </span>
    <span v-if="$slots.default" class="mar-ui-button__label"><slot /></span>
  </button>
</template>

<style scoped>
.mar-ui-button {
  --mar-ui-button-fg: var(--mar-ui-text-secondary);
  --mar-ui-button-bg: var(--mar-ui-bg-panel);
  --mar-ui-button-border: var(--mar-ui-border-default);
  --mar-ui-button-hover-bg: var(--mar-ui-fill-row-hover);
  --mar-ui-button-hover-border: var(--mar-ui-border-medium);
  --mar-ui-button-hover-fg: var(--mar-ui-text-primary);
  --mar-ui-button-active-bg: var(--mar-ui-fill-selection);
  --mar-ui-button-active-border: var(--mar-ui-button-hover-border);
  --mar-ui-button-disabled-fg: var(--mar-ui-text-disabled);
  --mar-ui-button-disabled-bg: var(--mar-ui-bg-panel);
  --mar-ui-button-disabled-border: var(--mar-ui-border-subtle);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  min-block-size: 32px;
  padding: 0.25rem 0.875rem;
  border: 1px solid var(--mar-ui-button-border);
  border-radius: var(--mar-ui-radius-control);
  background: var(--mar-ui-button-bg);
  color: var(--mar-ui-button-fg);
  font: inherit;
  font-size: var(--mar-ui-font-size-body);
  font-weight: 500;
  line-height: 1.35;
  cursor: pointer;
}

.mar-ui-button--primary {
  --mar-ui-button-fg: var(--mar-ui-color-on-accent);
  --mar-ui-button-bg: var(--mar-ui-color-brand);
  --mar-ui-button-border: var(--mar-ui-color-brand);
  --mar-ui-button-hover-bg: var(--mar-ui-color-brand-hover);
  --mar-ui-button-hover-border: var(--mar-ui-color-brand-hover);
  --mar-ui-button-hover-fg: var(--mar-ui-color-on-accent);
  --mar-ui-button-active-bg: var(--mar-ui-control-color-primary-dark-2);
  --mar-ui-button-active-border: var(--mar-ui-button-active-bg);
  --mar-ui-button-disabled-fg: var(--mar-ui-control-disabled-on-accent);
  --mar-ui-button-disabled-bg: var(--mar-ui-control-color-primary-light-5);
  --mar-ui-button-disabled-border: var(--mar-ui-button-disabled-bg);
}

.mar-ui-button--ghost,
.mar-ui-button--inline {
  --mar-ui-button-bg: transparent;
  --mar-ui-button-border: transparent;
  --mar-ui-button-hover-border: transparent;
  --mar-ui-button-disabled-bg: transparent;
  --mar-ui-button-disabled-border: transparent;
}

.mar-ui-button--inline {
  --mar-ui-button-fg: var(--mar-ui-control-link-text);
  min-block-size: auto;
  padding: 0;
}

.mar-ui-button--danger {
  --mar-ui-button-fg: var(--mar-ui-control-color-danger);
}

@media (hover: hover) {
  .mar-ui-button:enabled:hover {
    background: var(--mar-ui-button-hover-bg);
    border-color: var(--mar-ui-button-hover-border);
    color: var(--mar-ui-button-hover-fg);
  }
}

.mar-ui-button:enabled:active {
  background: var(--mar-ui-button-active-bg);
  border-color: var(--mar-ui-button-active-border);
  color: var(--mar-ui-button-hover-fg);
}

.mar-ui-button:focus-visible {
  outline: 2px solid var(--mar-ui-color-brand);
  outline-offset: 2px;
}

.mar-ui-button--disabled {
  background: var(--mar-ui-button-disabled-bg);
  border-color: var(--mar-ui-button-disabled-border);
  color: var(--mar-ui-button-disabled-fg);
  cursor: not-allowed;
}

.mar-ui-button[aria-busy='true'] {
  cursor: progress;
}

.mar-ui-button__icon,
.mar-ui-button--text-only::after {
  flex: 0 0 1em;
  inline-size: 1em;
}

.mar-ui-button__icon {
  display: inline-grid;
  place-items: center;
  block-size: 1em;
}

@media (prefers-reduced-motion: no-preference) {
  .mar-ui-button__spinner {
    animation: mar-ui-button-spin 1.4s linear infinite;
  }
}

@keyframes mar-ui-button-spin {
  to {
    transform: rotate(360deg);
  }
}

.mar-ui-button--text-only::after {
  content: '';
}

.mar-ui-button__label {
  min-inline-size: 0;
  overflow-wrap: anywhere;
}
</style>
