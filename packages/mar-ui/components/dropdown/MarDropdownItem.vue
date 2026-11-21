<script setup lang="ts">
import { inject, useTemplateRef, type Component } from 'vue';
import type { MarIconName } from '../../icons/icon-shapes.js';
import { resolveMarIcon } from '../../icons/mar-icons.js';
import { marUiTooltipDirectiveKey, readOverflowText } from '../tooltip/tooltip-directive.js';
import { dropdownContext, type DropdownCommand } from './dropdown-context.js';

const props = defineProps<{
  command?: DropdownCommand;
  disabled?: boolean;
  divided?: boolean;
  icon?: MarIconName | Component;
}>();
const emit = defineEmits<{ click: [event: MouseEvent] }>();
const dropdown = inject(dropdownContext);
const tooltip = inject(marUiTooltipDirectiveKey, undefined);
const vOverflowTooltip = tooltip ?? {};
const label = useTemplateRef<HTMLElement>('label');

function collectClippedText(element: HTMLElement, clipped: string[]) {
  for (const part of element.children) {
    if (!(part instanceof HTMLElement)) continue;
    const { overflowX, textOverflow } = getComputedStyle(part);
    const text =
      textOverflow === 'ellipsis' && (overflowX === 'hidden' || overflowX === 'clip')
        ? readOverflowText(part)
        : undefined;
    if (text) clipped.push(text);
    else collectClippedText(part, clipped);
  }
}

function overflowText() {
  const element = label.value;
  if (!element?.childElementCount) return readOverflowText(element);

  // Composite labels have no box; the slotted parts own their truncation.
  const clipped: string[] = [];
  collectClippedText(element, clipped);
  return clipped.join('\n') || undefined;
}

function activate(event: MouseEvent) {
  if (props.disabled) return;
  emit('click', event);
  if (!event.defaultPrevented) dropdown?.activate(props.command);
}
</script>

<template>
  <button
    v-overflow-tooltip="overflowText"
    type="button"
    role="menuitem"
    tabindex="-1"
    class="mar-ui-dropdown-item"
    :class="{ 'mar-ui-dropdown-item--divided': divided }"
    :disabled="disabled"
    :aria-disabled="disabled || undefined"
    @click="activate"
  >
    <component :is="resolveMarIcon(icon)" v-if="icon" aria-hidden="true" />
    <span
      ref="label"
      class="mar-ui-dropdown-item__label"
      :class="{ 'mar-ui-dropdown-item__label--hint': tooltip }"
      ><slot
    /></span>
  </button>
</template>

<style scoped>
.mar-ui-dropdown-item {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-height: var(--mar-ui-compact-control-size);
  padding: 0.25rem 0.75rem;
  border: 0;
  background: transparent;
  color: var(--mar-ui-text-secondary);
  font: inherit;
  text-align: start;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.mar-ui-dropdown-item__label {
  min-width: 0;
}
.mar-ui-dropdown-item__label:has(> *) {
  display: contents;
}
@media (hover: hover) and (pointer: fine) {
  .mar-ui-dropdown-item__label--hint:not(:has(> *)) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
.mar-ui-dropdown-item--divided {
  position: relative;
  margin-block-start: 9px;
}
.mar-ui-dropdown-item--divided::before {
  position: absolute;
  inset-block-start: -5px;
  inset-inline: 0;
  block-size: 1px;
  background: var(--mar-ui-border-subtle);
  pointer-events: none;
  content: '';
}
.mar-ui-dropdown-item:enabled:is(:hover, :focus-visible):not([aria-current='true']) {
  background: var(--mar-ui-fill-row-hover);
  color: var(--mar-ui-text-primary);
}
.mar-ui-dropdown-item:enabled[aria-current='true'] {
  background: var(--mar-ui-fill-selection);
  color: var(--mar-ui-text-primary);
}
.mar-ui-dropdown-item:focus-visible {
  outline: 2px solid var(--mar-ui-control-focus);
  outline-offset: -2px;
}
.mar-ui-dropdown-item:disabled {
  color: var(--mar-ui-text-disabled);
  cursor: not-allowed;
}
</style>
