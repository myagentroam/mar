<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import ImagePreviewControls, { type ImagePreviewControlState } from './ImagePreviewControls.vue';
import {
  boundPreviewTransform,
  FITTED_IMAGE_TRANSFORM,
  fitPreviewImage,
  MAX_IMAGE_ZOOM,
  previewPanBounds,
  zoomPreviewTransform,
  type ImagePreviewPoint,
  type ImagePreviewTransform
} from '../../util/image-preview-geometry.js';

// Owns viewport geometry and gestures. Callers own the image source, decoding
// policy and surrounding preview lifecycle; each source is a keyed instance.
const props = withDefaults(
  defineProps<{
    src: string;
    alt: string;
    ready?: boolean;
    imageClass?: string;
    externalControls?: boolean;
  }>(),
  { ready: true }
);
const emit = defineEmits<{ load: [image: HTMLImageElement]; error: [] }>();

const center = { x: 0, y: 0 };
const viewport = shallowRef<HTMLElement>();
const viewportSize = shallowRef({ width: 0, height: 0 });
const naturalSize = shallowRef({ width: 0, height: 0 });
const transform = shallowRef<ImagePreviewTransform>(FITTED_IMAGE_TRANSFORM);
const pointers = new Map<number, ImagePreviewPoint>();
let pointerType: string | undefined;
const pointerCount = shallowRef(0);

const readyToShow = computed(() => props.ready && naturalSize.value.width > 0);
const fitted = computed(() => fitPreviewImage(naturalSize.value, viewportSize.value));
const panBounds = computed(() =>
  previewPanBounds(transform.value.scale, fitted.value, viewportSize.value)
);
const canPan = computed(() => panBounds.value.x > 0.5 || panBounds.value.y > 0.5);
const controls = computed<ImagePreviewControlState | undefined>(() =>
  readyToShow.value
    ? {
        canZoomOut: transform.value.scale > 1,
        canZoomIn: transform.value.scale < MAX_IMAGE_ZOOM,
        canPan: canPan.value,
        zoomBy: (factor) => zoomTo(transform.value.scale * factor),
        fit: () => {
          transform.value = FITTED_IMAGE_TRANSFORM;
        },
        canPanToward,
        panByViewportStep
      }
    : undefined
);
defineExpose({ controls });

const actionStyle = computed(() => {
  const { scale, y } = transform.value;
  // The action row starts below the viewport; move it up to the visible image edge.
  const imageBottomOffset = y + (fitted.value.height * scale - viewportSize.value.height) / 2;
  return { transform: `translateY(${Math.min(0, imageBottomOffset)}px)` };
});

function updateTransform(value: ImagePreviewTransform): void {
  transform.value = boundPreviewTransform(value, fitted.value, viewportSize.value);
}

watch(
  viewport,
  (element, _, onCleanup) => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      // A background file tab is hidden, not resized to a new working area.
      if (!width || !height) return;
      viewportSize.value = { width, height };
      updateTransform(transform.value);
    });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  },
  { flush: 'post' }
);

function imageLoaded(event: Event): void {
  const image = event.currentTarget as HTMLImageElement;
  naturalSize.value = { width: image.naturalWidth, height: image.naturalHeight };
  emit('load', image);
}

function relativeToCenter(point: ImagePreviewPoint, rect: DOMRect): ImagePreviewPoint {
  return { x: point.x - rect.left - rect.width / 2, y: point.y - rect.top - rect.height / 2 };
}

function zoomTo(scale: number, from = center, to = from): void {
  updateTransform(zoomPreviewTransform(transform.value, scale, from, to));
}

function panBy(x: number, y: number): void {
  const current = transform.value;
  updateTransform({ scale: current.scale, x: current.x + x, y: current.y + y });
}

function canPanToward(direction: ImagePreviewPoint): boolean {
  const bounds = panBounds.value;
  const { x, y } = transform.value;
  return direction.x ? bounds.x - x * direction.x > 0.5 : bounds.y - y * direction.y > 0.5;
}

function panByViewportStep(direction: ImagePreviewPoint): void {
  const { width, height } = viewportSize.value;
  panBy(direction.x * width * 0.75, direction.y * height * 0.75);
}

function onWheel(event: WheelEvent): void {
  if (!readyToShow.value || event.deltaY === 0 || event.ctrlKey || event.metaKey) return;
  const unit = event.deltaMode;
  const delta = event.deltaY * (unit === 1 ? 16 : unit === 2 ? viewportSize.value.height : 1);
  event.preventDefault();
  zoomTo(
    transform.value.scale * Math.exp(-delta * 0.002),
    relativeToCenter(
      { x: event.clientX, y: event.clientY },
      (event.currentTarget as HTMLElement).getBoundingClientRect()
    )
  );
}

function onPointerDown(event: PointerEvent): void {
  if (
    !readyToShow.value ||
    event.button !== 0 ||
    (event.pointerType !== 'touch' && (!canPan.value || pointers.size > 0)) ||
    (pointers.size > 0 && (pointerType !== 'touch' || pointers.size === 2))
  )
    return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  pointerType = event.pointerType;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  pointerCount.value = pointers.size;
}

function midpoint(first: ImagePreviewPoint, second: ImagePreviewPoint): ImagePreviewPoint {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function onPointerMove(event: PointerEvent): void {
  const previous = pointers.get(event.pointerId);
  if (!previous) return;
  const next = { x: event.clientX, y: event.clientY };
  pointers.set(event.pointerId, next);
  if (pointers.size === 1) {
    if (canPan.value) panBy(next.x - previous.x, next.y - previous.y);
    return;
  }
  const [first, second] = pointers.values();
  const other = first === next ? second! : first!;
  const before = Math.hypot(previous.x - other.x, previous.y - other.y);
  const after = Math.hypot(next.x - other.x, next.y - other.y);
  if (before < 1) return;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  zoomTo(
    transform.value.scale * (after / before),
    relativeToCenter(midpoint(previous, other), rect),
    relativeToCenter(midpoint(next, other), rect)
  );
}

function onPointerEnd(event: PointerEvent): void {
  if (pointers.delete(event.pointerId)) pointerCount.value = pointers.size;
}

function onKeyDown(event: KeyboardEvent): void {
  if (!canPan.value || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const movement = {
    ArrowLeft: [40, 0],
    ArrowRight: [-40, 0],
    ArrowUp: [0, 40],
    ArrowDown: [0, -40]
  } as const;
  const step = movement[event.key as keyof typeof movement];
  if (!step) return;
  event.preventDefault();
  panBy(step[0], step[1]);
}
</script>

<template>
  <div class="mar-image-preview">
    <div
      ref="viewport"
      class="mar-image-preview-viewport"
      :class="{ 'can-pan': canPan, 'is-panning': canPan && pointerCount === 1 }"
      :tabindex="canPan ? 0 : undefined"
      role="group"
      :aria-label="canPan ? translate('imageViewport.panWithArrows') : undefined"
      @wheel="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerEnd"
      @pointercancel="onPointerEnd"
      @lostpointercapture="onPointerEnd"
      @keydown="onKeyDown"
    >
      <img
        v-show="readyToShow"
        class="mar-image-preview-image"
        :class="imageClass"
        :src="src"
        :alt="alt"
        :style="{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`
        }"
        decoding="async"
        draggable="false"
        @load="imageLoaded"
        @error="emit('error')"
      />
    </div>
    <div
      v-if="controls && !externalControls"
      class="mar-image-preview-actions"
      :style="actionStyle"
    >
      <div v-if="$slots.actions" class="mar-image-preview-source-actions">
        <slot name="actions" />
      </div>
      <ImagePreviewControls :controls="controls" />
    </div>
  </div>
</template>

<style scoped>
.mar-image-preview {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.mar-image-preview-viewport {
  display: grid;
  flex: 1;
  min-height: 0;
  grid-template: minmax(0, 1fr) / minmax(0, 1fr);
  place-items: center;
  overflow: hidden;
  overscroll-behavior: contain;
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
}

.mar-image-preview-viewport.can-pan {
  cursor: grab;
}

.mar-image-preview-viewport.is-panning {
  cursor: grabbing;
}

.mar-image-preview-viewport:focus-visible {
  outline-offset: -2px;
}

.mar-image-preview-image {
  display: block;
  max-width: 100%;
  max-height: 100%;
}

.mar-image-preview-actions {
  --image-action-gap: 0.375rem;
  position: relative;
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  align-self: center;
  justify-content: center;
  gap: var(--image-action-gap);
  max-inline-size: 100%;
  padding-block-start: var(--image-action-gap);
}

.mar-image-preview-source-actions {
  padding-inline-end: var(--image-action-gap);
  border-inline-end: 1px solid var(--mar-border-subtle);
}

.mar-image-preview-actions :deep(.image-preview-control) {
  border-radius: var(--mar-radius-control);
}

@media (max-width: 767px) {
  .mar-image-preview-actions :deep(.mar-ui-button) {
    min-block-size: 36px;
    min-inline-size: 36px;
  }
}
</style>
