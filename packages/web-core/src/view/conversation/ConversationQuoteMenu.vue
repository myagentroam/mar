<script setup lang="ts">
import {
  MarDropdown,
  MarDropdownItem,
  MarDropdownMenu,
  type MarDropdownInstance
} from '@myagentroam/mar-ui/dropdown';
import { MarButton } from '@myagentroam/mar-ui/button';
// Owns only this timeline's native selection and transient menus. Draft admission belongs to the supplied owner.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue';
import type { ComposerQuoteDraft } from '@myagentroam/protocol';
import type { ComposerQuoteTarget } from '../../model/composer-quote.js';
import { translate } from '../../service/locale-preference-service.js';
import MarIcon from '../common/MarIcon.vue';

const props = defineProps<{
  readonly root: HTMLElement | undefined;
  readonly target?: ComposerQuoteTarget | undefined;
  readonly contextKey?: string | undefined;
}>();
const emit = defineEmits<{ copy: [text: string] }>();
const mode = ref<'bubble' | 'menu'>();
const bubbleActions = ref<HTMLElement>();
const menuActions = ref<HTMLElement>();
const activeActions = computed(() =>
  mode.value === 'bubble'
    ? bubbleActions.value
    : mode.value === 'menu'
      ? menuActions.value
      : undefined
);
const menu = ref<MarDropdownInstance>();
const bubbleAnchor = ref(new DOMRect());
const bubbleReference = { getBoundingClientRect: () => bubbleAnchor.value };
const anchor = ref(new DOMRect());
const virtualReference = computed(() => ({ getBoundingClientRect: () => anchor.value }));
interface SelectedQuote {
  readonly body: HTMLElement;
  readonly range: Range;
  readonly quote: ComposerQuoteDraft;
  readonly receive: NonNullable<ReturnType<ComposerQuoteTarget['capture']>>;
}
let selected: SelectedQuote | undefined;
let selectionPointer: number | undefined;
let dismissedRange: Range | undefined;

function dismiss(): void {
  dismissedRange = selected?.range ?? dismissedRange;
  selected = undefined;
  mode.value = undefined;
}
watch([() => props.contextKey, () => props.root], () => {
  dismiss();
  selectionPointer = undefined;
  dismissedRange = undefined;
});
watchEffect(() => {
  if (!props.target?.capture()) dismiss();
});
watch(mode, async (value) => {
  if (value === 'menu') {
    await nextTick();
    if (mode.value === 'menu') menu.value?.handleOpen();
  }
});
function sameRange(range: Range, previous: Range | undefined): boolean {
  return (
    previous !== undefined &&
    range.startContainer === previous.startContainer &&
    range.startOffset === previous.startOffset &&
    range.endContainer === previous.endContainer &&
    range.endOffset === previous.endOffset
  );
}
function readSelection(): SelectedQuote | undefined {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed || !props.root)
    return undefined;
  const range = selection.getRangeAt(0);
  const start =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  const body = start?.closest<HTMLElement>('[data-quote-message-id]');
  if (!body || !props.root.contains(body) || !body.contains(range.endContainer)) return undefined;
  const text = selection.toString();
  if (!text.trim()) return undefined;
  // Links, images, rendered controls and collapsed content are not quotation text.
  if (
    [...body.querySelectorAll('a,img,button,input,textarea,[hidden],summary')].some((element) =>
      range.intersectsNode(element)
    )
  )
    return undefined;
  const receive = props.target?.capture();
  if (!receive) return undefined;
  return {
    body,
    range: range.cloneRange(),
    receive,
    quote: {
      type: 'quote',
      source: 'assistant',
      label: translate('composer.quoteAssistant'),
      text,
      messageId: body.dataset.quoteMessageId!,
      ...(body.dataset.quoteTimestamp ? { timestamp: body.dataset.quoteTimestamp } : {}),
      ...(body.dataset.quoteStreaming === 'true' ? { streaming: true } : {})
    }
  };
}
function inspectSelection(): void {
  // A focused context menu owns its explicit snapshot; the bubble follows the live selection.
  if (mode.value === 'menu' && menuActions.value?.contains(document.activeElement)) return;
  if (selectionPointer !== undefined) {
    // Re-selecting the same text is allowed after an actual selection change during the drag.
    if (dismissedRange) {
      const selection = window.getSelection();
      if (!selection?.rangeCount || !sameRange(selection.getRangeAt(0), dismissedRange))
        dismissedRange = undefined;
    }
    return;
  }
  const value = readSelection();
  if (!value) {
    dismiss();
    dismissedRange = undefined;
    return;
  }
  if (
    sameRange(value.range, dismissedRange) ||
    (sameRange(value.range, selected?.range) && value.quote.text === selected?.quote.text)
  )
    return;
  dismissedRange = undefined;
  selected = value;
  bubbleAnchor.value = value.range.getClientRects()[0] ?? value.range.getBoundingClientRect();
  mode.value = 'bubble';
}
function quote(): void {
  const value = selected;
  const current = mode.value === 'bubble' ? readSelection() : value;
  dismiss();
  // Native selectionchange is queued, so activation can precede its notification.
  if (
    value &&
    current &&
    value.body === current.body &&
    current.body.isConnected &&
    props.root?.contains(current.body) &&
    sameRange(current.range, value.range) &&
    current.quote.text === value.quote.text
  )
    value.receive(current.quote);
}
function copy(): void {
  if (selected) emit('copy', selected.quote.text);
  dismiss();
}
function contextMenu(event: MouseEvent): void {
  if (
    !event.cancelable ||
    !(event.target instanceof Element) ||
    !props.root?.contains(event.target) ||
    event.target.closest('a,img,button,input,textarea,select,summary')
  )
    return dismiss();
  const value = readSelection();
  if (!value?.body.contains(event.target)) return dismiss();
  event.preventDefault();
  event.stopPropagation();
  selectionPointer = undefined;
  dismissedRange = undefined;
  selected = value;
  const rects = [...value.range.getClientRects()];
  // Selection-handle and keyboard events need not point inside painted text.
  const atSelection = rects.some(
    (rect) =>
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
  );
  anchor.value = atSelection
    ? new DOMRect(event.clientX, event.clientY, 0, 0)
    : (rects[0] ?? value.range.getBoundingClientRect());
  mode.value = 'menu';
}
function pointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !(event.target instanceof Node)) return;
  // A new primary gesture can recover from a release outside the document, even with a new ID.
  if (selectionPointer !== undefined && selectionPointer !== event.pointerId && !event.isPrimary)
    return;
  selectionPointer = undefined;
  if (activeActions.value?.contains(event.target)) return;
  dismiss();
  if (props.root?.contains(event.target)) selectionPointer = event.pointerId;
}
function finishSelection(event: PointerEvent): void {
  if (event.pointerId === selectionPointer) {
    selectionPointer = undefined;
    inspectSelection();
  }
}
function windowBlur(): void {
  selectionPointer = undefined;
  dismiss();
}
function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') dismiss();
}
onMounted(() => {
  document.addEventListener('selectionchange', inspectSelection);
  // Observe the whole gesture even if an inner control consumes a pointer event.
  document.addEventListener('pointerdown', pointerDown, true);
  document.addEventListener('pointerup', finishSelection, true);
  document.addEventListener('pointercancel', finishSelection, true);
  document.addEventListener('contextmenu', contextMenu);
  document.addEventListener('keydown', keydown);
  document.addEventListener('scroll', dismiss, true);
  window.addEventListener('blur', windowBlur);
});
onBeforeUnmount(() => {
  document.removeEventListener('selectionchange', inspectSelection);
  document.removeEventListener('pointerdown', pointerDown, true);
  document.removeEventListener('pointerup', finishSelection, true);
  document.removeEventListener('pointercancel', finishSelection, true);
  document.removeEventListener('contextmenu', contextMenu);
  document.removeEventListener('keydown', keydown);
  document.removeEventListener('scroll', dismiss, true);
  window.removeEventListener('blur', windowBlur);
});
</script>

<template>
  <el-popover
    :visible="mode === 'bubble'"
    :virtual-ref="bubbleReference"
    virtual-triggering
    placement="top-start"
    width="auto"
    :show-arrow="false"
    :persistent="false"
    popper-class="mar-compact-popover"
    :popper-style="{
      padding: '0',
      minWidth: 'unset',
      overflow: 'hidden',
      pointerEvents: mode === 'bubble' ? undefined : 'none'
    }"
  >
    <div
      ref="bubbleActions"
      class="quote-actions"
      role="group"
      :aria-label="translate('composer.quote')"
      :inert="mode !== 'bubble'"
      @pointerdown.prevent
    >
      <MarButton text size="small" icon="quote" @click="quote">
        {{ translate('composer.quote') }}
      </MarButton>
    </div>
  </el-popover>
  <MarDropdown
    v-if="mode === 'menu'"
    ref="menu"
    virtual-triggering
    :virtual-ref="virtualReference"
    trigger="contextmenu"
    placement="bottom-start"
    :offset="12"
    @command="(command: string) => (command === 'copy' ? copy() : quote())"
    @visible-change="
      (visible: boolean) => {
        if (!visible && mode === 'menu') dismiss();
      }
    "
  >
    <template #dropdown>
      <div ref="menuActions" class="quote-context-menu" @pointerdown.prevent>
        <MarDropdownMenu :aria-label="translate('composer.quote')">
          <MarDropdownItem command="copy"
            ><MarIcon name="copy" />{{ translate('filePreviewContext.copy') }}</MarDropdownItem
          >
          <MarDropdownItem command="quote"
            ><MarIcon name="quote" />{{ translate('composer.quote') }}</MarDropdownItem
          >
        </MarDropdownMenu>
      </div>
    </template>
  </MarDropdown>
</template>

<style scoped>
.quote-context-menu {
  /* The virtual trigger must not shift the timeline and trigger scroll dismissal. */
  display: contents;
}
.quote-actions {
  display: flex;
  gap: 0.25rem;
}
.quote-actions .mar-ui-button {
  --mar-action-icon-size: 1em;
  margin: 0;
  justify-content: flex-start;
  border-radius: var(--mar-radius-surface);
}
</style>
