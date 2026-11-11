<script setup lang="ts">
// Owns only this timeline's native selection and transient menus. Draft admission belongs to the supplied owner.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue';
import type { DropdownInstance } from 'element-plus';
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
const actions = ref<HTMLElement>();
const menu = ref<DropdownInstance>();
const anchor = ref(new DOMRect());
const virtualReference = computed(() => ({ getBoundingClientRect: () => anchor.value }));
interface SelectedQuote {
  readonly body: HTMLElement;
  readonly range: Range;
  readonly quote: ComposerQuoteDraft;
  readonly receive: NonNullable<ReturnType<ComposerQuoteTarget['capture']>>;
}
let selected: SelectedQuote | undefined;
let dragging = false;
let dismissedRange: Range | undefined;

function close(): void {
  dismissedRange = selected?.range.cloneRange() ?? dismissedRange;
  mode.value = undefined;
}
function clear(): void {
  close();
  selected = undefined;
}
watch([() => props.contextKey, () => props.root], () => {
  clear();
  dismissedRange = undefined;
});
watchEffect(() => {
  if (!props.target?.capture()) clear();
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
  if (dragging || actions.value?.contains(document.activeElement)) return;
  const value = readSelection();
  if (!value) return clear();
  if (
    sameRange(value.range, dismissedRange) ||
    (mode.value === 'menu' && sameRange(value.range, selected?.range))
  )
    return;
  selected = value;
  anchor.value = value.range.getClientRects()[0] ?? value.range.getBoundingClientRect();
  mode.value = 'bubble';
}
function quote(): void {
  const value = selected;
  clear();
  if (value?.body.isConnected && props.root?.contains(value.body)) value.receive?.(value.quote);
}
function copy(): void {
  if (selected) emit('copy', selected.quote.text);
  close();
}
function contextMenu(event: MouseEvent): void {
  if (
    !event.cancelable ||
    !(event.target instanceof Element) ||
    !props.root?.contains(event.target) ||
    event.target.closest('a,img,button,input,textarea,select,summary')
  )
    return clear();
  const value = readSelection();
  if (!value?.body.contains(event.target)) return clear();
  event.preventDefault();
  event.stopPropagation();
  dragging = false;
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
  if (actions.value?.contains(event.target as Node)) return;
  if (event.button === 0) {
    close();
    dragging = event.target instanceof Node && props.root?.contains(event.target) === true;
    if (dragging) dismissedRange = undefined;
  }
}
function pointerUp(event: PointerEvent): void {
  if (event.button !== 0) return;
  const selecting = dragging;
  dragging = false;
  if (selecting) inspectSelection();
}
function pointerCancel(): void {
  const selecting = dragging;
  dragging = false;
  if (selecting) inspectSelection();
}
function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') clear();
}
onMounted(() => {
  document.addEventListener('selectionchange', inspectSelection);
  document.addEventListener('pointerdown', pointerDown);
  document.addEventListener('pointerup', pointerUp);
  document.addEventListener('pointercancel', pointerCancel);
  document.addEventListener('contextmenu', contextMenu);
  document.addEventListener('keydown', keydown);
  document.addEventListener('scroll', close, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('selectionchange', inspectSelection);
  document.removeEventListener('pointerdown', pointerDown);
  document.removeEventListener('pointerup', pointerUp);
  document.removeEventListener('pointercancel', pointerCancel);
  document.removeEventListener('contextmenu', contextMenu);
  document.removeEventListener('keydown', keydown);
  document.removeEventListener('scroll', close, true);
});
</script>

<template>
  <el-popover
    v-if="mode === 'bubble'"
    :visible="true"
    :virtual-ref="virtualReference"
    virtual-triggering
    placement="top-start"
    width="auto"
    :show-arrow="false"
    :persistent="false"
    :popper-style="{ padding: '0', minWidth: 'unset', overflow: 'hidden' }"
  >
    <div
      ref="actions"
      class="quote-actions"
      role="group"
      :aria-label="translate('composer.quote')"
      @pointerdown.prevent
    >
      <el-button text size="small" @click="quote">
        <MarIcon name="quote" /><span>{{ translate('composer.quote') }}</span>
      </el-button>
    </div>
  </el-popover>
  <el-dropdown
    v-if="mode === 'menu'"
    ref="menu"
    class="quote-context-menu"
    virtual-triggering
    :virtual-ref="virtualReference"
    trigger="contextmenu"
    placement="bottom-start"
    :show-timeout="0"
    :hide-timeout="0"
    @command="(command: string) => (command === 'copy' ? copy() : quote())"
    @visible-change="
      (visible: boolean) => {
        if (!visible) close();
      }
    "
  >
    <template #dropdown>
      <div ref="actions" @pointerdown.prevent>
        <el-dropdown-menu :aria-label="translate('composer.quote')">
          <el-dropdown-item command="copy"
            ><MarIcon name="copy" />{{ translate('filePreviewContext.copy') }}</el-dropdown-item
          >
          <el-dropdown-item command="quote"
            ><MarIcon name="quote" />{{ translate('composer.quote') }}</el-dropdown-item
          >
        </el-dropdown-menu>
      </div>
    </template>
  </el-dropdown>
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
.quote-actions .el-button {
  margin: 0;
  justify-content: flex-start;
  border-radius: var(--mar-radius-surface);
}
</style>
