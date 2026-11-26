<script setup lang="ts">
import { inject, onBeforeUnmount, ref, watch } from 'vue';
import { marUiTooltipDirectiveKey } from '../tooltip/tooltip-directive.js';

// Owns the pointer and keyboard gesture; consumers own panel sizing and layout policy.
const props = defineProps<{
  target: HTMLElement | undefined;
  label: string;
  min: number;
  max: number;
  direction: 1 | -1;
  width?: number;
  gestureKey?: string | number | boolean;
}>();
const emit = defineEmits<{ resize: [width: number] }>();
const vTooltip = inject(marUiTooltipDirectiveKey, {});
const dragging = ref(false);
const handle = ref<HTMLElement>();
const currentWidth = ref<number>();
let drag: { pointerId: number; x: number; width: number } | undefined;

function clampWidth(width: number): number {
  return Math.max(props.min, Math.min(props.max, width));
}

function settledWidth(): number | undefined {
  if (props.target === undefined) return undefined;
  for (const animation of props.target.getAnimations()) {
    if (animation instanceof CSSTransition && animation.transitionProperty === 'width')
      animation.finish();
  }
  return props.target.getBoundingClientRect().width;
}

function start(event: PointerEvent): void {
  if (event.button !== 0 || drag !== undefined) return;
  const width = settledWidth();
  if (width === undefined) return;
  event.preventDefault();
  const element = event.currentTarget as HTMLElement;
  element.setPointerCapture(event.pointerId);
  drag = {
    pointerId: event.pointerId,
    x: event.clientX,
    width
  };
  dragging.value = true;
}

function move(event: PointerEvent): void {
  if (drag?.pointerId !== event.pointerId) return;
  emit('resize', clampWidth(drag.width + props.direction * (event.clientX - drag.x)));
}

function finish(event: PointerEvent): void {
  if (drag?.pointerId !== event.pointerId) return;
  drag = undefined;
  dragging.value = false;
  const handle = event.currentTarget as HTMLElement;
  if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
}

function cancel(): void {
  const pointerId = drag?.pointerId;
  drag = undefined;
  dragging.value = false;
  if (pointerId !== undefined && handle.value?.hasPointerCapture(pointerId))
    handle.value.releasePointerCapture(pointerId);
}

function keydown(event: KeyboardEvent): void {
  const { key } = event;
  if (key !== 'Home' && key !== 'End' && key !== 'ArrowLeft' && key !== 'ArrowRight') return;
  const width = settledWidth();
  if (width === undefined) return;
  let next: number;
  if (key === 'Home') next = props.min;
  else if (key === 'End') next = props.max;
  else next = width + (key === 'ArrowLeft' ? -1 : 1) * props.direction * 10;
  event.preventDefault();
  emit('resize', clampWidth(next));
}

// CSS-sized panels can change width independently of input or focus.
watch(
  () => (props.width === undefined ? props.target : undefined),
  (target, _previous, onCleanup) => {
    if (target === undefined) {
      currentWidth.value = undefined;
      return;
    }
    const measure = () => {
      currentWidth.value = clampWidth(target.offsetWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target, { box: 'border-box' });
    onCleanup(() => observer.disconnect());
  },
  { immediate: true, flush: 'post' }
);
watch(() => props.gestureKey, cancel, { flush: 'sync' });
onBeforeUnmount(cancel);
</script>

<template>
  <div
    ref="handle"
    v-tooltip="label"
    class="mar-panel-resize-handle"
    :class="{ dragging }"
    role="separator"
    tabindex="0"
    aria-orientation="vertical"
    :aria-label="label"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-valuenow="width ?? currentWidth"
    @keydown="keydown"
    @pointerdown="start"
    @pointermove="move"
    @pointerup="finish"
    @pointercancel="finish"
    @lostpointercapture="finish"
  />
</template>

<style scoped>
.mar-panel-resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 7px;
  cursor: col-resize;
  touch-action: none;
  user-select: none;
}
.mar-panel-resize-handle::before {
  position: absolute;
  inset: 0 3px;
  background: transparent;
  content: '';
}
.mar-panel-resize-handle:hover::before,
.mar-panel-resize-handle:focus-visible::before,
.mar-panel-resize-handle.dragging::before {
  background: var(--mar-ui-control-focus);
}
.mar-panel-resize-handle.dragging::after {
  position: fixed;
  inset: 0;
  content: '';
  cursor: col-resize;
}
</style>
