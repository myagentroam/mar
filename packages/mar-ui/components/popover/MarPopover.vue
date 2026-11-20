<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  useTemplateRef,
  watch,
  type CSSProperties
} from 'vue';
import { usePopup, type PopupAnchor, type PopupPlacement } from '../popup/use-popup.js';
import '../popup/surface.css';

/** Presents anchored rich content while leaving business state and commands with its caller. */
const props = withDefaults(
  defineProps<{
    visible?: boolean | undefined;
    disabled?: boolean;
    virtualRef?: PopupAnchor | undefined;
    trigger?: 'click' | ('hover' | 'focus')[];
    placement?: PopupPlacement | undefined;
    width?: string | number;
    showArrow?: boolean;
    showAfter?: number;
    hideAfter?: number;
    popperClass?: string;
    popperStyle?: CSSProperties | undefined;
    outsideDismiss?: boolean;
  }>(),
  { visible: undefined, showArrow: true, outsideDismiss: true, showAfter: 0, hideAfter: 0 }
);
const emit = defineEmits<{ 'update:visible': [value: boolean]; 'after-leave': [] }>();
const reference = useTemplateRef<HTMLElement>('reference');
const surface = useTemplateRef<HTMLElement>('surface');
const local = ref(false);
const displayed = computed(() => !props.disabled && (props.visible ?? local.value));
const trigger = computed(
  () => props.virtualRef ?? reference.value?.firstElementChild ?? reference.value
);
let timer: ReturnType<typeof setTimeout> | undefined;
let syncing = false;
let restoringFocus = false;
const retained = ref(false);
let generation = 0;

async function leave(element: HTMLElement | null) {
  const current = ++generation;
  await nextTick();
  await Promise.allSettled((element?.getAnimations() ?? []).map(({ finished }) => finished));
  if (current !== generation || displayed.value) return;
  syncing = true;
  popup.close();
  syncing = false;
  retained.value = false;
  emit('after-leave');
}

function setVisible(open: boolean) {
  clearTimeout(timer);
  local.value = open;
  if (props.visible !== undefined && open !== props.visible) emit('update:visible', open);
}
function cancelTimer() {
  clearTimeout(timer);
}
function hide() {
  setVisible(false);
}
function hasInterest(kind: 'hover' | 'focus'): boolean {
  if (!Array.isArray(props.trigger) || !props.trigger.includes(kind)) return false;
  return [reference.value, surface.value].some((element) =>
    kind === 'hover'
      ? element?.matches(':hover')
      : element?.contains(element.ownerDocument.activeElement)
  );
}
function schedule(open: boolean, kind: 'hover' | 'focus') {
  if (restoringFocus || !Array.isArray(props.trigger) || !props.trigger.includes(kind)) return;
  // Don't cancel another input's pending or displayed preview when one input leaves.
  if (!open && hasInterest(kind === 'hover' ? 'focus' : 'hover')) return;
  clearTimeout(timer);
  const wait = open ? props.showAfter : props.hideAfter;
  if (!open) {
    timer = setTimeout(() => {
      if (!hasInterest('hover') && !hasInterest('focus')) hide();
    }, wait);
  } else if (wait) timer = setTimeout(() => setVisible(true), wait);
  else setVisible(true);
}

function onEscape(event: KeyboardEvent) {
  if (!displayed.value || event.defaultPrevented || event.isComposing) return;
  const anchor = trigger.value;
  if (!reference.value || !(anchor instanceof HTMLElement)) return;
  event.preventDefault();
  event.stopPropagation();
  if (surface.value?.contains(anchor.ownerDocument.activeElement)) {
    // Dismissal may return focus, but that focus must not open the same panel again.
    restoringFocus = true;
    anchor.focus({ preventScroll: true });
    restoringFocus = false;
  }
  hide();
}

function onHoveredEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
  // The focused surface still owns its keyboard action. Dismiss only the hovered preview.
  if (hasInterest('hover')) hide();
}

watch(
  [displayed, surface, () => props.trigger],
  ([open, element, triggers], _, onCleanup) => {
    if (!open || !element || !Array.isArray(triggers) || !triggers.includes('hover')) return;
    const doc = element.ownerDocument;
    doc.addEventListener('keydown', onHoveredEscape);
    onCleanup(() => doc.removeEventListener('keydown', onHoveredEscape));
  },
  { flush: 'post' }
);

const popup = usePopup(() => {
  if (!syncing && displayed.value && props.outsideDismiss) hide();
});
watch(
  [displayed, trigger, surface, () => props.placement],
  ([open, anchor, element, placement], [wasOpen]) => {
    if (open && element && anchor) {
      ++generation;
      retained.value = true;
      popup.show(
        anchor instanceof HTMLElement
          ? anchor
          : anchor instanceof Element
            ? {
                contextElement: anchor,
                getBoundingClientRect: () => anchor.getBoundingClientRect()
              }
            : anchor,
        element,
        false,
        { placement, outsideDismiss: props.outsideDismiss }
      );
    } else if (wasOpen && !open) void leave(element);
  },
  { flush: 'post' }
);
onBeforeUnmount(() => {
  ++generation;
  clearTimeout(timer);
});
defineExpose({ hide });
</script>

<template>
  <span
    v-if="$slots.reference"
    ref="reference"
    class="mar-ui-popover__reference"
    @mouseenter="schedule(true, 'hover')"
    @mouseleave="schedule(false, 'hover')"
    @focusin="schedule(true, 'focus')"
    @focusout="schedule(false, 'focus')"
    @keydown.esc="onEscape"
  >
    <slot name="reference" />
  </span>
  <div
    v-if="displayed || retained"
    ref="surface"
    :inert="!displayed"
    :data-closing="!displayed || undefined"
    popover="manual"
    class="mar-ui-popup mar-ui-popover"
    :class="[popperClass, { 'mar-ui-popover--no-arrow': !showArrow }]"
    :style="[
      {
        '--mar-ui-popup-width': typeof width === 'number' ? `${width}px` : width
      },
      popperStyle
    ]"
    @focusin="cancelTimer"
    @focusout="schedule(false, 'focus')"
    @mouseenter="cancelTimer"
    @mouseleave="schedule(false, 'hover')"
    @keydown.esc="onEscape"
  >
    <div class="mar-ui-popup__content"><slot /></div>
  </div>
</template>

<style scoped>
.mar-ui-popover__reference {
  display: inline-flex;
}
.mar-ui-popover {
  --mar-ui-popup-padding: 12px;
}
.mar-ui-popover.mar-compact-popover {
  --mar-ui-popup-padding: 0;
}
.mar-ui-popover.mar-content-popover {
  --mar-ui-popup-radius: var(--mar-ui-radius-surface);
  box-shadow: var(--mar-ui-content-popover-shadow);
}
.mar-ui-popover--no-arrow::before {
  display: none;
}
.mar-ui-popover[data-closing] {
  pointer-events: none;
}
@media (prefers-reduced-motion: no-preference) {
  .mar-ui-popover[data-closing] {
    animation: mar-popover-out var(--mar-ui-popover-leave-duration, 130ms) ease-in both;
  }
  @keyframes mar-popover-out {
    to {
      opacity: 0;
    }
  }
}
</style>
