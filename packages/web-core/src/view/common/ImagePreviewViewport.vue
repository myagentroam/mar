<script setup lang="ts">
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarDropdown, MarDropdownItem, MarDropdownMenu } from '@myagentroam/mar-ui/dropdown';
import { marIcon } from '@myagentroam/mar-ui/icons';
import { computed, shallowRef, watch } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
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
  defineProps<{ src: string; alt: string; ready?: boolean; imageClass?: string }>(),
  { ready: true }
);
const emit = defineEmits<{ load: [image: HTMLImageElement]; error: [] }>();

const center = { x: 0, y: 0 };
const panDirections = [
  { key: 'up', icon: 'chevron-up', x: 0, y: 1 },
  { key: 'down', icon: 'chevron-down', x: 0, y: -1 },
  { key: 'left', icon: 'chevron-left', x: 1, y: 0 },
  { key: 'right', icon: 'chevron-right', x: -1, y: 0 }
] as const;
const viewport = shallowRef<HTMLElement>();
const actions = shallowRef<HTMLElement>();
const actionWidth = shallowRef(0);
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
const actionStyle = computed(() => {
  const { width, height } = viewportSize.value;
  // At fit, keep the original action just below the image. While zoomed it
  // stays in its own row so it cannot follow the pan or cover image content.
  const x = Math.max(0, Math.min((width - fitted.value.width) / 2, width - actionWidth.value));
  const y = transform.value.scale === 1 ? -(height - fitted.value.height) / 2 : 0;
  return { insetInlineStart: `${x}px`, transform: `translateY(${y}px)` };
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

watch(
  actions,
  (element, _, onCleanup) => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      actionWidth.value = entry!.contentRect.width;
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
    <div class="decoded-preview-media">
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
        v-if="readyToShow && $slots.actions"
        ref="actions"
        class="decoded-preview-actions"
        :style="actionStyle"
      >
        <slot name="actions" />
      </div>
    </div>
    <div v-if="readyToShow" class="mar-image-preview-controls">
      <MarButton
        v-tooltip="translate('imageViewport.zoomOut')"
        :aria-label="translate('imageViewport.zoomOut')"
        :icon="marIcon('zoom-out')"
        :disabled="transform.scale === 1"
        circle
        @click="zoomTo(transform.scale / 1.5)"
      />
      <MarButton
        v-tooltip="translate('imageViewport.fit')"
        :aria-label="translate('imageViewport.fit')"
        :icon="marIcon('fit')"
        :disabled="transform.scale === 1"
        circle
        @click="transform = FITTED_IMAGE_TRANSFORM"
      />
      <MarButton
        v-tooltip="translate('imageViewport.zoomIn')"
        :aria-label="translate('imageViewport.zoomIn')"
        :icon="marIcon('zoom-in')"
        :disabled="transform.scale === MAX_IMAGE_ZOOM"
        circle
        @click="zoomTo(transform.scale * 1.5)"
      />
      <MarDropdown placement="top">
        <MarButton
          v-tooltip="translate('imageViewport.pan.label')"
          :aria-label="translate('imageViewport.pan.label')"
          :icon="marIcon('more')"
          :disabled="!canPan"
          circle
        />
        <template #dropdown>
          <MarDropdownMenu :aria-label="translate('imageViewport.pan.label')">
            <MarDropdownItem
              v-for="direction in panDirections"
              :key="direction.key"
              :icon="direction.icon"
              :disabled="!canPanToward(direction)"
              @click="panByViewportStep(direction)"
            >
              {{ translate(`imageViewport.pan.${direction.key}`) }}
            </MarDropdownItem>
          </MarDropdownMenu>
        </template>
      </MarDropdown>
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

.decoded-preview-media {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
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
  outline: 2px solid var(--mar-control-focus);
  outline-offset: -2px;
}

.mar-image-preview-image {
  display: block;
  max-width: 100%;
  max-height: 100%;
}

.decoded-preview-actions {
  position: relative;
  width: max-content;
  max-width: 100%;
  padding-top: 6px;
}

.mar-image-preview-controls {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.375rem;
  padding: 0.375rem 0;
}
</style>
