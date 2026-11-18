<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import MarIcon from '../common/MarIcon.vue';

// Owns the mobile send gesture and its compatibility-click guard.
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
let awaitingTouchStart = false;
let touchId: number | undefined;
let gestureTarget: HTMLButtonElement | undefined;
let startY = 0;
let suppressClick = false;
let expireDetachedTouch: (() => void) | undefined;

function resetGesture(): void {
  if (holdTimer !== undefined) clearTimeout(holdTimer);
  holdTimer = undefined;
  const previousId = pointerId;
  const previousTarget = gestureTarget;
  pointerId = undefined;
  awaitingTouchStart = false;
  touchId = undefined;
  gestureTarget = undefined;
  holding.value = false;
  upward.value = false;
  cancelling.value = false;
  previousTarget?.ownerDocument.removeEventListener('visibilitychange', onVisibilityChange);
  previousTarget?.ownerDocument.defaultView?.removeEventListener('blur', cancelGesture);
  if (previousId !== undefined && previousTarget?.hasPointerCapture(previousId))
    previousTarget.releasePointerCapture(previousId);
}

function cancelGesture(): void {
  if (gestureTarget !== undefined) suppressClick = true;
  resetGesture();
}

function onVisibilityChange(): void {
  if (gestureTarget?.ownerDocument.visibilityState === 'hidden') cancelGesture();
}

function updateGesturePosition(clientY: number): void {
  upward.value = startY - clientY >= 8;
  // Both Composer entry points place this control inside their native form.
  cancelling.value = clientY < gestureTarget!.form!.getBoundingClientRect().top;
}

function onPointerDown(event: PointerEvent): void {
  if (!event.isPrimary || event.button !== 0) return;
  if (touchId !== undefined) {
    // A touch-owned gesture stays with Touch Events even if Pointer Events arrive later.
    if (event.pointerType === 'touch') return;
    cancelGesture();
  }
  suppressClick = false;
  if (!gestureEnabled.value || event.pointerType !== 'touch') return;
  event.preventDefault();
  const button = event.currentTarget as HTMLButtonElement;
  pointerId = event.pointerId;
  awaitingTouchStart = true;
  button.setPointerCapture(pointerId);
  trackTouchRelease(button, pointerId);
  startGesture(button, event.clientY);
}

function startGesture(button: HTMLButtonElement, clientY: number): void {
  gestureTarget = button;
  startY = clientY;
  button.ownerDocument.addEventListener('visibilitychange', onVisibilityChange);
  button.ownerDocument.defaultView?.addEventListener('blur', cancelGesture);
  holdTimer = setTimeout(() => {
    holdTimer = undefined;
    holding.value = true;
  }, 200);
}

function onTouchStart(event: TouchEvent): void {
  // Keep the editor focused instead of letting touch focus dismiss its keyboard.
  if (awaitingTouchStart) {
    awaitingTouchStart = false;
    event.preventDefault();
    return;
  }
  // Track a single native touch directly when no usable pointerdown reached this button.
  if (!gestureEnabled.value || event.touches.length !== 1) return;
  const touch = event.changedTouches[0];
  if (!touch) return;
  cancelGesture();
  expireDetachedTouch?.();
  suppressClick = false;
  // Only take over when the browser will suppress the compatibility click.
  if (!event.cancelable) return;
  event.preventDefault();
  touchId = touch.identifier;
  startGesture(event.currentTarget as HTMLButtonElement, touch.clientY);
}

function changedTrackedTouch(event: TouchEvent): Touch | undefined {
  if (touchId !== undefined)
    return Array.from(event.changedTouches).find((touch) => touch.identifier === touchId);
}

function onTouchMove(event: TouchEvent): void {
  const touch = changedTrackedTouch(event);
  if (touch) updateGesturePosition(touch.clientY);
}

function onTouchEnd(event: TouchEvent): void {
  const touch = changedTrackedTouch(event);
  if (touch) finishGesture(touch.clientY, event);
}

function onTouchCancel(event: TouchEvent): void {
  if (changedTrackedTouch(event)) cancelGesture();
}

function onPointerMove(event: PointerEvent): void {
  if (event.pointerId !== pointerId) return;
  updateGesturePosition(event.clientY);
}

function onLostPointerCapture(event: PointerEvent): void {
  if (event.pointerId === pointerId && event.target === gestureTarget) cancelGesture();
}

function trackTouchRelease(button: HTMLButtonElement, id: number): void {
  // The button can disappear before release or after sending. Track the original
  // touch through its compatibility click so it cannot fall through to Stop.
  const document = button.ownerDocument;
  const capture = { capture: true };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    if (timeout !== undefined) clearTimeout(timeout);
    expireDetachedTouch = undefined;
    document.removeEventListener('click', onClick, capture);
    document.removeEventListener('pointerdown', onNextPress, capture);
    document.removeEventListener('pointerup', onRelease, capture);
    document.removeEventListener('pointercancel', onCancel, capture);
  };
  const scheduleExpiry = (): void => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = setTimeout(clear, 500);
  };
  expireDetachedTouch = () => {
    // A detached touch may still release and click, or never finish at all.
    if (timeout === undefined) scheduleExpiry();
  };
  const onNextPress = (event: PointerEvent): void => {
    if (!event.isPrimary) return;
    // Retire an interrupted touch before the next press reaches its target.
    if (pointerId === id) cancelGesture();
    clear();
  };
  const onRelease = (event: PointerEvent): void => {
    if (event.pointerId !== id) return;
    document.removeEventListener('pointerup', onRelease, capture);
    scheduleExpiry();
    if (pointerId !== id) return;
    // A release retargeted outside the button ends the hold but must not send.
    if (event.composedPath().includes(button)) finishGesture(event.clientY, event);
    else cancelGesture();
  };
  const onCancel = (event: PointerEvent): void => {
    if (event.pointerId !== id) return;
    if (pointerId === id) cancelGesture();
    clear();
  };
  const onClick = (event: MouseEvent): void => {
    if (event.detail === 0) return;
    if ('pointerId' in event ? event.pointerId !== id : !suppressClick) return;
    // A click may arrive even when the release did not reach this listener.
    if (pointerId === id) cancelGesture();
    event.preventDefault();
    event.stopImmediatePropagation();
    clear();
  };
  document.addEventListener('click', onClick, capture);
  document.addEventListener('pointerdown', onNextPress, capture);
  document.addEventListener('pointerup', onRelease, capture);
  document.addEventListener('pointercancel', onCancel, capture);
}

function finishGesture(clientY: number, event: Event): void {
  updateGesturePosition(clientY);
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
onBeforeUnmount(() => {
  cancelGesture();
  expireDetachedTouch?.();
});
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
    @touchmove.passive="onTouchMove"
    @touchend="onTouchEnd"
    @touchcancel="onTouchCancel"
    @pointermove="onPointerMove"
    @lostpointercapture="onLostPointerCapture"
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
