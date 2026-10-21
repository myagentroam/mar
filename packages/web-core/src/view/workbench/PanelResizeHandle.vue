<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';

const props = defineProps<{
  target: HTMLElement | undefined;
  label: string;
  min: number;
  max: number;
  direction: 1 | -1;
}>();
const emit = defineEmits<{ resize: [width: number] }>();
const dragging = ref(false);
let drag: { pointerId: number; x: number; width: number } | undefined;

function resize(value: number): void {
  emit('resize', Math.max(props.min, Math.min(props.max, value)));
}

function start(event: PointerEvent): void {
  if (event.button !== 0 || drag !== undefined || props.target === undefined) return;
  event.preventDefault();
  const handle = event.currentTarget as HTMLElement;
  handle.setPointerCapture(event.pointerId);
  drag = {
    pointerId: event.pointerId,
    x: event.clientX,
    width: props.target.getBoundingClientRect().width
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

onBeforeUnmount(() => {
  drag = undefined;
});
</script>

<template>
  <div
    class="panel-resize-handle"
    :class="{ dragging }"
    role="separator"
    aria-orientation="vertical"
    :aria-label="label"
    :title="label"
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
