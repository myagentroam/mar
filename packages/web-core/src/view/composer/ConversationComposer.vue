<script setup lang="ts">
import MarIcon from '../common/MarIcon.vue';
import { translate } from '../../service/locale-preference-service.js';
import BusyIndicator from '../common/BusyIndicator.vue';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { RunnerCommandState } from '../../model/workbench.js';
import type { ComposerSkillToken } from '../../model/workbench.js';
import type { ComposerFileReference } from '@myagentroam/protocol';
import FileTypeIcon from '../workspace/FileTypeIcon.vue';
import PromptCompletionEditor from './PromptCompletionEditor.vue';
import type { PromptCompletionBinding } from '../../service/prompt-completion-client-service.js';
import type {
  CompletionDraft,
  CompletionTrigger
} from '../../service/prompt-completion-service.js';

const editorElement = ref<HTMLTextAreaElement>();
const completionEditor = ref<{ restoreFocus(cursor?: number): void }>();
const composerElement = ref<HTMLElement>();
const mobileComposerHeight = ref(0);
let composerResizeObserver: ResizeObserver | undefined;

function focusEditor(cursor?: number): void {
  const contextKey = props.completion?.contextKey;
  void nextTick()
    .then(() => nextTick())
    .then(() => {
      if (props.completion?.contextKey !== contextKey) return;
      completionEditor.value?.restoreFocus(cursor);
    });
}

function focusAt(cursor: number): void {
  focusEditor(cursor);
}

function focus(): void {
  focusEditor();
}

defineExpose({ focusAt, focus });

const props = withDefaults(
  defineProps<{
    input: string;
    placeholder: string;
    working: boolean;
    workingBusy?: boolean;
    workingLabel: string;
    elapsedLabel?: string;
    connectionLabel?: string;
    connectionBusy?: boolean;
    readonly: boolean;
    dropTarget: boolean;
    mobileViewport: boolean;
    commandStates: readonly RunnerCommandState[];
    loading: boolean;
    skillTokens: readonly ComposerSkillToken[];
    fileReferences?: readonly ComposerFileReference[];
    completion?: PromptCompletionBinding | undefined;
    completionBlocked?: boolean;
  }>(),
  { fileReferences: () => [], workingBusy: true }
);

function requestCompletion(
  draft: CompletionDraft,
  signal: AbortSignal,
  trigger: CompletionTrigger
) {
  if (!props.completion)
    return Promise.reject(new DOMException('Prompt completion was cancelled.', 'AbortError'));
  return props.completion.request(draft, signal, undefined, trigger);
}

function onKeydown(event: KeyboardEvent): void {
  const editor = editorElement.value;
  if (event.isComposing) return;
  if (
    editor !== undefined &&
    !props.readonly &&
    !props.loading &&
    event.key === 'Backspace' &&
    editor.value.length === 0 &&
    editor.selectionStart === 0 &&
    editor.selectionEnd === 0 &&
    (props.skillTokens.length > 0 || props.fileReferences.length > 0)
  ) {
    event.preventDefault();
    if (props.fileReferences.length > 0) emit('removeReference', props.fileReferences.at(-1)!.path);
    else emit('removeSkill', props.skillTokens.at(-1)!.name);
    return;
  }
  emit('keydown', event);
}

function onEditorInput(event?: InputEvent, source?: 'keyboard' | 'paste'): void {
  const editor = editorElement.value;
  if (editor === undefined) return;
  const inputSource = source ?? (event?.inputType === 'insertFromPaste' ? 'paste' : 'keyboard');
  emit('update:input', editor.value);
  if (event?.isComposing) return;
  emit('input', editor.selectionStart, inputSource);
}

function onEditorCursor(event: MouseEvent | KeyboardEvent): void {
  if (event instanceof KeyboardEvent) {
    if (event.isComposing) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
      return;
  }
  const editor = editorElement.value;
  if (editor !== undefined) emit('cursor', editor.selectionStart);
}

function syncMobileComposerHeight(): void {
  mobileComposerHeight.value = props.mobileViewport
    ? (composerElement.value?.getBoundingClientRect().height ?? 0)
    : 0;
}

onMounted(() => {
  composerResizeObserver = new ResizeObserver(syncMobileComposerHeight);
  if (composerElement.value !== undefined) composerResizeObserver.observe(composerElement.value);
  syncMobileComposerHeight();
});

watch(
  () => props.mobileViewport,
  () => void nextTick(syncMobileComposerHeight)
);

onBeforeUnmount(() => composerResizeObserver?.disconnect());

const emit = defineEmits<{
  'update:input': [value: string];
  submit: [];
  input: [cursor: number, source: 'keyboard' | 'paste'];
  keydown: [event: KeyboardEvent];
  cursor: [cursor: number];
  paste: [event: ClipboardEvent];
  dragenter: [event: DragEvent];
  dragleave: [event: DragEvent];
  drop: [event: DragEvent];
  closeCommand: [state: RunnerCommandState];
  removeSkill: [name: string];
  removeReference: [path: string];
}>();
</script>

<template>
  <form
    class="composer-host"
    :style="mobileViewport ? { height: `${mobileComposerHeight}px` } : undefined"
    @submit.prevent="emit('submit')"
  >
    <div ref="composerElement" class="composer">
      <span
        v-if="working || connectionLabel"
        class="composer-working"
        :class="{ 'is-active': working && !connectionLabel }"
      >
        <BusyIndicator
          v-if="connectionLabel ? connectionBusy : working && workingBusy"
          class="composer-busy-indicator"
        />
        <span role="status" aria-live="polite">{{ connectionLabel || workingLabel }}</span>
        <span v-if="elapsedLabel && !connectionLabel" class="composer-elapsed">{{
          elapsedLabel
        }}</span>
      </span>
      <div
        :class="[
          'composer-shell',
          {
            readonly,
            'has-working': working || Boolean(connectionLabel),
            'composer-drop-target': dropTarget
          }
        ]"
        @dragenter.prevent="emit('dragenter', $event)"
        @dragleave="emit('dragleave', $event)"
        @dragover.prevent
        @drop.prevent="emit('drop', $event)"
        @paste="emit('paste', $event)"
      >
        <div
          v-if="commandStates.length || skillTokens.length || fileReferences.length"
          class="composer-command-states"
        >
          <button
            v-tooltip="state.detail !== state.label ? state.detail : undefined"
            v-for="state in commandStates"
            :key="state.commandId"
            :aria-label="state.detail ?? state.label"
            class="composer-command-state"
            type="button"
            :disabled="!state.closable || loading"
            @click="emit('closeCommand', state)"
          >
            <span>{{ state.label }}</span
            ><MarIcon v-if="state.closable" name="close" />
          </button>
          <button
            v-tooltip="
              token.available
                ? token.skillFilePath
                : translate('composer.skillUnavailableToken', { name: token.name })
            "
            v-for="token in skillTokens"
            :key="token.name"
            class="composer-command-state composer-skill-state"
            :class="{ unavailable: !token.available }"
            type="button"
            :disabled="readonly || loading"
            :aria-label="translate('composer.removeSkill', { name: token.name })"
            @click="emit('removeSkill', token.name)"
          >
            <MarIcon name="collection" />
            <span>{{ token.name }}</span
            ><MarIcon name="close" />
          </button>
          <button
            v-tooltip="reference.path"
            v-for="reference in fileReferences"
            :key="reference.path"
            class="composer-command-state composer-file-reference-state"
            type="button"
            :disabled="readonly || loading"
            :aria-label="translate('composer.removeFileReference', { name: reference.label })"
            @click="emit('removeReference', reference.path)"
          >
            <FileTypeIcon
              :name="reference.path"
              :kind="reference.type === 'directory' ? 'DIRECTORY' : 'FILE'"
            />
            <span>{{ reference.label }}</span
            ><MarIcon name="close" />
          </button>
        </div>
        <slot name="queue" />
        <slot name="attachments" />
        <PromptCompletionEditor
          ref="completionEditor"
          :enabled="completion?.enabled === true"
          :blocked="readonly || loading || completionBlocked"
          :context-key="completion?.contextKey ?? ''"
          :automatic-key="completion?.automaticKey"
          :automatic-terminal-key="completion?.automaticTerminalKey"
          :read-context-revision="completion?.readContextRevision"
          :placeholder="placeholder"
          :request="requestCompletion"
        >
          <textarea
            ref="editorElement"
            class="composer-input"
            :value="input"
            :readonly="readonly || loading"
            :aria-label="translate('generated.conversationComposer.message')"
            :placeholder="placeholder"
            enterkeyhint="enter"
            @input="onEditorInput"
            @keydown="onKeydown"
            @click="onEditorCursor"
            @keyup="onEditorCursor"
          />
        </PromptCompletionEditor>
        <slot name="toolbar" />
        <slot name="picker" />
      </div>
    </div>
  </form>
</template>

<style scoped>
.composer-host {
  flex: 0 0 auto;
  min-height: 0;
}

.composer {
  position: relative;
  z-index: 3;
  background: var(--mar-conversation-canvas);
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-body);
  padding: 0.4rem 0.8rem 0.75rem;
}

.composer :deep(button),
.composer :deep(input),
.composer :deep(select),
.composer :deep(textarea) {
  font-family: inherit;
}

.composer-input {
  width: 100%;
  min-height: 4.8rem;
  max-height: 12rem;
  box-sizing: border-box;
  overflow-y: auto;
  border: 0;
  background: transparent;
  outline: none;
  padding: 0.55rem 0.7rem;
  color: var(--mar-text-primary);
  font: inherit;
  font-size: var(--mar-font-size-input);
  caret-color: var(--mar-text-primary);
  line-height: 1.55;
  resize: none;
}

.composer-input::placeholder {
  color: var(--mar-text-tertiary);
  opacity: 1;
}

.composer-working {
  position: relative;
  z-index: 2;
  display: inline-flex;
  min-height: 1.3rem;
  max-width: min(18rem, calc(100% - 2.7rem));
  align-items: center;
  gap: 0.34rem;
  margin: 0 0 -1px 0.55rem;
  overflow: hidden;
  border: 1px solid var(--mar-border-medium);
  border-bottom-color: var(--mar-bg-panel);
  border-radius: var(--mar-radius-control) var(--mar-radius-control) 0 0;
  background: var(--mar-bg-panel);
  color: var(--mar-color-brand-text);
  padding: 0.08rem 0.5rem 0.08rem 0.42rem;
  pointer-events: none;
  white-space: nowrap;
  isolation: isolate;
  font-size: var(--mar-font-size-meta);
  font-weight: 600;
  line-height: 1;
}

.composer:focus-within .composer-working {
  border-color: var(--mar-color-brand);
  border-bottom-color: var(--mar-bg-panel);
}

.composer-working > .composer-busy-indicator {
  width: 10px;
  height: 10px;
  border-width: 1.5px;
}

.composer-shell {
  display: grid;
  gap: 0;
  overflow: hidden;
  border: 1px solid var(--mar-border-medium);
  border-radius: var(--mar-radius-surface);
  background: var(--mar-bg-panel);
  box-shadow: none;
}

.composer-shell:focus-within {
  border-color: var(--mar-color-brand);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--mar-color-brand) 14%, transparent);
}

.composer-shell.composer-drop-target {
  border-color: var(--mar-color-brand);
  outline: 2px dashed var(--mar-color-brand);
  outline-offset: -3px;
  background: var(--mar-color-brand-subtle);
}

.composer-shell.composer-drop-target .composer-input {
  background: transparent;
}

.composer-shell.readonly {
  position: relative;
  border-color: var(--mar-border-default);
  background: var(--mar-bg-page);
}

.composer-shell.readonly .composer-input {
  cursor: not-allowed;
  background: var(--mar-bg-page);
}

.composer-shell .composer-input {
  min-height: 96px !important;
  border-radius: calc(var(--mar-radius-surface) - 1px) calc(var(--mar-radius-surface) - 1px) 0 0;
  box-shadow: none;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-input);
  line-height: 1.55;
  padding: 0.75rem 0.8rem 0.25rem;
}

.composer-shell .composer-input:focus {
  box-shadow: none;
}

.composer-command-states {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  padding: 0.45rem 0.55rem 0;
}

.composer-command-state {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  border: 1px solid var(--mar-color-brand);
  border-radius: 999px;
  background: var(--mar-color-brand-subtle);
  color: var(--mar-color-brand-text);
  padding: 0.2rem 0.5rem;
  font-size: var(--mar-font-size-meta);
}

.composer-command-state:not(:disabled) {
  cursor: pointer;
}

.composer-command-state:not(:disabled):hover {
  background: color-mix(in srgb, var(--mar-color-brand) 14%, var(--mar-bg-panel));
}

.composer-skill-state {
  border-color: var(--mar-color-success-text);
  background: var(--mar-color-success-bg);
  color: var(--mar-color-success-text);
}

.composer-skill-state:not(:disabled):hover {
  background: var(--mar-fill-row-hover);
}

.composer-skill-state.unavailable {
  border-color: var(--mar-color-warning-accent);
  background: var(--mar-color-warning-bg);
  color: var(--mar-color-warning-text);
}
</style>

<style scoped>
@media (max-width: 767px) {
  .composer-host {
    width: 100%;
  }

  .composer {
    position: fixed;
    z-index: 6;
    right: 0;
    bottom: 0;
    left: 0;
    padding: 0.35rem 0.6rem calc(0.55rem + env(safe-area-inset-bottom));
  }
}

@media (max-width: 460px) {
  .composer {
    grid-template-columns: 1fr;
  }

  .composer :deep(button) {
    justify-self: end;
  }
}
</style>

<style scoped>
@media (max-width: 767px) {
  :global(.composer-shell .composer-input) {
    min-height: 76px !important;
  }
}
</style>
