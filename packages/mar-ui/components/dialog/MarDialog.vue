<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, useTemplateRef, watch } from 'vue';
import { useMarUiLocale } from '../../locale/index.js';
import { MarButton } from '../button/index.js';

/** Owns one modal surface. The caller owns the flow, its guard and its business state. */
defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title: string;
    ariaLabel?: string;
    ariaDescribedby?: string;
    width?: string | number;
    appendToBody?: boolean;
    alignCenter?: boolean;
    fullscreen?: boolean;
    showClose?: boolean;
    closeOnClickModal?: boolean;
    closeOnPressEscape?: boolean;
    destroyOnClose?: boolean;
    beforeClose?: (done: (cancel?: boolean) => void) => void | Promise<void>;
  }>(),
  { showClose: true, closeOnClickModal: true, closeOnPressEscape: true }
);
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  close: [];
  closed: [];
  opened: [];
  focus: [];
  'close-auto-focus': [];
}>();
defineSlots<{
  header?: (props: { close: () => void; titleId: string; titleClass: string }) => unknown;
  default?: () => unknown;
  footer?: () => unknown;
}>();

const dialog = useTemplateRef<HTMLDialogElement>('dialog');
const panel = useTemplateRef<HTMLElement>('panel');
const titleId = useId();
const locale = useMarUiLocale();
const panelWidth = computed(() =>
  typeof props.width === 'number' ? `${props.width}px` : props.width
);
let invoker: HTMLElement | undefined;
let pointerFocus = false;
let pressedBackdrop = false;
let generation = 0;
let pending = false;
let disposed = false;
const leaving = ref(false);
const retained = ref(false);
let motion = 0;
let forcedClose: { owner: HTMLDialogElement; focused: Element | null } | undefined;

function afterMotion(element: HTMLDialogElement, done: () => void) {
  const animations = element.getAnimations();
  if (!animations.length) return done();
  void Promise.allSettled(animations.map(({ finished }) => finished)).then(done);
}

function restoreFocus(owner: HTMLDialogElement) {
  const target = invoker;
  const quiet = pointerFocus;
  invoker = undefined;
  if (disposed && !target) return;
  void nextTick(() => {
    const doc = owner.ownerDocument;
    const active = doc.activeElement;
    if (active !== doc.body && active !== target && !owner.contains(active)) return;
    if (target?.isConnected) {
      target.focus({ preventScroll: true, ...(quiet ? { focusVisible: false } : {}) });
      if (doc.activeElement === target) return;
    }
    if (doc.activeElement !== doc.body) return;
    // Older modals can still match :modal but are inert under the current layer.
    for (const candidate of Array.from(doc.querySelectorAll('dialog:modal')).reverse()) {
      const fallback = candidate.querySelector<HTMLElement>(':scope > [data-mar-dialog-panel]');
      fallback?.focus({ preventScroll: true });
      if (doc.activeElement !== doc.body) return;
    }
    const fallback = doc.querySelector<HTMLElement>('main');
    if (fallback && !fallback.hasAttribute('tabindex')) fallback.setAttribute('tabindex', '-1');
    fallback?.focus({ preventScroll: true });
  });
}

async function finish(fromUser: boolean, alreadyClosed = false) {
  const owner = dialog.value;
  if (!owner || (!owner.open && !alreadyClosed) || leaving.value) return;
  generation += 1;
  pending = false;
  const epoch = ++motion;
  leaving.value = true;
  emit('close');
  await nextTick();
  if (owner.open) await new Promise<void>((resolve) => afterMotion(owner, resolve));
  if (disposed || epoch !== motion) return;
  owner.close();
  leaving.value = false;
  emit('closed');
  if (fromUser) emit('update:modelValue', false);
  emit('close-auto-focus');
  restoreFocus(owner);
  // Owners finish the confirmed close before the slot state is destroyed.
  void nextTick(() => {
    if (epoch === motion && !owner.open) retained.value = false;
  });
}

function handleClose(): void {
  if (!dialog.value?.open || pending || leaving.value) return;
  if (!props.beforeClose) {
    void finish(true);
    return;
  }
  const request = ++generation;
  pending = true;
  const done = (cancel?: boolean) => {
    if (request !== generation || disposed) return;
    generation += 1;
    pending = false;
    if (!cancel) void finish(true);
  };
  // A synchronous guard may deliberately withhold done. An async guard settles on return,
  // unless it has already called done. Older callbacks never close a newer opening.
  try {
    const result = props.beforeClose(done);
    if (result)
      void result.then(
        () => done(true),
        () => done(true)
      );
    else pending = false;
  } catch (error) {
    done(true);
    throw error;
  }
}

function onCancel(event: Event) {
  if (!event.cancelable) {
    // Some platform close requests cannot be prevented. Wait for the native
    // close before asking the owner, so a guard never runs on a closed dialog.
    const owner = dialog.value;
    if (owner) forcedClose = { owner, focused: owner.ownerDocument.activeElement };
    return;
  }
  event.preventDefault();
  if (props.closeOnPressEscape) handleClose();
}

function onNativeClose(event: Event) {
  const recovery = forcedClose;
  if (!recovery || event.target !== recovery.owner) return;
  forcedClose = undefined;
  const { owner, focused } = recovery;
  if (dialog.value !== owner) return;
  if (disposed || owner.open || leaving.value) return;
  if (!props.modelValue) {
    void finish(false, true);
    return;
  }
  // The model still owns the modal. Restore it before running its normal
  // close policy, which may refuse or open an unsaved-changes confirmation.
  owner.showModal();
  if (focused instanceof HTMLElement && owner.contains(focused)) {
    focused.focus({ preventScroll: true });
  }
  if (props.closeOnPressEscape) handleClose();
}

function onMouseDown(event: MouseEvent) {
  pressedBackdrop = event.target === dialog.value;
}

function onMouseUp(event: MouseEvent) {
  // A crossing gesture can dispatch click to its common ancestor, the dialog.
  pressedBackdrop &&= event.target === dialog.value;
}

function onBackdrop(event: MouseEvent) {
  const outside = event.target === dialog.value && pressedBackdrop;
  pressedBackdrop = false;
  if (outside && props.closeOnClickModal) handleClose();
}

watch(
  [dialog, () => props.modelValue],
  ([owner, open]) => {
    if (!owner) return;
    if (!open) {
      void finish(false);
      return;
    }
    if (owner.open) {
      if (leaving.value) {
        ++motion;
        leaving.value = false;
      }
      return;
    }
    retained.value = true;
    const active = owner.ownerDocument.activeElement;
    invoker =
      active instanceof HTMLElement && active !== owner.ownerDocument.body ? active : undefined;
    pointerFocus = invoker !== undefined && !invoker.matches(':focus-visible');
    const content = panel.value;
    // The panel is the default focus target, not a replacement for a field's autofocus.
    if (content) content.toggleAttribute('autofocus', !content.querySelector('[autofocus]'));
    // The native dialog would otherwise focus the invoker before the owner's close hook runs.
    invoker?.blur();
    owner.showModal();
    emit('focus');
    void nextTick(() =>
      afterMotion(owner, () => {
        if (owner.open && !leaving.value && !disposed) emit('opened');
      })
    );
  },
  { flush: 'post' }
);

onBeforeUnmount(() => {
  disposed = true;
  ++motion;
  generation += 1;
  const owner = dialog.value;
  if (!owner?.open) return;
  owner.close();
  emit('close-auto-focus');
  restoreFocus(owner);
});

defineExpose({ handleClose, panel });
</script>

<template>
  <Teleport to="body" :disabled="!appendToBody">
    <dialog
      ref="dialog"
      class="mar-ui-dialog-overlay"
      :class="{ 'is-align-center': alignCenter && !fullscreen }"
      role="dialog"
      aria-modal="true"
      :data-closing="leaving || undefined"
      :aria-label="ariaLabel"
      :aria-labelledby="ariaLabel ? undefined : titleId"
      :aria-describedby="ariaDescribedby"
      @cancel="onCancel"
      @close="onNativeClose"
      @mousedown="onMouseDown"
      @mouseup="onMouseUp"
      @click="onBackdrop"
    >
      <section
        v-if="modelValue || retained || !destroyOnClose"
        v-bind="$attrs"
        ref="panel"
        tabindex="-1"
        data-mar-dialog-panel
        class="mar-ui-dialog"
        :class="{ 'is-fullscreen': fullscreen }"
        :style="{ '--mar-ui-dialog-width': panelWidth }"
      >
        <header class="mar-ui-dialog__header">
          <slot
            name="header"
            :close="handleClose"
            :title-id="titleId"
            title-class="mar-ui-dialog__title"
          >
            <h2 :id="titleId" class="mar-ui-dialog__title">{{ title }}</h2>
          </slot>
          <MarButton
            v-if="showClose"
            class="mar-ui-dialog__close mar-icon-action"
            text
            icon="close"
            :aria-label="locale.closeDialog"
            @click="handleClose"
          />
        </header>
        <div class="mar-ui-dialog__body"><slot /></div>
        <footer v-if="$slots.footer" class="mar-ui-dialog__footer"><slot name="footer" /></footer>
      </section>
    </dialog>
  </Teleport>
</template>

<style scoped>
:global(html:has(.mar-ui-dialog-overlay[open])) {
  overflow: hidden;
}
.mar-ui-dialog-overlay {
  position: fixed;
  inset: 0;
  inline-size: 100%;
  block-size: 100%;
  max-inline-size: none;
  max-block-size: none;
  margin: 0;
  padding: 0;
  border: 0;
  overflow: hidden;
  background: transparent;
  color: inherit;
}
.mar-ui-dialog-overlay[open] {
  display: flex;
  justify-content: center;
  align-items: flex-start;
}
@media (prefers-reduced-motion: no-preference) {
  .mar-ui-dialog-overlay[open]:not([data-closing]),
  .mar-ui-dialog-overlay[open]:not([data-closing])::backdrop {
    animation: mar-dialog-in 150ms ease-out;
  }
  /* Keep the modal in the top layer while leaving, including browsers without overlay transitions. */
  .mar-ui-dialog-overlay[open][data-closing],
  .mar-ui-dialog-overlay[open][data-closing]::backdrop {
    animation: mar-dialog-out 130ms ease-in both;
  }
  @keyframes mar-dialog-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @keyframes mar-dialog-out {
    from {
      opacity: 1;
    }
    to {
      opacity: 0;
    }
  }
}
.mar-ui-dialog-overlay.is-align-center {
  align-items: center;
}
.mar-ui-dialog-overlay::backdrop {
  background: var(--mar-ui-dialog-scrim, rgb(0 0 0 / 50%));
}
.mar-ui-dialog {
  display: flex;
  flex-direction: column;
  min-inline-size: 0;
  min-block-size: 0;
  inline-size: var(--mar-ui-dialog-width, 50%);
  padding: var(--mar-ui-dialog-padding, 16px);
  border-radius: var(--mar-ui-radius-surface);
  background: var(--mar-ui-dialog-surface, var(--mar-ui-bg-panel));
  color: var(--mar-ui-text-primary);
  box-shadow: var(--mar-ui-dialog-shadow, var(--mar-ui-overlay-shadow));
}
.mar-ui-dialog:where(:not(.is-fullscreen, .file-preview-surface, .attachment-preview-dialog)) {
  --mar-ui-dialog-top-gap: max(16px, 15vh, env(safe-area-inset-top, 0px));
  --mar-ui-dialog-bottom-gap: max(16px, env(safe-area-inset-bottom, 0px));
  max-block-size: calc(100dvh - var(--mar-ui-dialog-top-gap) - var(--mar-ui-dialog-bottom-gap));
  max-inline-size: calc(100vw - 32px);
  margin-block: var(--mar-ui-dialog-top-gap) var(--mar-ui-dialog-bottom-gap);
  overflow: hidden;
}
.is-align-center
  .mar-ui-dialog:where(:not(.is-fullscreen, .file-preview-surface, .attachment-preview-dialog)) {
  --mar-ui-dialog-top-gap: max(16px, env(safe-area-inset-top, 0px));
  margin-block: auto;
}
.mar-ui-dialog.is-fullscreen {
  inline-size: 100%;
  max-block-size: 100dvh;
  block-size: 100dvh;
  border-radius: 0;
}
.mar-ui-dialog.is-fullscreen > .mar-ui-dialog__body {
  flex: 1;
  overflow: auto;
}
.mar-ui-dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: none;
  padding-block-end: 12px;
}
.mar-ui-dialog__header:empty {
  display: none;
}
.mar-ui-dialog__title {
  margin: 0;
  min-inline-size: 0;
  line-height: 24px;
  overflow-wrap: anywhere;
  font-size: var(--mar-ui-dialog-title-size, 16px);
  font-weight: 500;
}
.mar-ui-dialog__header .mar-ui-dialog__close {
  --mar-ui-button-icon-size: var(--mar-ui-action-icon-size, 18px);
  align-self: flex-start;
  flex: none;
  min-inline-size: 28px;
  aspect-ratio: 1;
  padding: 0;
}
.mar-ui-dialog__header .mar-ui-dialog__close:focus-visible {
  outline-offset: -2px;
}
.mar-ui-dialog__body {
  min-inline-size: 0;
  min-block-size: 0;
}
.mar-ui-dialog:where(:not(.is-fullscreen, .file-preview-surface, .attachment-preview-dialog))
  > .mar-ui-dialog__body {
  overflow: auto;
  overscroll-behavior: contain;
}
.mar-ui-dialog__footer {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  text-align: end;
  padding-block-start: 16px;
}
.mar-ui-dialog__footer > :deep(.mar-ui-button + .mar-ui-button) {
  margin-inline-start: 0;
}
</style>
