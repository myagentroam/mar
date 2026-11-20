<script setup lang="ts" generic="Command extends DropdownCommand = string">
// Owns trigger, command and focus behavior. The shared popup owns positioning and dismissal.
import {
  cloneVNode,
  defineComponent,
  nextTick,
  onBeforeUnmount,
  provide,
  shallowRef,
  toRef,
  useId,
  watch,
  type ComponentPublicInstance,
  type StyleValue,
  type VNode
} from 'vue';
import { usePopup, type PopupAnchor, type PopupPlacement } from '../popup/use-popup.js';
import {
  dropdownContext,
  type DropdownCommand,
  type MarDropdownInstance
} from './dropdown-context.js';

const props = withDefaults(
  defineProps<{
    trigger?: 'click' | 'contextmenu';
    disabled?: boolean;
    virtualTriggering?: boolean;
    virtualRef?: PopupAnchor;
    placement?: PopupPlacement;
    offset?: number;
    persistent?: boolean;
    popperClass?: string;
    popperStyle?: StyleValue | undefined;
  }>(),
  { trigger: 'click', placement: 'bottom', persistent: true }
);
const emit = defineEmits<{ command: [command: Command]; 'visible-change': [visible: boolean] }>();
const slots = defineSlots<{ default?(): VNode[]; dropdown(): VNode[] }>();
const id = useId();
const fallbackTriggerId = `${id}-trigger`;
const triggerId = shallowRef<string>();
const root = shallowRef<HTMLElement | null>(null);
const popup = shallowRef<HTMLElement | null>(null);
const renderRequested = shallowRef(false);
let pendingOpen: symbol | undefined;
let trigger: HTMLElement | undefined;
let focusOrigin: HTMLElement | undefined;
let announcedOpen = false;
let tabLeavingMenu = false;
const { open, show, close } = usePopup(() => {
  renderRequested.value = false;
  focusOrigin = undefined;
  if (announcedOpen) {
    announcedOpen = false;
    emit('visible-change', false);
  }
});

const items = () => [
  ...(popup.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:enabled') ?? [])
];

function focusItem(item?: HTMLButtonElement) {
  const menu = popup.value;
  (item ?? menu)?.focus({ preventScroll: true });
  if (!item || !menu) return;
  const row = item.getBoundingClientRect();
  const top = menu.getBoundingClientRect().top + menu.clientTop;
  const bottom = top + menu.clientHeight;
  if (row.top < top) menu.scrollTop += row.top - top;
  else if (row.bottom > bottom) menu.scrollTop += row.bottom - bottom;
}

function canUse(element: HTMLElement) {
  return (
    element.isConnected &&
    !element.matches(':disabled, [aria-disabled="true"]') &&
    !element.closest('[inert]')
  );
}

function expand(anchor: PopupAnchor, origin?: HTMLElement, last = false) {
  if (props.disabled || (origin && !canUse(origin) && !props.virtualTriggering)) return;
  if (!open.value) focusOrigin = origin;
  triggerId.value = props.virtualTriggering ? undefined : trigger?.id;
  const request = Symbol();
  pendingOpen = request;
  renderRequested.value = true;

  function showMenu() {
    if (pendingOpen !== request) return;
    pendingOpen = undefined;
    const menu = popup.value;
    if (!menu || props.disabled || (anchor instanceof HTMLElement && !canUse(anchor))) {
      renderRequested.value = false;
      return;
    }
    const wasOpen = open.value;
    show(anchor, menu, false, { placement: props.placement, offset: props.offset });
    if (!open.value || wasOpen) return;
    announcedOpen = true;
    emit('visible-change', true);
    if (open.value) focusItem(items().at(last ? -1 : 0));
  }

  if (popup.value) showMenu();
  else void nextTick(showMenu);
}

function dismiss(restore = false) {
  pendingOpen = undefined;
  renderRequested.value = false;
  const origin = focusOrigin;
  const menu = popup.value;
  if (
    restore &&
    open.value &&
    origin &&
    menu?.contains(menu.ownerDocument.activeElement) &&
    canUse(origin)
  )
    origin.focus({ preventScroll: true });
  close();
}

function handleOpen() {
  const anchor = props.virtualTriggering ? props.virtualRef : trigger;
  if (!anchor) return;
  const active = root.value?.ownerDocument.activeElement;
  const origin = props.virtualTriggering
    ? active instanceof HTMLElement
      ? active
      : undefined
    : trigger;
  expand(anchor, origin);
}

function handleClose() {
  dismiss(true);
}

const instance: MarDropdownInstance = { handleOpen, handleClose };
defineExpose(instance);
onBeforeUnmount(() => {
  pendingOpen = undefined;
});
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) dismiss();
  }
);
watch(popup, (menu) => {
  if (!menu && open.value) dismiss();
});

provide(dropdownContext, {
  menuId: id,
  triggerId,
  surface: popup,
  popupClass: toRef(() => props.popperClass),
  popupStyle: toRef(() => props.popperStyle),
  activate(command) {
    if (!open.value || props.disabled) return;
    // Emit before closing: visibility listeners may discard the command's target.
    if (command !== undefined) emit('command', command as Command);
    dismiss(true);
  }
});

function setTrigger(value: Element | ComponentPublicInstance | null) {
  if (typeof HTMLElement === 'undefined') return;
  const element =
    value instanceof HTMLElement ? value : (value as ComponentPublicInstance | null)?.$el;
  trigger = element instanceof HTMLElement ? element : undefined;
  if (!trigger && !props.virtualTriggering && open.value) dismiss();
}

function onTriggerKey(event: KeyboardEvent) {
  const element = event.currentTarget as HTMLElement;
  if (event.defaultPrevented || props.disabled || !canUse(element)) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const last = event.key === 'ArrowUp';
    if (open.value) focusItem(items().at(last ? -1 : 0));
    else expand(element, element, last);
  } else if (
    props.trigger === 'contextmenu' &&
    (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
  ) {
    event.preventDefault();
    expand(element, element);
  }
}

const Trigger = defineComponent(() => () => {
  const child = slots.default?.()[0];
  if (!child) return null;
  return cloneVNode(
    child,
    {
      ref: setTrigger,
      id: child.props?.id ?? fallbackTriggerId,
      disabled: props.disabled || child.props?.disabled,
      'aria-haspopup': 'menu',
      'aria-expanded': open.value,
      'aria-controls': props.persistent || renderRequested.value ? id : undefined,
      onMousedown: (event: MouseEvent) => {
        // Keep menu focus until the trigger's click can close it, rather than reopening after blur.
        if (open.value && props.trigger === 'click') event.preventDefault();
      },
      onClick: (event: MouseEvent) => {
        if (event.defaultPrevented || (props.trigger !== 'click' && event.detail !== 0)) return;
        const element = event.currentTarget as HTMLElement;
        if (open.value || pendingOpen) dismiss(true);
        else expand(element, element);
      },
      onContextmenu: (event: MouseEvent) => {
        const element = event.currentTarget as HTMLElement;
        if (
          props.trigger !== 'contextmenu' ||
          event.defaultPrevented ||
          props.disabled ||
          !canUse(element)
        )
          return;
        event.preventDefault();
        const rect = new DOMRect(event.clientX, event.clientY);
        expand({ getBoundingClientRect: () => rect, contextElement: element }, element);
      },
      onKeydown: onTriggerKey
    },
    true
  );
});

function onKey(event: KeyboardEvent) {
  if (event.defaultPrevented || !open.value || !popup.value?.contains(event.target as Node)) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    dismiss(true);
  } else if (event.key === 'Tab') {
    // Let the browser move focus first. Shift+Tab can land on the trigger.
    tabLeavingMenu = true;
    setTimeout(() => (tabLeavingMenu = false), 0);
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
    focusItem(options[next]);
  }
}

function onFocusOut(event: FocusEvent) {
  const menu = popup.value;
  const from = event.target as Node;
  const to = event.relatedTarget as Node | null;
  if (!open.value || !menu || menu.contains(to)) return;
  if (menu.contains(from) && to === trigger && !tabLeavingMenu) return;
  if (menu.contains(from) || from === trigger) dismiss();
}
</script>

<template>
  <div
    ref="root"
    class="mar-ui-dropdown"
    :class="{ 'mar-ui-dropdown--virtual': virtualTriggering }"
    @keydown="onKey"
    @focusout="onFocusOut"
  >
    <Trigger v-if="!virtualTriggering" />
    <slot v-if="persistent || renderRequested" name="dropdown" />
  </div>
</template>

<style scoped>
.mar-ui-dropdown {
  display: inline-flex;
}

.mar-ui-dropdown--virtual {
  display: contents;
}
</style>
