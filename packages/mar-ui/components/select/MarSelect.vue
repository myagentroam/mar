<script setup lang="ts" generic="Value extends OptionValue">
import {
  computed,
  provide,
  shallowReactive,
  shallowRef,
  useId,
  useTemplateRef,
  watch,
  type Component
} from 'vue';
import type { MarIconName } from '../../icons/icon-shapes.js';
import { resolveMarIcon } from '../../icons/mar-icons.js';
import { useMarUiLocale } from '../../locale/index.js';
import { usePopup } from '../popup/use-popup.js';
import '../popup/surface.css';
import { optionContext, type Choice, type OptionValue } from './option-context.js';

defineOptions({ inheritAttrs: false });
const props = defineProps<{
  id?: string;
  ariaLabel?: string;
  ariaLabelledby?: string;
  modelValue?: Value;
  disabled?: boolean;
  placeholder?: string;
  suffixIcon?: MarIconName | Component;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: Value]; change: [value: Value] }>();
const locale = useMarUiLocale();
const id = useId();
const trigger = useTemplateRef('trigger');
const list = useTemplateRef('list');
const choices = shallowReactive(new Set<Choice>());
const active = shallowRef<Choice>();
const available = computed(() => [...choices].filter((item) => !item.disabled));
const selected = computed(() => [...choices].find((item) => item.value === props.modelValue));
const { open, show, close } = usePopup(() => {
  active.value = undefined;
});

function choose(item: Choice) {
  if (props.disabled || item.disabled) return;
  if (item.value !== props.modelValue) {
    // Slotted options share the select's value type; Vue cannot infer it across the slot.
    emit('update:modelValue', item.value as Value);
    emit('change', item.value as Value);
  }
  close();
}

provide(optionContext, {
  register(item) {
    choices.add(item);
    return () => {
      choices.delete(item);
      if (active.value === item) active.value = undefined;
    };
  },
  selected: (item) => item === selected.value,
  active: (item) => item === active.value,
  choose
});

function revealActive() {
  const surface = list.value;
  if (!surface || !active.value) return;
  const option = surface.ownerDocument.getElementById(active.value.id);
  if (!option) return;
  // Scroll the listbox, not the page behind the anchored popup.
  const row = option.getBoundingClientRect();
  const top = surface.getBoundingClientRect().top + surface.clientTop;
  const bottom = top + surface.clientHeight;
  if (row.top < top) surface.scrollTop += row.top - top;
  else if (row.bottom > bottom) surface.scrollTop += row.bottom - bottom;
}

function expand(key?: string) {
  if (!trigger.value || !list.value || props.disabled) return;
  const current = selected.value;
  active.value =
    key === 'Home' || key === 'End' || !current || current.disabled
      ? available.value.at(key === 'ArrowUp' || key === 'End' ? -1 : 0)
      : current;
  show(trigger.value, list.value, true);
  if (open.value) revealActive();
}

function move(key: string) {
  const items = available.value;
  if (!items.length) return;
  const index = active.value ? items.indexOf(active.value) : -1;
  const next =
    key === 'Home'
      ? 0
      : key === 'End'
        ? items.length - 1
        : (index + (key === 'ArrowUp' ? (index === -1 ? 0 : -1) : 1) + items.length) % items.length;
  active.value = items[next];
  revealActive();
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'Tab') {
    close();
    return;
  }
  if (event.key === 'Escape' && open.value) {
    event.stopPropagation();
    close();
    return;
  }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    if (!open.value) expand(event.key);
    else move(event.key);
  } else if (open.value && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    if (active.value) choose(active.value);
  }
}

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) close();
  }
);
</script>

<template>
  <div class="mar-ui-select" :class="$attrs.class" :style="$attrs.style">
    <button
      v-bind="{ ...$attrs, class: undefined, style: undefined }"
      :id="props.id ?? `${id}-trigger`"
      ref="trigger"
      type="button"
      role="combobox"
      :aria-label="props.ariaLabel"
      :aria-labelledby="props.ariaLabelledby"
      :aria-expanded="open"
      :aria-controls="id"
      :aria-activedescendant="open ? active?.id : undefined"
      :disabled="props.disabled"
      @click="open ? close() : expand()"
      @keydown="onKey"
      @blur="close"
    >
      <span
        class="mar-ui-select__label"
        :class="{ 'mar-ui-select__label--placeholder': !selected }"
        >{{ selected?.label ?? props.placeholder ?? locale.select }}</span
      >
      <component
        :is="resolveMarIcon(props.suffixIcon ?? 'chevron-down')"
        class="mar-ui-select__icon"
        aria-hidden="true"
      />
    </button>
    <div
      :id="id"
      ref="list"
      popover="manual"
      class="mar-ui-popup"
      role="listbox"
      :aria-label="props.ariaLabel"
      :aria-labelledby="props.ariaLabelledby"
    >
      <slot />
      <div v-if="choices.size === 0" class="mar-ui-select__empty">{{ locale.noData }}</div>
    </div>
  </div>
</template>

<style scoped>
.mar-ui-select {
  min-width: 0;
  width: 100%;
}
.mar-ui-select > button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.375rem;
  width: 100%;
  min-height: 32px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--mar-ui-radius-control);
  background: var(--mar-ui-bg-panel);
  box-shadow: 0 0 0 1px var(--mar-ui-input-border) inset;
  color: var(--mar-ui-text-primary);
  font: inherit;
  font-size: var(--mar-ui-font-size-body);
  text-align: start;
  cursor: pointer;
}
.mar-ui-select > button:hover {
  box-shadow: 0 0 0 1px var(--mar-ui-input-border-hover) inset;
}
.mar-ui-select > button:is(:focus-visible, [aria-expanded='true']) {
  outline: none;
  box-shadow: 0 0 0 1px var(--mar-ui-color-brand) inset;
}
.mar-ui-select > button:disabled {
  background: var(--mar-ui-fill-soft);
  box-shadow: 0 0 0 1px var(--mar-ui-border-subtle) inset;
  color: var(--mar-ui-text-disabled);
  cursor: not-allowed;
}
.mar-ui-select > button:focus-visible + .mar-ui-popup {
  --mar-ui-select-option-focus: 2px solid var(--mar-ui-color-brand);
}
.mar-ui-select__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mar-ui-select__icon {
  flex: none;
}
.mar-ui-select > button:enabled :is(.mar-ui-select__icon, .mar-ui-select__label--placeholder) {
  color: var(--mar-ui-text-secondary);
}
.mar-ui-select__empty {
  padding: 6px 12px;
  color: var(--mar-ui-text-secondary);
  text-align: center;
}
@media (forced-colors: active) {
  .mar-ui-select > button {
    border: 1px solid ButtonText;
  }
  .mar-ui-select > button:is(:focus-visible, [aria-expanded='true']) {
    outline: 2px solid Highlight;
  }
  .mar-ui-select > button:focus-visible + .mar-ui-popup {
    --mar-ui-select-option-focus: 2px solid Highlight;
  }
}
</style>
