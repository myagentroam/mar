<script setup lang="ts">
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { onBeforeUnmount, ref } from 'vue';

const props = defineProps<{
  readonly overlay: boolean;
  readonly label: string;
}>();
const emit = defineEmits<{ focus: []; close: [] }>();
const dialog = ref<InstanceType<typeof MarDialog>>();
const closing = ref(false);
let finishClose: ((closed: boolean) => void) | undefined;

function focusContent(): void {
  if (dialog.value?.panel === document.activeElement) emit('focus');
}

function requestClose(): void {
  // Backdrop and native cancel (including mobile close requests) ask the
  // owner to close its tabs. Only close() starts the leave transition.
  if (!closing.value) emit('close');
}

function close(): Promise<boolean> {
  if (!dialog.value) return Promise.resolve(false);
  return new Promise((resolve) => {
    finishClose = resolve;
    closing.value = true;
  });
}

function cancelClose(): void {
  const finish = finishClose;
  finishClose = undefined;
  closing.value = false;
  finish?.(false);
}

function closed(): void {
  finishClose?.(true);
  finishClose = undefined;
}

onBeforeUnmount(() => finishClose?.(false));
defineExpose({ close, cancelClose });
</script>

<template>
  <MarDialog
    v-if="props.overlay"
    ref="dialog"
    :model-value="props.overlay && !closing"
    :title="props.label"
    :aria-label="props.label"
    :show-close="false"
    :close-on-click-modal="true"
    :before-close="requestClose"
    append-to-body
    align-center
    destroy-on-close
    class="file-preview-surface"
    @opened="focusContent"
    @closed="closed"
  >
    <template #header />
    <slot />
  </MarDialog>
  <slot v-else />
</template>

<style scoped>
:global(.file-preview-surface.mar-ui-dialog) {
  --preview-left: max(16px, env(safe-area-inset-left, 0px));
  --preview-right: max(16px, env(safe-area-inset-right, 0px));
  --preview-top: max(16px, env(safe-area-inset-top, 0px));
  --preview-bottom: max(16px, env(safe-area-inset-bottom, 0px));
  display: flex;
  width: min(1440px, calc(100vw - var(--preview-left) - var(--preview-right)));
  height: min(960px, calc(100dvh - var(--preview-top) - var(--preview-bottom)));
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  box-sizing: border-box;
  margin: auto;
  left: calc((var(--preview-left) - var(--preview-right)) / 2);
  top: calc((var(--preview-top) - var(--preview-bottom)) / 2);
  overflow: hidden;
  padding: 0;
  background: var(--mar-control-bg-color-overlay);
  color: var(--mar-text-primary);
}

:global(.file-preview-surface.mar-ui-dialog > .mar-ui-dialog__header) {
  display: none;
}

:global(.file-preview-surface.mar-ui-dialog > .mar-ui-dialog__body) {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  padding: 0;
}

@media (max-width: 767px) {
  :global(.file-preview-surface.mar-ui-dialog) {
    width: 100%;
    height: 100dvh;
    margin: 0;
    left: 0;
    top: 0;
    border: 0;
    border-radius: 0;
    padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px)
      env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  }
}
</style>
