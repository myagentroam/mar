<script setup lang="ts">
import { cloneVNode, defineComponent, provide, shallowRef, useId, type VNode } from 'vue';
import { usePopup } from '../popup/use-popup.js';
import { dropdownContext, type Command } from './dropdown-context.js';

defineProps<{ trigger?: 'click' }>();
const emit = defineEmits<{ command: [command: Command]; 'visible-change': [visible: boolean] }>();
const slots = defineSlots<{ default(): VNode[]; dropdown(): VNode[] }>();
const id = useId();
const fallbackTriggerId = `${id}-trigger`;
const triggerId = shallowRef(fallbackTriggerId);
const popup = shallowRef<HTMLElement | null>(null);
let trigger: HTMLElement | undefined;
const { open, show, close } = usePopup(() => emit('visible-change', false));

const items = () => [
  ...(popup.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:enabled') ?? [])
];

function expand(event: Event, last = false) {
  if (!popup.value) return;
  trigger = event.currentTarget as HTMLElement;
  triggerId.value = trigger.id;
  show(trigger, popup.value);
  if (!open.value) return;
  emit('visible-change', true);
  (items().at(last ? -1 : 0) ?? popup.value).focus();
}

function restoreFocus() {
  close();
  trigger?.focus();
}

provide(dropdownContext, {
  menuId: id,
  triggerId,
  surface: popup,
  run(command) {
    restoreFocus();
    emit('command', command);
  }
});

const Trigger = defineComponent(() => () => {
  const child = slots.default()[0];
  if (!child) return null;
  return cloneVNode(child, {
    id: child.props?.id ?? fallbackTriggerId,
    'aria-haspopup': 'menu',
    'aria-expanded': open.value,
    'aria-controls': id,
    onMousedown: (event: MouseEvent) => {
      // Keep menu focus until the trigger's click can close it, rather than reopening after blur.
      if (open.value) event.preventDefault();
    },
    onClick: (event: MouseEvent) => (open.value ? restoreFocus() : expand(event)),
    onKeydown: (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      if (!open.value) expand(event, event.key === 'ArrowUp');
    }
  });
});

function onKey(event: KeyboardEvent) {
  if (!open.value || !popup.value?.contains(event.target as Node)) return;
  if (event.key === 'Escape') {
    event.stopPropagation();
    restoreFocus();
  } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const options = items();
    if (!options.length) return;
    const index = options.findIndex((item) => item === event.target);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : (index + (event.key === 'ArrowUp' ? (index < 0 ? 0 : -1) : 1) + options.length) %
            options.length;
    options[next]?.focus();
  }
}

function onFocusOut(event: FocusEvent) {
  if (
    popup.value?.contains(event.target as Node) &&
    !popup.value.contains(event.relatedTarget as Node | null)
  )
    close();
}
</script>

<template>
  <div class="mar-ui-dropdown" @keydown="onKey" @focusout="onFocusOut">
    <Trigger />
    <slot name="dropdown" />
  </div>
</template>

<style scoped>
.mar-ui-dropdown {
  display: inline-flex;
}
</style>
