<script setup lang="ts">
// Owns only this timeline's native selection and transient menus. Draft admission belongs to the supplied owner.
import { computed, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue';
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
const touch = ref(false);
const selectedMessageId = ref<string>();
const mode = ref<'bubble' | 'menu'>();
const actions = ref<HTMLElement>();
const anchor = ref(new DOMRect());
const virtualReference = computed(() => ({ getBoundingClientRect: () => anchor.value }));
let selected:
  | {
      body: HTMLElement;
      range: Range;
      quote: ComposerQuoteDraft;
      receive: ReturnType<ComposerQuoteTarget['capture']>;
    }
  | undefined;
let dragging = false;
let media: MediaQueryList | undefined;

function close(): void {
  mode.value = undefined;
}
function clear(): void {
  close();
  selected = undefined;
  selectedMessageId.value = undefined;
}
watch(() => props.contextKey, clear);
watchEffect(() => {
  if (!props.target?.capture()) clear();
});
function updateTouch(): void {
  touch.value = media?.matches ?? false;
  close();
}
function inspectSelection(): void {
  if (dragging || actions.value?.contains(document.activeElement)) return;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed || !props.root)
    return clear();
  const range = selection.getRangeAt(0);
  const start =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  const body = start?.closest<HTMLElement>('[data-quote-message-id]');
  if (!body || !props.root.contains(body) || !body.contains(range.endContainer)) return clear();
  const text = selection.toString();
  if (!text.trim()) return clear();
  // Rendered controls, collapsed content and non-message records are not quotation text.
  if (
    [...body.querySelectorAll('button,input,textarea,[hidden],summary')].some((element) =>
      range.intersectsNode(element)
    )
  )
    return clear();
  const receive = props.target?.capture();
  if (!receive) return clear();
  selected = {
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
  selectedMessageId.value = body.dataset.quoteMessageId;
  anchor.value = range.getClientRects()[0] ?? range.getBoundingClientRect();
  mode.value = touch.value ? undefined : 'bubble';
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
    touch.value ||
    !selected ||
    !(event.target instanceof Element) ||
    event.target.closest('a,img,button')
  )
    return;
  if (!selected.body.contains(event.target)) return;
  if (
    ![...selected.range.getClientRects()].some(
      (rect) =>
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
    )
  )
    return;
  event.preventDefault();
  anchor.value = new DOMRect(event.clientX, event.clientY, 0, 0);
  mode.value = 'menu';
}
function pointerDown(event: PointerEvent): void {
  if (actions.value?.contains(event.target as Node)) return;
  if (event.button === 0) {
    close();
    dragging = true;
  }
}
function pointerUp(event: PointerEvent): void {
  if (event.button !== 0) return;
  dragging = false;
  if (!actions.value?.contains(event.target as Node)) inspectSelection();
}
function pointerCancel(): void {
  dragging = false;
  inspectSelection();
}
function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') clear();
}
watch(() => props.root, clear);
onMounted(() => {
  media = matchMedia('(max-width: 767px), (pointer: coarse)');
  updateTouch();
  media.addEventListener('change', updateTouch);
  document.addEventListener('selectionchange', inspectSelection);
  document.addEventListener('pointerdown', pointerDown);
  document.addEventListener('pointerup', pointerUp);
  document.addEventListener('pointercancel', pointerCancel);
  document.addEventListener('contextmenu', contextMenu);
  document.addEventListener('keydown', keydown);
  document.addEventListener('scroll', close, true);
});
onBeforeUnmount(() => {
  media?.removeEventListener('change', updateTouch);
  document.removeEventListener('selectionchange', inspectSelection);
  document.removeEventListener('pointerdown', pointerDown);
  document.removeEventListener('pointerup', pointerUp);
  document.removeEventListener('pointercancel', pointerCancel);
  document.removeEventListener('contextmenu', contextMenu);
  document.removeEventListener('keydown', keydown);
  document.removeEventListener('scroll', close, true);
});
defineExpose({ quote, selectedMessageId, touch });
</script>

<template>
  <el-popover
    :visible="mode !== undefined"
    :virtual-ref="virtualReference"
    virtual-triggering
    placement="top-start"
    width="auto"
    :show-arrow="false"
    :persistent="false"
    :popper-style="{ padding: '0.2rem' }"
  >
    <div
      ref="actions"
      class="quote-actions"
      :role="mode === 'menu' ? 'menu' : 'group'"
      :aria-label="translate('composer.quote')"
      @pointerdown.prevent
    >
      <el-button v-if="mode === 'menu'" text role="menuitem" @click="copy">
        <MarIcon name="copy" />{{ translate('filePreviewContext.copy') }}
      </el-button>
      <el-button text size="small" :role="mode === 'menu' ? 'menuitem' : undefined" @click="quote">
        <MarIcon name="quote" />{{ translate('composer.quote') }}
      </el-button>
    </div>
  </el-popover>
</template>

<style scoped>
.quote-actions {
  display: flex;
  gap: 0.25rem;
}
.quote-actions[role='menu'] {
  flex-direction: column;
}
.quote-actions .el-button {
  margin: 0;
  gap: 0.3rem;
  justify-content: flex-start;
}
</style>
