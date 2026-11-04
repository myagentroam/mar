<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';

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
const dragging = ref(false);
const handle = ref<HTMLElement>();
const currentWidth = ref<number>();
let drag: { pointerId: number; x: number; width: number } | undefined;

function resize(value: number): void {
  const width = Math.max(props.min, Math.min(props.max, value));
  currentWidth.value = width;
  emit('resize', width);
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
  resize(drag.width + props.direction * (event.clientX - drag.x));
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
  const width = settledWidth();
  if (width === undefined) return;
  let next: number;
  if (event.key === 'Home') next = props.min;
  else if (event.key === 'End') next = props.max;
  else if (event.key === 'ArrowLeft') next = width - props.direction * 10;
  else if (event.key === 'ArrowRight') next = width + props.direction * 10;
  else return;
  event.preventDefault();
  resize(next);
}

watch(() => props.gestureKey, cancel, { flush: 'sync' });
onBeforeUnmount(cancel);
</script>

<template>
  <div
    ref="handle"
    v-tooltip="label"
    class="panel-resize-handle"
    :class="{ dragging }"
    role="separator"
    tabindex="0"
    aria-orientation="vertical"
    :aria-label="label"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-valuenow="width ?? currentWidth"
    @focus="currentWidth = target?.getBoundingClientRect().width"
    @keydown="keydown"
    @pointerdown="start"
    @pointermove="move"
    @pointerup="finish"
    @pointercancel="finish"
    @lostpointercapture="finish"
  />
</template>

<style scoped>
.panel-resize-handle {
  position: absolute;
  z-index: 6;
  top: 0;
  bottom: 0;
  width: 7px;
  cursor: col-resize;
  touch-action: none;
  user-select: none;
}
.panel-resize-handle::before {
  position: absolute;
  inset: 0 3px;
  background: transparent;
  content: '';
}
.panel-resize-handle:hover::before,
.panel-resize-handle:focus-visible::before,
.panel-resize-handle.dragging::before {
  background: var(--el-color-primary);
}
.panel-resize-handle.dragging::after {
  position: fixed;
  inset: 0;
  content: '';
  cursor: col-resize;
}
@media (max-width: 767px) {
  .panel-resize-handle {
    display: none;
  }
}
</style>
