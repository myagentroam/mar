import { computed, ref } from 'vue';

const MINIMUM_SCALE = 0.25;
const MAXIMUM_SCALE = 2;
const DEFAULT_SCALE = 1;

interface TouchPoint {
  readonly x: number;
  readonly y: number;
}

export function createMobilePreviewPinchZoom() {
  const scale = ref(DEFAULT_SCALE);
  const pointers = new Map<number, TouchPoint>();
  let initialDistance = 0;
  let initialScale = DEFAULT_SCALE;

  function pointerDown(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return;
    pointers.set(event.pointerId, point(event));
    if (pointers.size === 2) beginPinch();
  }

  function pointerMove(event: PointerEvent): void {
    if (event.pointerType !== 'touch' || !pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, point(event));
    const distance = pointerDistance();
    if (distance === undefined) return;
    if (initialDistance === 0) {
      initialDistance = distance;
      initialScale = scale.value;
      return;
    }
    if (event.cancelable) event.preventDefault();
    scale.value = clamp(initialScale * (distance / initialDistance));
  }

  function pointerEnd(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return;
    pointers.delete(event.pointerId);
    if (pointers.size < 2) {
      initialDistance = 0;
      return;
    }
    beginPinch();
  }

  function beginPinch(): void {
    const distance = pointerDistance();
    if (distance === undefined) return;
    initialDistance = distance;
    initialScale = scale.value;
  }

  function pointerDistance(): number | undefined {
    const [first, second] = [...pointers.values()];
    if (first === undefined || second === undefined) return undefined;
    return Math.hypot(second.x - first.x, second.y - first.y);
  }

  return {
    style: computed(() => ({ '--mar-preview-zoom': String(scale.value) })),
    pointerDown,
    pointerMove,
    pointerEnd
  };
}

function point(event: PointerEvent): TouchPoint {
  return { x: event.clientX, y: event.clientY };
}

function clamp(value: number): number {
  return Math.max(MINIMUM_SCALE, Math.min(MAXIMUM_SCALE, value));
}
