<script setup lang="ts">
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/MobileDialogReturnService.js';
import { errorMessage } from '../../util/error-presentation.js';
import { showMessage } from '../../service/MessageFeedbackService.js';

import { marIcon } from '../../util/mar-icons.js';
import MarIcon from '../common/MarIcon.vue';
import BusyIndicator from '../common/BusyIndicator.vue';
import { ElMessageBox } from '../../service/MessageBoxService.js';
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch
} from 'vue';
import { translate } from '../../service/LocalePreferenceService.js';
import { createFilePreviewWindowInteractionService } from '../../service/FilePreviewWindowInteractionService.js';
import { markdownPreviewPreferenceService } from '../../service/MarkdownPreviewPreferenceService.js';
import { fileEditorPreferenceService } from '../../service/FileEditorPreferenceService.js';
import { createMobilePreviewPinchZoom } from '../../util/mobile-preview-pinch-zoom.js';
import { errorCode } from '../../util/api-error.js';
import {
  canUseCodeEditor,
  highlightCodeLines,
  type FilePreviewKind
} from '../../util/file-preview.js';
import { fileSizeLabel } from '../../util/file-presentation.js';
import type { EditorSymbol, FileNavigationRequest } from './CodeFileEditor.vue';
import InlineFindBar from './InlineFindBar.vue';
import WorkspaceFilePageFrame from './WorkspaceFilePageFrame.vue';
import WorkspacePreviewContextMenu from './WorkspacePreviewContextMenu.vue';

const CodeFileEditor = defineAsyncComponent(() => import('./CodeFileEditor.vue'));
const MarkdownFilePreview = defineAsyncComponent(() => import('./MarkdownFilePreview.vue'));

interface FileContent {
  readonly path: string;
  readonly size?: number;
  readonly encoding: 'utf-8' | 'base64';
  readonly content: string;
  readonly truncated: boolean;
  readonly revision?: string;
}
interface NavigationTarget {
  readonly source: 'DEFINITION' | 'REFERENCE' | 'FILE';
  readonly path: string;
  readonly line: number;
  readonly column?: number | undefined;
  readonly kind?: string | undefined;
  readonly scope?: string | undefined;
  readonly preview?: string | undefined;
}
interface EditorTabState {
  readonly content: string;
  readonly savedContent: string;
  readonly revision: string | undefined;
  readonly editing: boolean;
}
export interface DirtyTextDraft {
  readonly tabIdentity: string;
  readonly path: string;
  readonly content: string;
  readonly expectedRevision: string;
}

const props = withDefaults(
  defineProps<{
    readonly file: FileContent;
    readonly kind: FilePreviewKind;
    readonly loading?: boolean;
    readonly fullscreen?: boolean;
    readonly downloading: boolean;
    readonly targetLine: number | undefined;
    readonly targetColumn?: number | undefined;
    readonly markdown?: boolean;
    readonly html?: boolean;
    readonly renderMarkdown?: boolean;
    readonly markdownResourceUrl?: (path: string) => string;
    readonly writeEnabled?: boolean;
    readonly saveFile?: (content: string, expectedRevision: string) => Promise<string>;
    readonly codeNavigationEnabled?: boolean;
    readonly active?: boolean;
    readonly navigationLoading?: boolean;
    readonly navigationTargets?: readonly NavigationTarget[];
    readonly navigationNoDefinition?: boolean;
    readonly editorIdentity?: string | number | undefined;
    readonly tabIdentity?: string | undefined;
    readonly initialDirtyDraft?: DirtyTextDraft | undefined;
  }>(),
  { active: true }
);

const emit = defineEmits<{
  viewed: [range: { startLine: number; endLine: number }];
  close: [];
  download: [];
  'open-markdown-preview': [];
  'open-html-preview': [];
  'open-markdown-file': [path: string, external: boolean];
  'navigate-symbol': [symbol: string];
  'navigate-file': [request: FileNavigationRequest];
  'dismiss-navigation': [];
  'open-navigation-target': [target: NavigationTarget];
  reload: [];
  'dirty-draft-applied': [tabIdentity: string];
}>();
const codeEditor = ref<{
  goTo(position: number): void;
  scrollToLine(line: number, column?: number): void;
  cursorPosition(): { readonly line: number; readonly column: number } | undefined;
  positionAt(offset: number): { readonly line: number; readonly column: number } | undefined;
  selectedText(): string;
  insertText(text: string): void;
  openFind(): void;
  focus(): void;
  selectAll(): boolean;
  isFocused(): boolean;
}>();
const previewRoot = ref<{ readonly root: HTMLElement | undefined }>();
const fallbackTextArea = ref<HTMLTextAreaElement>();
const contextMenu = ref<{ open(event: MouseEvent): Promise<void>; close(): void }>();
watch(
  () => props.active,
  (active) => {
    if (active === false) contextMenu.value?.close();
  }
);
const fallbackFindBar = ref<InstanceType<typeof InlineFindBar>>();
const fallbackFindOpen = ref(false);
const fallbackFindQuery = ref('');
const fallbackFindIndex = ref(0);
const editorPreference = fileEditorPreferenceService();
const editorContent = ref(props.file.content);
const savedContent = ref(props.file.content);
const revision = ref(props.file.revision);
const appliedDirtyDrafts = new Set<string>();
let confirmedClose = false;
let activePath = editorStateKey(props.file.path);
const editorTabStates = new Map<string, EditorTabState>();
const codeEditorEnabled = computed(() => props.kind === 'text' && canUseCodeEditor(props.file));
const fallbackTextEnabled = computed(() => props.kind === 'text' && !codeEditorEnabled.value);
const fallbackFindMatches = computed(() => {
  const query = fallbackFindQuery.value;
  if (query.length === 0) return [];
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const matches: { readonly from: number; readonly to: number }[] = [];
  for (const match of editorContent.value.matchAll(expression)) {
    if (match.index === undefined) continue;
    matches.push({ from: match.index, to: match.index + match[0].length });
    if (matches.length >= 5_000) break;
  }
  return matches;
});
const fallbackFindNumber = computed(() =>
  fallbackFindMatches.value.length === 0 ? 0 : fallbackFindIndex.value + 1
);
const canWrite = computed(
  () =>
    codeEditorEnabled.value &&
    props.writeEnabled === true &&
    props.saveFile !== undefined &&
    revision.value !== undefined
);
const editing = ref(canWrite.value && editorPreference.mode.value === 'edit');
const saving = ref(false);

function saveActiveEditorTabState(): void {
  editorTabStates.set(activePath, {
    content: editorContent.value,
    savedContent: savedContent.value,
    revision: revision.value,
    editing: editing.value
  });
}

function editorStateKey(
  path: string,
  identity: string | number | undefined = props.editorIdentity
): string {
  return `${identity ?? ''}\u0000${path}`;
}

function restoreEditorTabState(file: FileContent): void {
  const state = editorTabStates.get(editorStateKey(file.path));
  if (state === undefined) {
    editorContent.value = file.content;
    savedContent.value = file.content;
    revision.value = file.revision;
    editing.value = canWrite.value && editorPreference.mode.value === 'edit';
    return;
  }
  editorContent.value = state.content;
  savedContent.value = state.savedContent;
  revision.value = state.revision;
  editing.value = state.editing && canWrite.value;
}

watch([() => props.file, () => props.editorIdentity], ([file]) => {
  const nextPath = editorStateKey(file.path);
  if (nextPath !== activePath) {
    saveActiveEditorTabState();
    activePath = nextPath;
    restoreEditorTabState(file);
  } else if (!saving.value && editorContent.value === savedContent.value) {
    editorContent.value = file.content;
    savedContent.value = file.content;
    revision.value = file.revision;
    editing.value = canWrite.value && editorPreference.mode.value === 'edit';
  }
});
watch([editorContent, savedContent, revision, editing], saveActiveEditorTabState);
const confirmingClose = ref(false);
const symbols = ref<readonly EditorSymbol[]>([]);
const symbolQuery = ref('');
const symbolsOpen = ref(false);
const symbolInput = ref<{ focus(): void }>();
const symbolList = ref<HTMLElement>();
const symbolDropdown = ref<HTMLElement>();
const navigationDropdown = ref<HTMLElement>();
const definitionTargets = computed(
  () => props.navigationTargets?.filter((target) => target.source === 'DEFINITION') ?? []
);
const referenceTargets = computed(
  () => props.navigationTargets?.filter((target) => target.source === 'REFERENCE') ?? []
);
const fileTargets = computed(
  () => props.navigationTargets?.filter((target) => target.source === 'FILE') ?? []
);

function navigationPreviewHtml(target: NavigationTarget): string | undefined {
  if (target.preview === undefined) return undefined;
  return highlightCodeLines(target.preview, target.path)[0] ?? target.preview;
}
const selectedSymbolIndex = ref(0);
const dirty = computed(() => editorContent.value !== savedContent.value);
watch(canWrite, (available) => {
  if (!available) editing.value = false;
});
const visibleSymbols = computed(() => {
  const query = symbolQuery.value.trim().toLocaleLowerCase();
  return query === ''
    ? symbols.value
    : symbols.value.filter((symbol) => symbol.name.toLocaleLowerCase().includes(query));
});
const previewPinchZoom = createMobilePreviewPinchZoom();
const settingsOpen = ref(false);
const form = ref();
const preferenceService = markdownPreviewPreferenceService();
const watermarkForm = reactive({
  watermarkEnabled: false,
  watermarkText: ''
});
function openSettings(): void {
  watermarkForm.watermarkEnabled = preferenceService.preference.value.watermarkEnabled;
  watermarkForm.watermarkText = preferenceService.preference.value.watermarkText;
  settingsOpen.value = true;
}
async function saveSettings(): Promise<void> {
  const valid = await form.value?.validate().catch(() => false);
  if (!valid) return;
  preferenceService.save(watermarkForm);
  settingsOpen.value = false;
}
function dismissFloatingPanels(event: PointerEvent): void {
  if (props.active === false) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (!target.closest('[data-file-symbol-toggle]') && !symbolDropdown.value?.contains(target))
    closeSymbols();
  if (!navigationDropdown.value?.contains(target)) emit('dismiss-navigation');
}

function focus(): void {
  previewRoot.value?.root?.focus();
}

function cursorPosition(): { readonly line: number; readonly column: number } | undefined {
  if (codeEditorEnabled.value) return codeEditor.value?.cursorPosition();
  const textarea = fallbackTextArea.value;
  if (textarea === undefined) return undefined;
  const prefix = textarea.value.slice(0, textarea.selectionStart);
  const parts = prefix.split('\n');
  return { line: parts.length, column: (parts.at(-1)?.length ?? 0) + 1 };
}

function navigateTo(line: number, column?: number): void {
  if (codeEditorEnabled.value) {
    codeEditor.value?.scrollToLine(line, column);
    return;
  }
  const textarea = fallbackTextArea.value;
  if (textarea === undefined || line < 1) return;
  const lines = textarea.value.split('\n');
  const offset = lines.slice(0, line - 1).reduce((sum, part) => sum + part.length + 1, 0);
  const position = Math.min(textarea.value.length, offset + Math.max(0, (column ?? 1) - 1));
  textarea.setSelectionRange(position, position);
  textarea.focus();
}

function openFind(): boolean {
  if (codeEditorEnabled.value && codeEditor.value !== undefined) {
    codeEditor.value.openFind();
    return true;
  }
  if (!fallbackTextEnabled.value) return false;
  fallbackFindOpen.value = true;
  void nextTick(() => fallbackFindBar.value?.focus());
  return true;
}

function selectAll(): boolean {
  if (codeEditorEnabled.value && codeEditor.value?.isFocused() === true)
    return codeEditor.value.selectAll();
  const textArea = fallbackTextArea.value;
  if (!fallbackTextEnabled.value || document.activeElement !== textArea) return false;
  textArea.setSelectionRange(0, textArea.value.length);
  return true;
}

function moveFallbackFind(direction: -1 | 1): void {
  const count = fallbackFindMatches.value.length;
  if (count === 0) return;
  fallbackFindIndex.value = (fallbackFindIndex.value + direction + count) % count;
  selectFallbackFindMatch();
}

function selectFallbackFindMatch(): void {
  const match = fallbackFindMatches.value[fallbackFindIndex.value];
  const textArea = fallbackTextArea.value;
  if (match === undefined || textArea === undefined) return;
  textArea.focus();
  textArea.setSelectionRange(match.from, match.to);
}

function closeFallbackFind(): void {
  fallbackFindOpen.value = false;
  fallbackTextArea.value?.focus();
}

function toggleEdit(): 'CHANGED' | 'UNAVAILABLE' {
  if (!codeEditorEnabled.value || !canWrite.value) return 'UNAVAILABLE';
  editing.value = !editing.value;
  return 'CHANGED';
}

function onKeydown(event: KeyboardEvent): void {
  if (props.active === false) return;
  if (event.key === 'Escape') {
    if (windowInteraction.isEscapeBlocked(event)) return;
    if (fallbackFindOpen.value) {
      event.preventDefault();
      event.stopPropagation();
      closeFallbackFind();
      return;
    }
    if (props.kind === 'text' && symbolsOpen.value) {
      event.preventDefault();
      event.stopPropagation();
      symbolsOpen.value = false;
      return;
    }
    return;
  }
  if (props.kind !== 'text') return;
  if (settingsOpen.value) return;
  const commandKey = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (commandKey && event.shiftKey && key === 'v' && (props.markdown || props.html)) {
    event.preventDefault();
    event.stopPropagation();
    if (props.html) emit('open-html-preview');
    else emit('open-markdown-preview');
  } else if (commandKey && key === 'h' && editing.value) {
    event.preventDefault();
    event.stopPropagation();
    codeEditor.value?.openFind();
  } else if (commandKey && key === 's' && editing.value && canWrite.value) {
    event.preventDefault();
    event.stopPropagation();
    void save();
  } else if (event.altKey && key === 'm') {
    event.preventDefault();
    if (symbolsOpen.value) closeSymbols();
    else void openSymbols();
  }
}

watch(fallbackFindQuery, () => {
  fallbackFindIndex.value = 0;
  void nextTick(selectFallbackFindMatch);
});

async function openSymbols(): Promise<void> {
  if (!codeEditorEnabled.value) return;
  symbolsOpen.value = true;
  selectedSymbolIndex.value = 0;
  await nextTick();
  symbolInput.value?.focus();
  scrollSelectedSymbolIntoView();
}

function closeSymbols(): void {
  symbolsOpen.value = false;
  codeEditor.value?.focus();
}

function scrollSelectedSymbolIntoView(): void {
  void nextTick(() => {
    symbolList.value
      ?.querySelector<HTMLElement>(`[data-symbol-index="${selectedSymbolIndex.value}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  });
}

function moveSymbolSelection(direction: -1 | 1): void {
  const count = visibleSymbols.value.length;
  if (count === 0) return;
  selectedSymbolIndex.value = (selectedSymbolIndex.value + direction + count) % count;
  scrollSelectedSymbolIntoView();
}

function onSymbolKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    event.stopPropagation();
    moveSymbolSelection(event.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (event.key === 'Enter') {
    const symbol = visibleSymbols.value[selectedSymbolIndex.value];
    if (symbol === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    selectSymbol(symbol);
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeSymbols();
  }
}

watch(
  [() => props.file.path, () => props.initialDirtyDraft],
  () => {
    const draft = props.initialDirtyDraft;
    if (
      draft !== undefined &&
      draft.tabIdentity === props.tabIdentity &&
      !appliedDirtyDrafts.has(draft.tabIdentity)
    ) {
      editorContent.value = draft.content;
      revision.value = draft.expectedRevision;
      editing.value = false;
      appliedDirtyDrafts.add(draft.tabIdentity);
      emit('dirty-draft-applied', draft.tabIdentity);
    }
    symbolsOpen.value = false;
    symbolQuery.value = '';
    selectedSymbolIndex.value = 0;
  },
  { immediate: true }
);

watch([symbolQuery, visibleSymbols], () => {
  selectedSymbolIndex.value = 0;
  scrollSelectedSymbolIntoView();
});

async function save(): Promise<void> {
  if (
    saving.value ||
    !editing.value ||
    !dirty.value ||
    !canWrite.value ||
    revision.value === undefined
  )
    return;
  const submittedPath = activePath;
  const submittedContent = editorContent.value;
  saving.value = true;
  try {
    const savedRevision = await props.saveFile!(submittedContent, revision.value);
    if (activePath === submittedPath) {
      revision.value = savedRevision;
      savedContent.value = submittedContent;
    } else {
      const state = editorTabStates.get(submittedPath);
      if (state !== undefined)
        editorTabStates.set(submittedPath, {
          ...state,
          savedContent: submittedContent,
          revision: savedRevision
        });
    }
    showMessage(translate('fileEditor.saved'), 'success');
  } catch (error) {
    showMessage(
      errorMessage(
        error,
        errorCode(error) === 'FILE_WRITE_CONFLICT'
          ? translate('fileEditor.conflict')
          : translate('fileEditor.saveFailed')
      ),
      'error',
      error
    );
  } finally {
    saving.value = false;
  }
}

async function canClose(): Promise<boolean> {
  if (confirmingClose.value) return false;
  if (dirty.value) {
    confirmingClose.value = true;
    try {
      await ElMessageBox.confirm(
        translate('fileEditor.unsavedMessage'),
        translate('fileEditor.unsavedTitle'),
        { closeIcon: marIcon('close'), icon: marIcon('warning'), type: 'warning' }
      );
    } catch {
      return false;
    } finally {
      confirmingClose.value = false;
    }
  }
  return true;
}

async function requestClose(): Promise<void> {
  emit('close');
}

async function closeFullscreenPreview(): Promise<boolean> {
  if (!(await canClose())) return false;
  prepareForConfirmedClose();
  emit('close');
  return true;
}

const windowInteraction = createFilePreviewWindowInteractionService({
  isOpen: () => props.fullscreen === true && props.active !== false,
  closeWindow: closeFullscreenPreview,
  closeTab: closeFullscreenPreview
});

async function copySelection(): Promise<void> {
  const textarea = fallbackTextArea.value;
  const text = codeEditorEnabled.value
    ? (codeEditor.value?.selectedText() ?? '')
    : (textarea?.value.slice(textarea.selectionStart, textarea.selectionEnd) ?? '');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    showMessage(translate('filePreviewContext.clipboardFailed'), 'error');
  }
}

async function pasteSelection(): Promise<void> {
  if (!editing.value || !codeEditorEnabled.value) return;
  try {
    codeEditor.value?.insertText(await navigator.clipboard.readText());
  } catch {
    showMessage(translate('filePreviewContext.clipboardFailed'), 'error');
  }
}

async function reloadContent(): Promise<void> {
  if (dirty.value) {
    try {
      await ElMessageBox.confirm(
        translate('filePreviewContext.reloadUnsaved'),
        translate('fileEditor.unsavedTitle'),
        { closeIcon: marIcon('close'), icon: marIcon('warning'), type: 'warning' }
      );
    } catch {
      return;
    }
    editorContent.value = savedContent.value;
  }
  emit('reload');
}

function captureDirtyDrafts(): readonly DirtyTextDraft[] {
  saveActiveEditorTabState();
  if (props.kind !== 'text') return [];
  return [...editorTabStates.entries()].flatMap(([key, state]) => {
    if (state.content === state.savedContent || state.revision === undefined) return [];
    const separator = key.indexOf('\u0000');
    const tabIdentity = key.slice(0, separator);
    const path = key.slice(separator + 1);
    return tabIdentity === '' || path === ''
      ? []
      : [{ tabIdentity, path, content: state.content, expectedRevision: state.revision }];
  });
}

function prepareForConfirmedClose(): void {
  confirmedClose = true;
}

function selectSymbol(symbol: EditorSymbol): void {
  symbolsOpen.value = false;
  const position = codeEditor.value?.positionAt(symbol.from);
  if (position !== undefined)
    emit('open-navigation-target', {
      source: 'DEFINITION',
      path: props.file.path,
      ...position
    });
  codeEditor.value?.goTo(symbol.from);
}

function beforeUnload(event: BeforeUnloadEvent): void {
  if (!dirty.value || confirmedClose) return;
  event.preventDefault();
  event.returnValue = '';
}
onMounted(() => {
  document.addEventListener('keydown', onKeydown, { capture: true });
  if (props.fullscreen) windowInteraction.mount();
});
onMounted(() => document.addEventListener('pointerdown', dismissFloatingPanels));
onMounted(() => window.addEventListener('beforeunload', beforeUnload));
onBeforeUnmount(() => {
  windowInteraction.dispose();
  document.removeEventListener('keydown', onKeydown, { capture: true });
  document.removeEventListener('pointerdown', dismissFloatingPanels);
  window.removeEventListener('beforeunload', beforeUnload);
});
defineExpose({
  focus,
  cursorPosition,
  navigateTo,
  openFind,
  selectAll,
  toggleEdit,
  canClose,
  captureDirtyDrafts,
  prepareForConfirmedClose
});
</script>

<template>
  <WorkspaceFilePageFrame
    ref="previewRoot"
    :file-name="file.path.split('/').at(-1) ?? file.path"
    :path="file.path"
    :loading="loading"
    :fullscreen="fullscreen"
    role="dialog"
    :aria-modal="active !== false || undefined"
    :aria-hidden="active === false || undefined"
    :inert="active === false"
    :aria-label="translate('generated.filePreviewDialog.filePreview', { value0: file.path })"
  >
    <template #status>
      <span class="file-preview-eyebrow"
        >{{ editing ? translate('fileEditor.editing') : translate('fileEditor.readOnly') }}
        <span v-if="file.size !== undefined" class="file-preview-size"
          >· {{ fileSizeLabel(file.size) }}</span
        ></span
      >
    </template>
    <template #primary-actions>
      <el-button
        v-tooltip="translate('inlineFind.label')"
        v-if="props.kind === 'text'"
        circle
        size="small"
        :aria-label="translate('inlineFind.label')"
        @click="openFind"
      >
        <MarIcon name="search" />
      </el-button>
      <template v-if="codeEditorEnabled">
        <el-button
          v-tooltip="translate('fileEditor.symbols')"
          data-file-symbol-toggle
          circle
          size="small"
          :aria-label="translate('fileEditor.symbols')"
          @click="symbolsOpen ? closeSymbols() : openSymbols()"
        >
          <MarIcon name="symbols" />
        </el-button>
        <el-button
          v-tooltip="editing ? translate('fileEditor.readOnly') : translate('fileEditor.edit')"
          v-if="canWrite"
          circle
          size="small"
          :aria-label="editing ? translate('fileEditor.readOnly') : translate('fileEditor.edit')"
          @click="editing = !editing"
        >
          <MarIcon name="lock" v-if="editing" />
          <MarIcon name="edit" v-else />
        </el-button>
        <el-button
          v-tooltip="translate('common.save')"
          v-if="editing"
          circle
          size="small"
          type="primary"
          :disabled="!dirty"
          :loading="saving"
          :aria-label="translate('common.save')"
          @click="save"
          :loading-icon="marIcon('loading-action')"
        >
          <MarIcon name="document-save" />
        </el-button>
      </template>
      <template v-if="html">
        <el-button
          v-tooltip="translate('htmlPreview.open')"
          circle
          size="small"
          :aria-label="translate('htmlPreview.open')"
          @click="emit('open-html-preview')"
          ><MarIcon name="view"
        /></el-button>
      </template>
      <template v-if="markdown && !renderMarkdown">
        <el-button
          v-tooltip="translate('markdownPreview.open')"
          circle
          size="small"
          :aria-label="translate('markdownPreview.open')"
          @click="emit('open-markdown-preview')"
          ><MarIcon name="view"
        /></el-button>
        <el-button
          v-tooltip="translate('markdownPreview.settings')"
          circle
          size="small"
          :aria-label="translate('markdownPreview.settings')"
          @click="openSettings"
          ><MarIcon name="settings"
        /></el-button>
      </template>
    </template>
    <template #secondary-actions>
      <el-button
        v-tooltip="translate('generated.filePreviewDialog.downloadFile')"
        :loading="downloading"
        :aria-label="translate('generated.filePreviewDialog.downloadFile')"
        circle
        size="small"
        @click="emit('download')"
        :loading-icon="marIcon('loading-action')"
      >
        <MarIcon name="download" />
      </el-button>
      <el-button
        v-tooltip="translate('generated.filePreviewDialog.closePreview')"
        v-if="fullscreen"
        :aria-label="translate('generated.filePreviewDialog.closePreview')"
        circle
        size="small"
        type="primary"
        @click="requestClose"
      >
        <MarIcon name="close" />
      </el-button>
    </template>
    <template #mobile-actions>
      <el-button
        v-tooltip="translate('inlineFind.label')"
        v-if="props.kind === 'text'"
        data-file-symbol-toggle
        circle
        size="small"
        :aria-label="translate('inlineFind.label')"
        @click="openFind"
        ><MarIcon name="search"
      /></el-button>
      <el-button
        v-tooltip="translate('fileEditor.symbols')"
        v-if="codeEditorEnabled"
        circle
        size="small"
        :aria-label="translate('fileEditor.symbols')"
        @click="symbolsOpen ? closeSymbols() : openSymbols()"
        ><MarIcon name="symbols"
      /></el-button>
      <el-button
        v-tooltip="editing ? translate('fileEditor.readOnly') : translate('fileEditor.edit')"
        v-if="canWrite"
        circle
        size="small"
        :aria-label="editing ? translate('fileEditor.readOnly') : translate('fileEditor.edit')"
        @click="editing = !editing"
        ><MarIcon name="lock" v-if="editing" /> <MarIcon name="edit" v-else
      /></el-button>
      <el-button
        v-tooltip="translate('common.save')"
        v-if="editing"
        circle
        size="small"
        type="primary"
        :disabled="!dirty"
        :loading="saving"
        :aria-label="translate('common.save')"
        @click="save"
        :loading-icon="marIcon('loading-action')"
        ><MarIcon name="document-save"
      /></el-button>
      <template v-if="html">
        <el-button
          v-tooltip="translate('htmlPreview.open')"
          circle
          size="small"
          :aria-label="translate('htmlPreview.open')"
          @click="emit('open-html-preview')"
          ><MarIcon name="view"
        /></el-button>
      </template>
      <template v-if="markdown && !renderMarkdown">
        <el-button
          v-tooltip="translate('markdownPreview.open')"
          circle
          size="small"
          :aria-label="translate('markdownPreview.open')"
          @click="emit('open-markdown-preview')"
          ><MarIcon name="view"
        /></el-button>
        <el-button
          v-tooltip="translate('markdownPreview.settings')"
          circle
          size="small"
          :aria-label="translate('markdownPreview.settings')"
          @click="openSettings"
          ><MarIcon name="settings"
        /></el-button>
      </template>
      <el-button
        v-tooltip="translate('generated.filePreviewDialog.downloadFile2')"
        :loading="downloading"
        :aria-label="translate('generated.filePreviewDialog.downloadFile2')"
        circle
        size="small"
        @click="emit('download')"
        :loading-icon="marIcon('loading-action')"
      >
        <MarIcon name="download" />
      </el-button>
      <el-button
        v-tooltip="translate('generated.filePreviewDialog.closePreview2')"
        v-if="fullscreen"
        :aria-label="translate('generated.filePreviewDialog.closePreview2')"
        circle
        size="small"
        type="primary"
        @click="requestClose"
      >
        <MarIcon name="close" />
      </el-button>
    </template>
    <div
      v-if="symbolsOpen && codeEditorEnabled"
      ref="symbolDropdown"
      class="file-symbol-dropdown"
      @pointerdown.stop
    >
      <el-input
        ref="symbolInput"
        v-model="symbolQuery"
        clearable
        :placeholder="translate('fileEditor.searchSymbols')"
        :aria-controls="'file-symbol-list'"
        :aria-activedescendant="
          visibleSymbols.length === 0 ? undefined : `file-symbol-${selectedSymbolIndex}`
        "
        @keydown="onSymbolKeydown"
        :clear-icon="marIcon('clear-input')"
      />
      <div id="file-symbol-list" ref="symbolList" class="file-symbol-list" role="listbox">
        <button
          v-for="(symbol, index) in visibleSymbols"
          :id="`file-symbol-${index}`"
          :key="`${symbol.from}:${symbol.name}`"
          type="button"
          role="option"
          :aria-selected="index === selectedSymbolIndex"
          :class="{ 'is-selected': index === selectedSymbolIndex }"
          :data-symbol-index="index"
          :style="{ paddingInlineStart: `${0.65 + Math.min(symbol.depth, 4) * 0.75}rem` }"
          @mousemove="selectedSymbolIndex = index"
          @click="selectSymbol(symbol)"
        >
          <span>{{ symbol.name }}</span
          ><small>{{ symbol.kind }}</small>
        </button>
        <p v-if="visibleSymbols.length === 0">{{ translate('fileEditor.noSymbols') }}</p>
      </div>
    </div>
    <div
      v-if="navigationLoading || navigationNoDefinition || (navigationTargets?.length ?? 0) > 0"
      ref="navigationDropdown"
      class="file-symbol-dropdown file-navigation-dropdown"
      @pointerdown.stop
    >
      <p v-if="navigationLoading" class="file-navigation-loading" role="status">
        <MarIcon name="loading-action" />
        {{ translate('fileEditor.preparingNavigation') }}
      </p>
      <template v-else>
        <p v-if="navigationNoDefinition" class="file-navigation-loading">
          {{ translate('fileEditor.noDefinition') }}
        </p>
        <template v-else>
          <p class="file-navigation-title">{{ translate('fileEditor.navigationResults') }}</p>
          <section v-if="definitionTargets.length > 0" class="file-navigation-group is-definition">
            <p class="file-navigation-group-title">{{ translate('fileEditor.definitions') }}</p>
            <div class="file-symbol-list" role="listbox">
              <button
                v-for="target in definitionTargets"
                :key="`${target.source}:${target.path}:${target.line}:${target.kind ?? ''}:${target.scope ?? ''}`"
                class="file-navigation-option"
                type="button"
                role="option"
                @click="emit('open-navigation-target', target)"
              >
                <span class="file-navigation-path">{{ target.path }}</span
                ><small
                  >{{ target.line }}<template v-if="target.kind"> · {{ target.kind }}</template
                  ><template v-if="target.scope"> · {{ target.scope }}</template></small
                >
                <code
                  v-if="navigationPreviewHtml(target)"
                  class="file-navigation-preview hljs"
                  v-html="navigationPreviewHtml(target)"
                />
              </button>
            </div>
          </section>
          <section v-if="referenceTargets.length > 0" class="file-navigation-group is-reference">
            <p class="file-navigation-group-title">{{ translate('fileEditor.references') }}</p>
            <div class="file-symbol-list" role="listbox">
              <button
                v-for="target in referenceTargets"
                :key="`${target.source}:${target.path}:${target.line}:${target.column ?? 0}`"
                class="file-navigation-option"
                type="button"
                role="option"
                @click="emit('open-navigation-target', target)"
              >
                <span class="file-navigation-path">{{ target.path }}</span
                ><small>{{ target.line }} · {{ target.column }}</small>
                <code
                  v-if="navigationPreviewHtml(target)"
                  class="file-navigation-preview hljs"
                  v-html="navigationPreviewHtml(target)"
                />
              </button>
            </div>
          </section>
          <section v-if="fileTargets.length > 0" class="file-navigation-group is-file">
            <p class="file-navigation-group-title">{{ translate('fileEditor.files') }}</p>
            <div class="file-symbol-list" role="listbox">
              <button
                v-for="target in fileTargets"
                :key="`${target.source}:${target.path}`"
                class="file-navigation-option"
                type="button"
                role="option"
                @click="emit('open-navigation-target', target)"
              >
                <span class="file-navigation-path">{{ target.path }}</span
                ><small
                  >{{ target.line }}<template v-if="target.kind"> · {{ target.kind }}</template
                  ><template v-if="target.scope"> · {{ target.scope }}</template></small
                >
                <code
                  v-if="navigationPreviewHtml(target)"
                  class="file-navigation-preview hljs"
                  v-html="navigationPreviewHtml(target)"
                />
              </button>
            </div>
          </section>
        </template>
      </template>
    </div>
    <InlineFindBar
      v-if="fallbackFindOpen && fallbackTextEnabled"
      ref="fallbackFindBar"
      v-model="fallbackFindQuery"
      :current="fallbackFindNumber"
      :total="fallbackFindMatches.length"
      :truncated="fallbackFindMatches.length >= 5_000"
      @previous="moveFallbackFind(-1)"
      @next="moveFallbackFind(1)"
      @close="closeFallbackFind"
    />
    <main
      class="file-preview-content"
      :class="{
        'file-preview-content-code':
          codeEditorEnabled && !(markdown && renderMarkdown && markdownResourceUrl && !editing),
        'file-preview-content-fallback': !codeEditorEnabled
      }"
      @click="!editing && focus()"
    >
      <template v-if="!loading">
        <MarkdownFilePreview
          v-if="markdown && renderMarkdown && markdownResourceUrl && !editing && codeEditorEnabled"
          :content="editorContent"
          :path="file.path"
          :resource-url="markdownResourceUrl"
          @open-file="(path, external) => emit('open-markdown-file', path, external)"
        />
        <CodeFileEditor
          v-else-if="codeEditorEnabled"
          ref="codeEditor"
          v-model="editorContent"
          :aria-label="translate('generated.filePreviewDialog.codeEditorPreview')"
          :path="file.path"
          :read-only="!editing"
          :target-line="targetLine"
          :target-column="targetColumn"
          :code-navigation-enabled="codeNavigationEnabled"
          :style="previewPinchZoom.style.value"
          @pointerdown="previewPinchZoom.pointerDown"
          @pointermove="previewPinchZoom.pointerMove"
          @pointerup="previewPinchZoom.pointerEnd"
          @pointercancel="previewPinchZoom.pointerEnd"
          @symbols="symbols = $event"
          @viewed="!editing && emit('viewed', $event)"
          @navigate-symbol="emit('navigate-symbol', $event)"
          @navigate-file="emit('navigate-file', $event)"
          @contextmenu="contextMenu?.open($event)"
        />
        <textarea
          v-else
          ref="fallbackTextArea"
          class="file-text-preview"
          :value="editorContent"
          :aria-label="translate('generated.filePreviewDialog.codeEditorPreview')"
          readonly
          spellcheck="false"
          @contextmenu="contextMenu?.open($event)"
        />
        <p v-if="!codeEditorEnabled" class="empty">
          {{ translate('generated.filePreviewDialog.onlyTheFirst512KiBIsShown') }}
        </p>
      </template>
    </main>
    <WorkspacePreviewContextMenu
      ref="contextMenu"
      :paste-enabled="editing && codeEditorEnabled"
      @copy="copySelection"
      @paste="pasteSelection"
      @reload="reloadContent"
    />
    <el-dialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="settingsOpen"
      v-model="settingsOpen"
      :title="translate('markdownPreview.settings')"
      width="min(28rem, calc(100vw - 2rem))"
      :close-icon="marIcon('close')"
    >
      <el-form
        ref="form"
        :model="watermarkForm"
        label-position="top"
        :rules="{
          watermarkText: [
            {
              validator: (_rule: unknown, value: string, callback: (error?: Error) => void) =>
                watermarkForm.watermarkEnabled && value.trim() === ''
                  ? callback(new Error(translate('markdownPreview.watermarkRequired')))
                  : callback(),
              trigger: 'blur'
            }
          ]
        }"
      >
        <el-form-item :label="translate('markdownPreview.watermarkEnabled')"
          ><el-switch v-model="watermarkForm.watermarkEnabled"
        /></el-form-item>
        <el-form-item :label="translate('markdownPreview.watermarkText')" prop="watermarkText"
          ><el-input
            v-model="watermarkForm.watermarkText"
            :placeholder="translate('markdownPreview.watermarkPlaceholder')"
            maxlength="80"
            show-word-limit
        /></el-form-item>
      </el-form>
      <template #footer
        ><el-button @click="settingsOpen = false">{{ translate('common.cancel') }}</el-button
        ><el-button type="primary" @click="saveSettings">{{
          translate('common.save')
        }}</el-button></template
      >
    </el-dialog>
  </WorkspaceFilePageFrame>
</template>

<style scoped>
.file-preview-content {
  flex: 1;
}

.file-preview-content-code {
  overflow: hidden;
  padding: 0;
}

.file-preview-content-fallback {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0;
}

.file-preview-content-fallback > .empty {
  margin: 0;
  padding: 0.65rem 0.75rem;
}

.file-symbol-list {
  max-height: min(22rem, 50vh);
  margin-top: 0.5rem;
  overflow-x: hidden;
  overflow-y: auto;
}

.file-symbol-dropdown {
  position: absolute;
  z-index: 8;
  top: 3.5rem;
  right: 0.75rem;
  width: min(22rem, calc(100vw - 1.5rem));
  padding: 0.6rem;
  border: 1px solid var(--mar-border-medium);
  border-radius: 4px;
  background: var(--mar-bg-panel);
  box-shadow: var(--el-box-shadow-light);
}

.file-navigation-dropdown {
  max-height: min(42rem, calc(100vh - 5rem));
  overflow-x: hidden;
  overflow-y: auto;
}

.file-navigation-dropdown .file-symbol-list {
  max-height: none;
  overflow: visible;
}

.file-navigation-group {
  margin: 0.45rem -0.6rem 0;
  padding: 0.45rem 0.6rem 0;
  border-top: 1px solid var(--mar-border-subtle);
}

.file-navigation-group:first-of-type {
  margin-top: 0.2rem;
}

.file-navigation-group-title {
  margin: 0 0 0.2rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.file-navigation-group.is-definition .file-navigation-option {
  border-inline-start: 2px solid var(--mar-color-brand);
}

.file-navigation-group.is-reference .file-navigation-option {
  border-inline-start: 2px solid var(--mar-text-secondary);
}

.file-navigation-group.is-file .file-navigation-option {
  border-inline-start: 2px solid var(--mar-border-medium);
}

.file-symbol-list button {
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 2rem;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  border: 0;
  background: transparent;
  color: var(--mar-text-primary);
  cursor: pointer;
  text-align: left;
}

.file-symbol-list button > span {
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.file-symbol-list button:hover,
.file-symbol-list button.is-selected {
  background: var(--mar-fill-hover);
}

.file-navigation-option {
  display: grid !important;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start !important;
  column-gap: 0.5rem;
  padding: 0.4rem 0.45rem;
}

.file-navigation-path {
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.file-navigation-option small {
  padding-top: 0.05rem;
  white-space: nowrap;
}

.file-navigation-preview {
  grid-column: 1 / -1;
  min-width: 0;
  margin-top: 0.2rem;
  color: var(--mar-text-secondary);
  font-family: var(--mar-font-mono);
  font-size: var(--mar-font-size-meta);
  line-height: 1.45;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  word-break: break-word;
}

.file-symbol-list small,
.file-symbol-list p {
  color: var(--mar-text-secondary);
}

.file-binary-preview {
  display: block;
  width: 100%;
  min-height: 0;
  height: 100%;
  border: 1px solid var(--mar-border-medium);
  border-radius: 4px;
  background: var(--mar-bg-panel);
  object-fit: contain;
}

.file-audio-preview {
  display: block;
  width: min(680px, 100%);
  margin: min(18vh, 10rem) auto 0;
}

.file-pdf-preview {
  position: relative;
  height: 100%;
  min-height: 0;
}

.file-office-preview {
  position: relative;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  overflow: auto;
  border: 1px solid var(--mar-border-medium);
  border-radius: 4px;
  background: var(--mar-bg-panel);
}

.file-office-preview.is-spreadsheet {
  overflow: hidden;
}

.file-office-preview.is-presentation {
  container-type: size;
  overflow: hidden;
}

.file-spreadsheet-renderer,
.file-spreadsheet-renderer :deep(.vue-office-excel-main) {
  height: 100%;
  min-height: 0;
}

.file-presentation-renderer {
  width: min(100%, calc(100cqh * 16 / 9));
  height: 100%;
  margin: 0 auto;
}

.file-text-preview {
  display: block;
  width: 100%;
  flex: 1;
  min-height: 0;
  box-sizing: border-box;
  margin: 0;
  overflow: auto;
  padding: 0.75rem;
  background: var(--mar-bg-panel);
  color: var(--mar-text-primary);
  font-family: var(--mar-font-mono);
  font-size: 0.8125rem;
  line-height: 1.5;
  border: 0;
  border-radius: 0;
  outline: 0;
  resize: none;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
