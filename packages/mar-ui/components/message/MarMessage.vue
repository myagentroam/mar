<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import { MarIcon } from '../../icons/index.js';
import { useMarUiLocale } from '../../locale/index.js';
import { MarButton } from '../button/index.js';

/** Presents one transient result and owns its remaining display time. */
const props = defineProps<{
  message: string;
  type: 'success' | 'info' | 'warning' | 'error';
  duration: number;
}>();
const emit = defineEmits<{ close: [] }>();
const locale = useMarUiLocale();
let timer: ReturnType<typeof setTimeout> | undefined;
let remaining = props.duration;
let started = 0;
let hovered: boolean = false;
let focused: boolean = false;

function pause() {
  if (timer === undefined) return;
  clearTimeout(timer);
  timer = undefined;
  remaining -= performance.now() - started;
}

function track(kind: 'hover' | 'focus', active: boolean) {
  if (kind === 'hover') hovered = active;
  else focused = active;
  if (active) pause();
  else resume();
}

function resume() {
  if (hovered || focused || timer !== undefined) return;
  started = performance.now();
  timer = setTimeout(() => emit('close'), Math.max(remaining, 0));
}

onMounted(resume);
onBeforeUnmount(pause);
</script>

<template>
  <section
    class="mar-ui-message mar-message"
    :class="'mar-message--' + type"
    :data-variant="type"
    :role="type === 'error' || type === 'warning' ? 'alert' : 'status'"
    @pointerenter="track('hover', true)"
    @pointerleave="track('hover', false)"
    @focusin="track('focus', true)"
    @focusout="track('focus', false)"
  >
    <MarIcon :name="type" class="mar-ui-message__icon" />
    <div class="mar-ui-message__text mar-message-text">{{ message }}</div>
    <MarButton
      class="mar-ui-message__close mar-message-close mar-icon-action"
      text
      icon="close"
      :aria-label="locale.close"
      @click="emit('close')"
    />
  </section>
</template>

<style scoped>
.mar-ui-message {
  --mar-ui-message-icon-color: var(--mar-ui-message-info-color, var(--mar-ui-text-secondary));
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 8px;
  align-items: start;
  inline-size: fit-content;
  max-inline-size: min(520px, 100%);
  box-sizing: border-box;
  padding: 8px 12px;
  border: 1px solid var(--mar-ui-message-border);
  border-radius: var(--mar-ui-radius-control);
  color: var(--mar-ui-text-primary);
  background: var(--mar-ui-message-surface, var(--mar-ui-bg-panel));
  box-shadow: var(--mar-ui-overlay-shadow);
  font-size: var(--mar-ui-font-size-body);
  line-height: 1.5;
  pointer-events: auto;
}
.mar-ui-message[data-variant='success'] {
  --mar-ui-message-icon-color: var(--mar-ui-message-success-color);
}
.mar-ui-message[data-variant='warning'] {
  --mar-ui-message-icon-color: var(--mar-ui-message-warning-color);
}
.mar-ui-message[data-variant='error'] {
  --mar-ui-message-icon-color: var(--mar-ui-message-error-color);
}
.mar-ui-message__icon {
  color: var(--mar-ui-message-icon-color);
  inline-size: 1em;
  block-size: 1.5em;
}
.mar-ui-message__text {
  max-block-size: min(38dvh, 18rem);
  overflow: auto;
  overscroll-behavior: contain;
  overflow-wrap: anywhere;
  white-space: pre-line;
  text-align: start;
  user-select: text;
}
.mar-ui-message__close {
  align-self: start;
  min-inline-size: 1.5em;
  inline-size: 1.5em;
  min-block-size: 1.5em;
  block-size: 1.5em;
  padding: 0;
}
</style>
