<script setup lang="ts">
import { nextTick } from 'vue';
import { MarIcon } from '../../icons/index.js';
import { useMarFormControl } from '../form/form-context.js';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    id?: string;
    modelValue?: boolean;
    disabled?: boolean | undefined;
    loading?: boolean;
  }>(),
  { disabled: undefined }
);
const { id, disabled, ariaInvalid, describedBy } = useMarFormControl({
  id: () => props.id,
  disabled: () => props.disabled
});
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; change: [value: boolean] }>();

async function onChange(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  if (!disabled.value && !props.loading) {
    const checked = input.checked;
    emit('update:modelValue', checked);
    emit('change', checked);
  }
  await nextTick();
  // A controlled caller may wait for a write before accepting the new value.
  input.checked = props.modelValue === true;
}
</script>

<template>
  <span class="mar-ui-switch" :class="$attrs.class" :style="$attrs.style">
    <input
      v-bind="{
        ...$attrs,
        'aria-invalid': ariaInvalid($attrs['aria-invalid']),
        'aria-describedby': describedBy($attrs['aria-describedby']),
        class: undefined,
        style: undefined
      }"
      :id="id"
      type="checkbox"
      role="switch"
      :checked="modelValue"
      :disabled="disabled || loading"
      :aria-busy="loading || undefined"
      @change="onChange"
      @keydown.enter.prevent="($event.currentTarget as HTMLInputElement).click()"
    />
    <span class="mar-ui-switch__track" aria-hidden="true">
      <span class="mar-ui-switch__thumb">
        <MarIcon v-if="loading" name="loading-action" class="mar-ui-switch__spinner" />
      </span>
    </span>
  </span>
</template>

<style scoped>
.mar-ui-switch {
  position: relative;
  display: inline-grid;
  place-items: center;
  flex: none;
  inline-size: 40px;
  min-block-size: var(--mar-ui-compact-control-size, 24px);
  vertical-align: middle;
}
.mar-ui-switch > input {
  position: absolute;
  inset-inline: 0;
  inset-block: 0;
  inline-size: 100%;
  block-size: 100%;
  margin: auto 0;
  opacity: 0;
  cursor: pointer;
}
.mar-ui-switch__track {
  --mar-ui-switch-thumb-size: 14px;
  --mar-ui-switch-thumb-inset: 2px;
  position: relative;
  box-sizing: border-box;
  inline-size: 100%;
  block-size: 20px;
  border: 1px solid var(--mar-ui-border-medium);
  border-radius: 999px;
  background: var(--mar-ui-fill-soft);
  color: var(--mar-ui-text-secondary);
  pointer-events: none;
}
.mar-ui-switch__thumb {
  position: absolute;
  inset-block: 0;
  inset-inline-start: var(--mar-ui-switch-thumb-inset);
  margin-block: auto;
  display: grid;
  place-items: center;
  inline-size: var(--mar-ui-switch-thumb-size);
  block-size: var(--mar-ui-switch-thumb-size);
  border-radius: 50%;
  background: currentColor;
}
.mar-ui-switch > input:checked + .mar-ui-switch__track {
  border-color: var(--mar-ui-color-brand);
  background: var(--mar-ui-color-brand);
  color: var(--mar-ui-color-on-accent);
}
.mar-ui-switch > input:checked + .mar-ui-switch__track .mar-ui-switch__thumb {
  inset-inline-start: calc(
    100% - var(--mar-ui-switch-thumb-size) - var(--mar-ui-switch-thumb-inset)
  );
}
.mar-ui-switch > input:focus-visible + .mar-ui-switch__track {
  outline: 2px solid var(--mar-ui-color-brand);
  outline-offset: 2px;
}
.mar-ui-switch > input:disabled {
  cursor: not-allowed;
}
.mar-ui-switch > input:disabled + .mar-ui-switch__track {
  border-color: var(--mar-ui-border-subtle);
  background: var(--mar-ui-fill-soft);
  color: var(--mar-ui-text-disabled);
}
.mar-ui-switch > input[aria-busy='true'] {
  cursor: progress;
}
.mar-ui-switch__thumb:has(.mar-ui-switch__spinner) {
  background: transparent;
}
.mar-ui-switch__spinner {
  font-size: 14px;
}
@media (pointer: coarse) {
  .mar-ui-switch__track {
    block-size: 24px;
  }
}
@media (prefers-reduced-motion: no-preference) {
  .mar-ui-switch__track {
    transition:
      border-color var(--mar-ui-motion-duration-fast),
      background-color var(--mar-ui-motion-duration-fast),
      color var(--mar-ui-motion-duration-fast);
  }
  .mar-ui-switch__thumb {
    transition: inset-inline-start var(--mar-ui-motion-duration-fast);
  }
  .mar-ui-switch__spinner {
    animation: mar-ui-switch-spin 1.4s linear infinite;
  }
  @keyframes mar-ui-switch-spin {
    to {
      transform: rotate(1turn);
    }
  }
}
@media (forced-colors: active) {
  .mar-ui-switch__track {
    forced-color-adjust: none;
    border-color: ButtonText;
    background: Canvas;
    color: ButtonText;
  }
  .mar-ui-switch > input:checked + .mar-ui-switch__track {
    border-color: Highlight;
    background: Highlight;
    color: HighlightText;
  }
  .mar-ui-switch > input:disabled + .mar-ui-switch__track {
    border-color: GrayText;
    background: Canvas;
    color: GrayText;
  }
  .mar-ui-switch > input:focus-visible + .mar-ui-switch__track {
    outline-color: Highlight;
  }
}
</style>
