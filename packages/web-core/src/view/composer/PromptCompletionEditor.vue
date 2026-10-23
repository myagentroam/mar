<script setup lang="ts">
import { marIcon } from '../../util/mar-icons.js';

import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type CSSProperties
} from 'vue';
import { ElMessage } from 'element-plus';
import BusyIndicator from '../common/BusyIndicator.vue';
import type { PromptCompletionResponse } from '@myagentroam/protocol';
import {
  PromptCompletionService,
  type CompletionDraft,
  type CompletionTrigger
} from '../../service/PromptCompletionService';
import { translate } from '../../service/LocalePreferenceService';
import { errorMessage } from '../../util/error-presentation.js';

const props = defineProps<{
  enabled: boolean;
  blocked?: boolean;
  contextKey: string;
  automaticKey?: string | undefined;
  automaticTerminalKey?: string | undefined;
  readContextRevision?: (() => string) | undefined;
  placeholder?: string;
  request: (
    draft: CompletionDraft,
    signal: AbortSignal,
    trigger: CompletionTrigger
  ) => Promise<PromptCompletionResponse>;
}>();
const root = ref<HTMLElement>();
const mirror = ref<HTMLElement>();
const revision = ref(0);
const mirrorStyle = ref<CSSProperties>({});
let editor: HTMLTextAreaElement | undefined;
let placeholder = '';
let originalHeight: string | undefined;
let pendingDraft: CompletionDraft | undefined;
let resize: ResizeObserver | undefined;
let buttonAction: { kind: 'request' | 'cancel' | 'accept'; id?: string } | undefined;
let editing = false;
let composing = false;
let handlingAction = false;
let editorFocused = false;
let foreground = false;
const state = computed(() => {
  void revision.value;
  return service.state;
});
const preview = computed(() => {
  void revision.value;
  return service.preview;
});
const buttonLabel = computed(() =>
  translate(
    state.value.kind === 'pending'
      ? 'promptCompletion.cancel'
      : state.value.kind === 'ready'
        ? 'promptCompletion.accept'
        : 'promptCompletion.request'
  )
);
const feedbackKeys = new Set([
  'IN_FLIGHT',
  'RATE_LIMITED',
  'STALE_CONTEXT',
  'UNAVAILABLE',
  'CAPACITY',
  'PROMPT_COMPLETION_INSERT_UNSUPPORTED',
  'PROMPT_COMPLETION_FAILED'
]);
const service = new PromptCompletionService({
  readDraft() {
    if (
      !props.enabled ||
      props.blocked ||
      composing ||
      !editor ||
      editor.readOnly ||
      editor.disabled
    )
      return undefined;
    return { text: editor.value, cursor: editor.value.length };
  },
  canRequest: hasEditorFocus,
  canAutomaticRequest: (reason) =>
    props.automaticKey !== undefined &&
    isForeground() &&
    (reason === 'ENTER' || reason === 'TURN_END' || hasEditorFocus()),
  readContextRevision: () => props.readContextRevision?.() ?? '',
  request: (draft, signal, trigger) => {
    pendingDraft = draft;
    return props.request(draft, signal, trigger);
  },
  apply(draft, insertion) {
    if (!editor || editor.value !== draft.text) return false;
    clearPreview();
    restoreFocus();
    editor.setSelectionRange(0, editor.value.length);
    editing = true;
    try {
      // The editing command preserves native undo; no value-assignment fallback is permitted.
      const applied = document.execCommand('insertText', false, insertion);
      return applied && editor.value === insertion;
    } finally {
      editing = false;
    }
  },
  changed() {
    revision.value++;
    if (!service.preview) clearPreview();
    else void nextTick(renderPreview);
  },
  feedback(reason, error) {
    if (error !== undefined)
      ElMessage.error({ icon: marIcon('error'), message: errorMessage(error) });
    else if (feedbackKeys.has(reason))
      ElMessage.info({ icon: marIcon('info'), message: translate(`promptCompletion.${reason}`) });
    else ElMessage.error({ icon: marIcon('error'), message: reason });
  }
});

function clearPreview() {
  if (editor) {
    editor.removeAttribute('data-completion-preview');
    if (editor.placeholder !== placeholder && !service.preview) editor.placeholder = placeholder;
    if (originalHeight !== undefined) editor.style.height = originalHeight;
    originalHeight = undefined;
  }
  if (mirror.value) mirror.value.style.display = 'none';
}
function renderPreview() {
  const candidate = preview.value;
  if (!candidate || !editor || !root.value) return;
  if (candidate.draft.text.length === 0) {
    editor.placeholder = candidate.suggestion;
    return;
  }
  editor.removeAttribute('data-completion-preview');
  const style = getComputedStyle(editor);
  const properties = [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'lineHeight',
    'letterSpacing',
    'wordSpacing',
    'textIndent',
    'textAlign',
    'tabSize',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'borderStyle'
  ] as const;
  const values: Record<string, string> = {};
  for (const property of properties) values[property] = style[property];
  mirrorStyle.value = {
    ...values,
    top: `${editor.offsetTop}px`,
    left: `${editor.offsetLeft}px`,
    width: `${editor.offsetWidth}px`,
    minHeight: `${editor.offsetHeight}px`,
    color: style.color
  };
  editor.setAttribute('data-completion-preview', '');
  void nextTick(() => {
    if (!mirror.value || !editor || !service.preview) return;
    mirror.value.style.display = 'block';
    const height = mirror.value.scrollHeight;
    if (height > window.innerHeight * 0.6) {
      service.cancel();
      return;
    }
    if (height > editor.clientHeight) {
      originalHeight ??= editor.style.height;
      editor.style.height = `${height}px`;
    }
    mirror.value.scrollTop = editor.scrollTop;
    mirror.value.scrollLeft = editor.scrollLeft;
  });
}
function keydown(event: KeyboardEvent) {
  if (
    event.target === editor &&
    event.key === 'Tab' &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (props.enabled && !props.blocked && !event.isComposing) service.tab(event.repeat);
    return;
  }
  if (!props.enabled || props.blocked || event.defaultPrevented || event.isComposing) return;
  if (
    (event.target as Element | null)?.closest(
      '[data-completion-action], [data-completion-cancel]'
    ) &&
    (event.key === 'Enter' || event.key === ' ')
  ) {
    if (!event.repeat) captureButtonAction(event.target as Element | null);
    return;
  }
  if (event.target !== editor) return;
  // Focus-navigation and modified Tab chords do not edit or dismiss a prediction.
  if (event.key === 'Tab') return;
  if (event.key === 'Escape' && service.cancel()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (
    [
      'Shift',
      'Control',
      'Alt',
      'Meta',
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'Home',
      'End'
    ].includes(event.key)
  )
    return;
  service.cancel();
}
function pointerdown(event: PointerEvent) {
  const target = event.target as Element | null;
  if (!target?.closest('[data-completion-action], [data-completion-cancel]')) return;
  captureButtonAction(event.target as Element | null);
}
function captureButtonAction(target?: Element | null) {
  if (target?.closest('[data-completion-cancel]') && service.state.kind !== 'idle') {
    buttonAction = { kind: 'cancel', id: service.state.id };
    return;
  }
  buttonAction =
    service.state.kind === 'idle'
      ? { kind: 'request' }
      : {
          kind: service.state.kind === 'pending' ? 'cancel' : 'accept',
          id: service.state.id
        };
}
function activate(event: MouseEvent) {
  if (
    buttonAction === undefined &&
    (event.currentTarget as Element).hasAttribute('data-completion-cancel')
  )
    captureButtonAction(event.currentTarget as Element);
  const action =
    buttonAction ??
    (service.state.kind === 'idle'
      ? { kind: 'request' as const }
      : {
          kind: service.state.kind === 'pending' ? ('cancel' as const) : ('accept' as const),
          id: service.state.id
        });
  buttonAction = undefined;
  handlingAction = true;
  try {
    if (action.kind === 'request') {
      restoreFocus();
      void service.request();
    } else if (service.state.kind !== 'idle' && service.state.id === action.id) {
      if (action.kind === 'cancel') service.cancel();
      else service.accept();
      restoreFocus();
    }
  } finally {
    handlingAction = false;
  }
}
function changed() {
  if (!editing) service.cancel();
}
function compositionStart() {
  composing = true;
  changed();
}
function compositionEnd() {
  composing = false;
  changed();
}
function isForeground(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}
function hasEditorFocus(): boolean {
  return isForeground() && !!editor && document.activeElement === editor;
}
function automaticFocus() {
  // A defined key also establishes that this Node and loaded session support automatic requests.
  if (!handlingAction && props.automaticKey !== undefined) service.automaticFocus();
}
function restoreFocus(cursor?: number) {
  editor?.focus({ preventScroll: true });
  if (cursor !== undefined) editor?.setSelectionRange(cursor, cursor);
  service.wakeAutomatic();
}
defineExpose({ restoreFocus });

function focusin(event: FocusEvent) {
  if (event.target !== editor) return;
  if (!foreground) {
    foregroundChanged();
    return;
  }
  const wasFocused = editorFocused;
  editorFocused = hasEditorFocus();
  if (!wasFocused && editorFocused) automaticFocus();
}
function focusout(event: FocusEvent) {
  if (event.target === editor) {
    editorFocused = false;
    service.automaticBlur();
  }
}
function foregroundChanged() {
  const next = isForeground();
  if (next === foreground) return;
  foreground = next;
  if (!next) {
    editorFocused = false;
    service.automaticBlur();
    return;
  }
  editorFocused = hasEditorFocus();
  service.wakeAutomatic();
  if (!editorFocused) return;
  automaticFocus();
}
function pointerup(event: PointerEvent) {
  if (buttonAction === undefined) return;
  const target = event.target as Element | null;
  if (!target?.closest('[data-completion-action], [data-completion-cancel]')) pointercancel();
}
function pointercancel() {
  if (buttonAction === undefined) return;
  buttonAction = undefined;
}
onMounted(() => {
  editor = root.value?.querySelector('textarea') ?? undefined;
  placeholder = editor?.placeholder ?? '';
  foreground = isForeground();
  editorFocused = hasEditorFocus();
  service.automaticBaseline(props.automaticKey, props.automaticTerminalKey);
  if (props.enabled && !props.blocked) service.automaticEnter();
  editor?.addEventListener('scroll', renderPreview, { passive: true });
  window.addEventListener('focus', foregroundChanged);
  window.addEventListener('blur', foregroundChanged);
  window.addEventListener('pointerup', pointerup);
  window.addEventListener('pointercancel', pointercancel);
  document.addEventListener('visibilitychange', foregroundChanged);
  resize = new ResizeObserver(() => {
    if (service.preview) renderPreview();
  });
  if (editor) resize.observe(editor);
});
watch(
  () =>
    [
      props.enabled,
      props.blocked,
      props.contextKey,
      props.automaticKey,
      props.automaticTerminalKey
    ] as const,
  (current, previous) => {
    if (current.slice(0, 3).some((value, index) => value !== previous[index])) {
      buttonAction = undefined;
      service.cancel();
      service.automaticBaseline(current[3], current[4]);
      if (props.enabled && !props.blocked) service.automaticEnter();
      editorFocused = hasEditorFocus();
      return;
    }
    if (current[3] === undefined || previous[3] === undefined) {
      service.automaticBaseline(current[3], current[4]);
      return;
    }
    if (current[4] !== previous[4]) {
      service.automaticSignal(current[4] ?? '', 'TURN_END');
    }
    service.automaticSignal(current[3] ?? '');
  },
  // Context and history props arrive in one render; establish their baseline together.
  { flush: 'post' }
);
watch(
  () => props.placeholder,
  (value) => {
    placeholder = value ?? '';
    if (service.preview) renderPreview();
    else clearPreview();
  }
);
onBeforeUnmount(() => {
  service.dispose();
  resize?.disconnect();
  editor?.removeEventListener('scroll', renderPreview);
  window.removeEventListener('focus', foregroundChanged);
  window.removeEventListener('blur', foregroundChanged);
  window.removeEventListener('pointerup', pointerup);
  window.removeEventListener('pointercancel', pointercancel);
  document.removeEventListener('visibilitychange', foregroundChanged);
});
</script>

<template>
  <div
    ref="root"
    class="completion-shell"
    @keydown.capture="keydown"
    @input.capture="changed"
    @compositionstart.capture="compositionStart"
    @compositionend.capture="compositionEnd"
    @pointerdown.capture="pointerdown"
    @focusin="focusin"
    @focusout="focusout"
  >
    <slot />
    <div
      v-if="preview && preview.draft.text"
      ref="mirror"
      class="completion-mirror"
      :style="mirrorStyle"
      aria-hidden="true"
    >
      <span class="completion-insertion">{{ preview.suggestion }}</span>
    </div>
    <div v-if="enabled" class="completion-actions" :data-state="state.kind">
      <span class="completion-status" role="status">
        <BusyIndicator v-if="state.kind === 'pending'" />
        <span v-else class="completion-indicator" aria-hidden="true" />
        {{
          translate(
            state.kind === 'pending'
              ? 'promptCompletion.pending'
              : state.kind === 'ready'
                ? 'promptCompletion.ready'
                : state.notice === 'empty'
                  ? 'promptCompletion.empty'
                  : 'promptCompletion.idle'
          )
        }}
      </span>
      <span class="completion-hint">{{
        translate(
          state.kind === 'pending'
            ? 'promptCompletion.pendingShortcut'
            : state.kind === 'ready'
              ? 'promptCompletion.readyShortcut'
              : 'promptCompletion.idleShortcut'
        )
      }}</span>
      <span class="completion-buttons">
        <el-button
          data-completion-action
          class="utility-control"
          link
          size="small"
          :disabled="blocked"
          :aria-label="buttonLabel"
          @click="activate"
          >{{ buttonLabel }}</el-button
        >
        <el-button
          v-if="state.kind === 'ready'"
          data-completion-cancel
          class="utility-control"
          link
          size="small"
          :aria-label="translate('promptCompletion.cancel')"
          @click="activate"
        >
          {{ translate('promptCompletion.cancel') }}
        </el-button>
      </span>
    </div>
    <span class="completion-announcement" aria-live="polite">{{
      preview ? translate('promptCompletion.preview', { text: preview.suggestion }) : ''
    }}</span>
  </div>
</template>

<style scoped>
.completion-shell {
  position: relative;
  min-width: 0;
}
.completion-shell :deep(textarea[data-completion-preview]) {
  color: transparent;
  caret-color: var(--mar-text-primary);
}
.completion-mirror {
  position: absolute;
  box-sizing: border-box;
  border-color: transparent;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  pointer-events: none;
  overflow: hidden;
}
.completion-insertion {
  color: var(--mar-text-muted);
}
.completion-actions {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.125rem 0.625rem;
  margin-top: 0;
  padding: 0.1875rem 0.625rem;
  border: 0;
  border-top: 1px solid var(--mar-border-subtle);
  border-radius: 0;
  font-size: var(--mar-font-size-meta);
  line-height: 1.4;
  background: transparent;
  transition:
    background-color 160ms ease,
    border-color 160ms ease;
}
.completion-actions[data-state='pending'],
.completion-actions[data-state='ready'] {
  background: var(--mar-color-brand-subtle);
}
.completion-buttons {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
.completion-actions :deep([data-completion-action]),
.completion-actions :deep([data-completion-cancel]) {
  height: auto;
  min-height: 0;
  margin: 0;
  padding: 0.125rem 0.25rem;
  border: 0;
  background: transparent;
  font-size: inherit;
  line-height: inherit;
}
.completion-status {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  color: var(--mar-text-secondary);
  font-size: inherit;
  font-weight: 500;
}
.completion-indicator {
  flex: 0 0 auto;
  width: 0.3125rem;
  height: 0.3125rem;
  border-radius: 50%;
  background: var(--mar-text-faint);
}
.completion-actions[data-state='ready'] .completion-indicator {
  background: var(--mar-color-brand-text);
  animation: prediction-ready 240ms ease-out;
}
.completion-hint {
  color: var(--mar-text-muted);
  font-size: inherit;
}
@keyframes prediction-ready {
  from {
    transform: scale(0.6);
    opacity: 0.4;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}
@media (max-width: 767px) {
  .completion-actions {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .completion-hint {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .completion-actions {
    transition: none;
  }
  .completion-actions[data-state] .completion-indicator {
    animation: none;
  }
}
.completion-announcement {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
</style>
