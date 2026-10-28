<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import MarIcon from '../common/MarIcon.vue';

const props = defineProps<{
  disabled?: boolean;
  submitting?: boolean;
  mobileViewport: boolean;
  canSteer: boolean;
  contextKey: string | undefined;
  label: string;
}>();
const emit = defineEmits<{ send: []; steer: [] }>();
const holding = ref(false);
const upward = ref(false);
const cancelling = ref(false);
const gestureEnabled = computed(() => props.mobileViewport && !props.disabled && !props.submitting);
let holdTimer: ReturnType<typeof setTimeout> | undefined;
let pointerId: number | undefined;
let pointerTarget: HTMLButtonElement | undefined;
let startY = 0;
let suppressClick = false;

function resetGesture(): void {
  if (holdTimer !== undefined) clearTimeout(holdTimer);
  holdTimer = undefined;
  const previousId = pointerId;
  const previousTarget = pointerTarget;
  pointerId = undefined;
  pointerTarget = undefined;
  holding.value = false;
  upward.value = false;
  cancelling.value = false;
  previousTarget?.ownerDocument.removeEventListener('visibilitychange', onVisibilityChange);
  previousTarget?.ownerDocument.defaultView?.removeEventListener('blur', cancelGesture);
  if (previousId !== undefined && previousTarget?.hasPointerCapture(previousId))
    previousTarget.releasePointerCapture(previousId);
}

function cancelGesture(): void {
  if (pointerId !== undefined) suppressClick = true;
  resetGesture();
}

function onVisibilityChange(): void {
  if (pointerTarget?.ownerDocument.visibilityState === 'hidden') cancelGesture();
}

function updateGesturePosition(event: PointerEvent): void {
  upward.value = startY - event.clientY >= 8;
  // Both Composer entry points place this control inside their native form.
  cancelling.value = event.clientY < pointerTarget!.form!.getBoundingClientRect().top;
}

function onPointerDown(event: PointerEvent): void {
  if (pointerId !== undefined) {
    cancelGesture();
    return;
  }
  suppressClick = false;
  if (
    !props.mobileViewport ||
    props.disabled ||
    props.submitting ||
    event.pointerType !== 'touch' ||
    !event.isPrimary ||
    event.button !== 0
  )
    return;
  event.preventDefault();
  pointerId = event.pointerId;
  pointerTarget = event.currentTarget as HTMLButtonElement;
  startY = event.clientY;
  pointerTarget.setPointerCapture(pointerId);
  pointerTarget.ownerDocument.addEventListener('visibilitychange', onVisibilityChange);
  pointerTarget.ownerDocument.defaultView?.addEventListener('blur', cancelGesture);
  trackTouchClick(pointerTarget.ownerDocument, pointerId);
  if (gestureEnabled.value)
    holdTimer = setTimeout(() => {
      holdTimer = undefined;
      holding.value = true;
    }, 200);
}

function onTouchStart(event: TouchEvent): void {
  // Keep the editor focused instead of letting touch focus dismiss its keyboard.
  // Pointerup submits the tracked touch, so it does not depend on a native click.
  if (pointerId !== undefined) event.preventDefault();
}

function onPointerMove(event: PointerEvent): void {
  if (event.pointerId !== pointerId) return;
  updateGesturePosition(event);
}

function trackTouchClick(document: Document, id: number): void {
  // The button can disappear before release or after sending. Track the original
  // touch through its compatibility click so it cannot fall through to Stop.
  const capture = { capture: true };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    if (timeout !== undefined) clearTimeout(timeout);
    document.removeEventListener('click', onClick, capture);
    document.removeEventListener('pointerdown', clear, capture);
    document.removeEventListener('pointerup', onRelease, capture);
    document.removeEventListener('pointercancel', clear, capture);
  };
  const onRelease = (event: PointerEvent): void => {
    if (event.pointerId !== id) return;
    document.removeEventListener('pointerup', onRelease, capture);
    timeout = setTimeout(clear, 500);
  };
  const onClick = (event: MouseEvent): void => {
    if (event.detail === 0) return;
    if (suppressClick) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    clear();
  };
  document.addEventListener('click', onClick, capture);
  document.addEventListener('pointerdown', clear, capture);
  document.addEventListener('pointerup', onRelease, capture);
  document.addEventListener('pointercancel', clear, capture);
}

function onPointerUp(event: PointerEvent): void {
  if (event.pointerId !== pointerId) return;
  updateGesturePosition(event);
  const shouldSteer = upward.value && props.canSteer;
  const cancelled = cancelling.value;
  suppressClick = true;
  event.preventDefault();
  resetGesture();
  if (cancelled || props.disabled || props.submitting) return;
  if (shouldSteer) emit('steer');
  else emit('send');
}

function onClick(event: MouseEvent): void {
  // A completed or cancelled touch must not fall through to ordinary sending.
  if (suppressClick && event.detail !== 0) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (!props.disabled && !props.submitting) emit('send');
}

watch(
  () => [props.disabled, props.submitting, props.mobileViewport, props.canSteer, props.contextKey],
  cancelGesture,
  { flush: 'sync' }
);
onBeforeUnmount(cancelGesture);
</script>

<template>
  <button
    class="composer-send-control"
    :class="{ 'has-steer-gesture': gestureEnabled }"
    type="button"
    :disabled="disabled || submitting"
    :aria-label="label"
    :aria-busy="submitting || undefined"
    :aria-description="
      gestureEnabled
        ? translate(canSteer ? 'composerSend.holdHint' : 'composerSend.holdSendHint')
        : undefined
    "
    @pointerdown="onPointerDown"
    @touchstart="onTouchStart"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="cancelGesture"
    @lostpointercapture="cancelGesture"
    @blur="cancelGesture"
    @contextmenu="gestureEnabled && $event.preventDefault()"
    @click="onClick"
  >
    <MarIcon v-if="submitting" name="loading-action" aria-hidden="true" />
    <MarIcon v-else name="send" aria-hidden="true" />
    <span v-if="holding || upward || cancelling" class="composer-steer-hint" role="status">
      {{
        translate(
          cancelling
            ? 'composerSend.releaseToCancel'
            : canSteer
              ? upward
                ? 'composerSend.releaseToSteer'
                : 'composerSend.slideToSteer'
              : 'composerSend.releaseToSend'
        )
      }}
    </span>
  </button>
</template>

<style scoped>
.composer-send-control {
  position: relative;
}

.has-steer-gesture {
  touch-action: none;
  user-select: none;
  -webkit-touch-callout: none;
}

.composer-steer-hint {
  position: absolute;
  z-index: 2;
  right: 0;
  bottom: calc(100% + 0.5rem);
  width: max-content;
  max-width: min(17rem, calc(100vw - 2rem));
  padding: 0.375rem 0.625rem;
  border: 1px solid var(--mar-border-default);
  border-radius: var(--mar-radius-control);
  background: var(--mar-bg-panel);
  box-shadow: 0 4px 12px var(--mar-shadow-medium);
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-meta);
  font-weight: 400;
  line-height: 1.4;
  text-align: start;
  pointer-events: none;
}
</style>
