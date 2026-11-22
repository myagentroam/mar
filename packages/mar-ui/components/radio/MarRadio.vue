<script setup lang="ts">
import { computed, inject, nextTick, useId } from 'vue';
import { radioGroupKey, type RadioValue } from './radio-context.js';

defineOptions({ inheritAttrs: false });
const props = defineProps<{ value: RadioValue; disabled?: boolean; button?: boolean }>();
const group = inject(radioGroupKey, undefined);
const id = useId();
const checked = computed(() => group?.checked(props.value) ?? false);

async function change(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  if (!input.checked) return;
  group?.select(props.value);
  await nextTick();
  // A rejected controlled update must restore the previous native radio in the group.
  if (!checked.value) {
    input.checked = false;
    const previous = input
      .closest('[role=radiogroup]')
      ?.querySelector<HTMLInputElement>('[data-checked=true]');
    if (previous) previous.checked = true;
  }
}
</script>

<template>
  <span
    class="mar-ui-radio"
    :class="[button && 'mar-ui-radio--button', $attrs.class]"
    :style="$attrs.style"
  >
    <input
      v-bind="{ ...$attrs, class: undefined, style: undefined }"
      :id="id"
      type="radio"
      :name="group?.name"
      :checked="checked"
      :data-checked="checked"
      :disabled="disabled || group?.disabled()"
      @change="change"
    />
    <label :for="id"><slot /></label>
  </span>
</template>

<style scoped>
.mar-ui-radio {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-block-size: var(--mar-ui-compact-control-size, 24px);
  color: var(--mar-ui-text-primary);
  font-size: var(--mar-ui-font-size-control);
}
input {
  inline-size: 14px;
  block-size: 14px;
  margin: 0;
  flex: none;
  accent-color: var(--mar-ui-control-primary-bg);
}
label,
input {
  cursor: pointer;
}
label {
  font-size: inherit;
}
input:disabled,
input:disabled + label {
  color: var(--mar-ui-text-disabled);
  cursor: not-allowed;
}
input:focus-visible {
  outline: 2px solid var(--mar-ui-control-focus);
  outline-offset: 2px;
}
.mar-ui-radio--button input {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  opacity: 0;
}
.mar-ui-radio--button label {
  display: grid;
  place-items: center;
  box-sizing: border-box;
  min-block-size: var(--mar-ui-compact-control-size, 24px);
  padding-inline: 0.5rem;
  border: 1px solid var(--mar-ui-input-border);
  background: var(--mar-ui-bg-panel);
}
.mar-ui-radio--button + .mar-ui-radio--button label {
  border-inline-start: 0;
}
.mar-ui-radio--button:first-child label {
  border-start-start-radius: var(--mar-ui-radius-control);
  border-end-start-radius: var(--mar-ui-radius-control);
}
.mar-ui-radio--button:last-child label {
  border-start-end-radius: var(--mar-ui-radius-control);
  border-end-end-radius: var(--mar-ui-radius-control);
}
.mar-ui-radio--button input:checked + label {
  background: var(--mar-ui-fill-selection);
  font-weight: 600;
}
.mar-ui-radio--button input:focus-visible + label {
  outline: 2px solid var(--mar-ui-control-focus);
  outline-offset: -2px;
}
@supports not (accent-color: auto) {
  input:checked {
    outline: 1px solid var(--mar-ui-control-focus);
  }
}
</style>
