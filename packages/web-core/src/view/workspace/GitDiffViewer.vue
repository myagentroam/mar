<script setup lang="ts">
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Close,
  Download,
  Search,
  Tickets
} from '@element-plus/icons-vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github.css';
import { translate } from '../../service/LocalePreferenceService.js';
import { inlineTextSearch } from '../../util/file-preview.js';
import {
  navigationTargetAtTextPosition,
  type CodeNavigationTarget
} from '../../util/code-navigation-target.js';
import { createMobilePreviewPinchZoom } from '../../util/mobile-preview-pinch-zoom.js';
import type { FileNavigationRequest } from './CodeFileEditor.vue';
import InlineFindBar from './InlineFindBar.vue';
import WorkspaceFilePageFrame from './WorkspaceFilePageFrame.vue';
import WorkspacePreviewContextMenu from './WorkspacePreviewContextMenu.vue';

const props = defineProps<{
  readonly path: string;
  readonly diff: unknown;
  readonly paths: readonly string[];
  readonly loading: boolean;
  readonly loadFailed?: boolean;
  readonly source?: 'WORKING_TREE' | 'HISTORY' | 'TOOL_CHANGE';
  readonly previewEnabled: boolean;
  readonly active?: boolean;
  readonly embedded?: boolean;
  readonly codeNavigationEnabled?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  download: [];
  moveFile: [direction: -1 | 1];
  preview: [];
  edit: [];
  navigateSymbol: [symbol: string];
  navigateFile: [request: FileNavigationRequest];
  retry: [];
}>();

interface DiffHunk {
  readonly addedLines: readonly number[];
  readonly deletedLines: readonly { readonly text: string; readonly insertBefore: number }[];
}

interface DiffRow {
  readonly kind: 'context' | 'added' | 'deleted';
  readonly lineNumber: number | null;
  readonly text: string;
  readonly diffIndex: number | undefined;
}

interface MinimapRow {
  readonly kind: 'context' | 'added' | 'deleted' | 'mixed';
  readonly html: string;
}
interface DiffNavigationTarget {
  readonly rowIndex: number;
  readonly target: CodeNavigationTarget;
}

const MAX_MINIMAP_ROWS = 180;

const activeDiffIndex = ref(-1);
const workingTreePane = ref<HTMLElement>();
const historyDiffPane = ref<HTMLElement>();
const findBar = ref<InstanceType<typeof InlineFindBar>>();
const findOpen = ref(false);
const findQuery = ref('');
const activeFindIndex = ref(0);
const workingTreeScrollTop = ref(0);
const workingTreeViewportHeight = ref(0);
const workingTreeScrollHeight = ref(0);
const workingTreeScrollbarWidth = ref(0);
const workingTreeScrollbarHeight = ref(0);
const minimap = ref<HTMLElement>();
const diffRoot = ref<{ readonly root: HTMLElement | undefined }>();
const contextMenu = ref<{ open(event: MouseEvent): Promise<void>; close(): void }>();
watch(
  () => props.active,
  (active) => {
    if (active === false) contextMenu.value?.close();
  }
);
const minimapDragging = ref(false);
const previewPinchZoom = createMobilePreviewPinchZoom();
let workingTreeResizeObserver: ResizeObserver | undefined;
const navigationTarget = ref<DiffNavigationTarget>();
const value = computed(() =>
  typeof props.diff === 'object' && props.diff !== null
    ? (props.diff as {
        readonly binary?: unknown;
        readonly text?: unknown;
        readonly summary?: unknown;
        readonly afterText?: unknown;
        readonly afterTruncated?: unknown;
      })
    : undefined
);
const diffText = computed(() => {
  if (typeof value.value?.text === 'string') return value.value.text;
  return typeof value.value?.summary === 'string' ? value.value.summary : '';
});
const hasUnifiedDiffText = computed(() => diffText.value.length > 0);
const historyDiffLineKinds = computed(() => historyDiffLineKindsFor(diffText.value));
const hasWorkingTreeText = computed(() => typeof value.value?.afterText === 'string');
const hasWorkingTreeFullText = computed(
  () => value.value?.binary !== true && hasWorkingTreeText.value
);
const afterLines = computed(() =>
  typeof value.value?.afterText === 'string' ? textLines(value.value.afterText) : []
);
const hunks = computed(() => parseDiffHunks(diffText.value));
const workingTreeRows = computed(() => {
  const deletedBefore = new Map<number, DiffRow[]>();
  hunks.value.forEach((hunk, diffIndex) => {
    for (const deleted of hunk.deletedLines) {
      const rows = deletedBefore.get(deleted.insertBefore) ?? [];
      rows.push({ kind: 'deleted', lineNumber: null, text: deleted.text, diffIndex });
      deletedBefore.set(deleted.insertBefore, rows);
    }
  });
  const rows: DiffRow[] = [];
  afterLines.value.forEach((text, index) => {
    const lineNumber = index + 1;
    rows.push(...(deletedBefore.get(lineNumber) ?? []));
    rows.push({
      kind: hunkIndexForAfterLine(lineNumber) === undefined ? 'context' : 'added',
      lineNumber,
      text,
      diffIndex: hunkIndexForAfterLine(lineNumber)
    });
  });
  rows.push(...(deletedBefore.get(afterLines.value.length + 1) ?? []));
  return rows;
});
const searchableLines = computed(() =>
  props.loading || props.loadFailed
    ? []
    : hasWorkingTreeFullText.value
      ? workingTreeRows.value.map((row) => row.text)
      : hasUnifiedDiffText.value && value.value?.binary !== true
        ? diffText.value.split('\n')
        : []
);
const findResult = computed(() => inlineTextSearch(searchableLines.value, findQuery.value));
const activeFindNumber = computed(() =>
  findResult.value.total === 0 ? 0 : activeFindIndex.value + 1
);
const findAvailable = computed(() => searchableLines.value.length > 0);
const activeDiffNumber = computed(() =>
  activeDiffIndex.value < 0 ? 0 : activeDiffIndex.value + 1
);
const currentFileNumber = computed(() => props.paths.findIndex((path) => path === props.path) + 1);
const minimapRows = computed(() => {
  if (!hasWorkingTreeFullText.value) return [];
  const rows = workingTreeRows.value;
  if (rows.length === 0) return [];
  const highlighted = highlightWorkingTree(afterLines.value.join('\n'), props.path);
  const bucketCount = Math.min(MAX_MINIMAP_ROWS, rows.length);
  return Array.from({ length: bucketCount }, (_, index): MinimapRow => {
    const start = Math.floor((index * rows.length) / bucketCount);
    const end = Math.floor(((index + 1) * rows.length) / bucketCount);
    const bucket = rows.slice(start, Math.max(start + 1, end));
    const hasAdded = bucket.some((row) => row.kind === 'added');
    const hasDeleted = bucket.some((row) => row.kind === 'deleted');
    const representative = bucket.find((row) => row.lineNumber !== null) ?? bucket[0];
    return {
      kind:
        hasAdded && hasDeleted ? 'mixed' : hasAdded ? 'added' : hasDeleted ? 'deleted' : 'context',
      html:
        representative?.lineNumber === null
          ? escapeHtml(representative.text)
          : (highlighted[(representative?.lineNumber ?? 1) - 1] ??
            escapeHtml(representative?.text ?? ''))
    };
  });
});
const minimapViewportStyle = computed(() => {
  const scrollableHeight = Math.max(
    0,
    workingTreeScrollHeight.value - workingTreeViewportHeight.value
  );
  const viewportRatio =
    workingTreeScrollHeight.value > 0
      ? Math.min(1, workingTreeViewportHeight.value / workingTreeScrollHeight.value)
      : 1;
  const height = Math.max(6, viewportRatio * 100);
  const top =
    scrollableHeight > 0 ? ((100 - height) * workingTreeScrollTop.value) / scrollableHeight : 0;
  return { height: `${height}%`, top: `${Math.min(100 - height, Math.max(0, top))}%` };
});
const minimapStyle = computed(() => ({
  right: `${workingTreeScrollbarWidth.value}px`,
  bottom: `${workingTreeScrollbarHeight.value}px`
}));

function textLines(value: string): readonly string[] {
  if (value.length === 0) return [];
  return value.endsWith('\n') ? value.slice(0, -1).split('\n') : value.split('\n');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function highlightWorkingTree(source: string, path: string): readonly string[] {
  const extension = path.split('.').at(-1)?.toLocaleLowerCase();
  const language =
    {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      vue: 'xml',
      html: 'xml',
      css: 'css',
      scss: 'scss',
      json: 'json',
      md: 'markdown',
      py: 'python',
      java: 'java',
      go: 'go',
      rs: 'rust',
      sh: 'bash',
      yml: 'yaml',
      yaml: 'yaml'
    }[extension ?? ''] ?? undefined;
  const highlighted =
    language !== undefined && hljs.getLanguage(language)
      ? hljs.highlight(source, { language, ignoreIllegals: true }).value
      : hljs.highlightAuto(source).value;
  return highlighted
    .split('\n')
    .map((line) => DOMPurify.sanitize(line, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'] }));
}

function parseDiffHunks(value: string): readonly DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current:
    | {
        beforeLine: number;
        afterLine: number;
        addedLines: number[];
        deletedLines: { text: string; insertBefore: number }[];
      }
    | undefined;
  const finishCurrent = (): void => {
    if (current === undefined) return;
    hunks.push({
      addedLines: current.addedLines,
      deletedLines: current.deletedLines
    });
  };
  for (const line of value.split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match !== null) {
      finishCurrent();
      current = {
        beforeLine: Number(match[1]),
        afterLine: Number(match[3]),
        addedLines: [],
        deletedLines: []
      };
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith('-') && !line.startsWith('---')) {
      current.deletedLines.push({ text: line.slice(1), insertBefore: current.afterLine });
      current.beforeLine += 1;
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.addedLines.push(current.afterLine);
      current.afterLine += 1;
      continue;
    }
    if (line.startsWith(' ')) {
      current.beforeLine += 1;
      current.afterLine += 1;
    }
  }
  finishCurrent();
  return hunks;
}

function historyDiffLineKindsFor(value: string): readonly (string | undefined)[] {
  let hunkPrefixWidth = 0;
  return value.split('\n').map((line) => {
    if (line.startsWith('diff ')) {
      hunkPrefixWidth = 0;
      return 'is-meta';
    }
    const hunk = /^(@{2,})\s/u.exec(line);
    if (hunk !== null) {
      const hunkPrefix = hunk[1];
      if (hunkPrefix === undefined) return 'is-meta';
      hunkPrefixWidth = hunkPrefix.length - 1;
      return 'is-hunk';
    }
    if (line.startsWith('\\ No newline')) return 'is-meta';
    if (hunkPrefixWidth > 0) {
      const prefixes = line.slice(0, hunkPrefixWidth);
      if (prefixes.includes('+') && prefixes.includes('-')) return 'is-mixed';
      if (prefixes.includes('+')) return 'is-added';
      if (prefixes.includes('-')) return 'is-deleted';
      return undefined;
    }
    if (/^\+\+\+\s/u.test(line)) return 'is-added';
    if (/^---\s/u.test(line)) return 'is-deleted';
    if (line.startsWith('index ') || line.startsWith('mode ') || line.startsWith('old mode ')) {
      return 'is-meta';
    }
    if (line.startsWith('new mode ') || line.startsWith('new file ')) return 'is-meta';
    if (line.startsWith('deleted file ') || line.startsWith('similarity ')) return 'is-meta';
    if (line.startsWith('dissimilarity ') || line.startsWith('rename ')) return 'is-meta';
    if (line.startsWith('copy ') || line.startsWith('Binary files ')) return 'is-meta';
    if (line.startsWith('GIT binary patch') || line.startsWith('literal ')) return 'is-meta';
    if (line.startsWith('delta ')) return 'is-meta';
    return undefined;
  });
}

function hunkIndexForAfterLine(line: number): number | undefined {
  const index = hunks.value.findIndex((hunk) => hunk.addedLines.includes(line));
  return index < 0 ? undefined : index;
}

function isActiveDiffRow(row: DiffRow): boolean {
  return row.diffIndex === activeDiffIndex.value;
}

function navigationSegments(row: DiffRow, rowIndex: number): readonly string[] {
  const active = navigationTarget.value;
  if (active?.rowIndex !== rowIndex) return [row.text];
  const { from, to } = active.target;
  return [row.text.slice(0, from), row.text.slice(from, to), row.text.slice(to)];
}

function diffRowForEvent(
  event: MouseEvent
): { readonly row: DiffRow; readonly index: number } | undefined {
  const element =
    event.target instanceof Element ? event.target.closest<HTMLElement>('[data-diff-row]') : null;
  const index = Number(element?.dataset.diffRow);
  const row = workingTreeRows.value[index];
  return Number.isSafeInteger(index) && row !== undefined ? { row, index } : undefined;
}

function textOffsetAtPoint(root: HTMLElement, event: MouseEvent): number | undefined {
  const documentWithCaret = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => CaretPosition | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = documentWithCaret.caretPositionFromPoint?.(event.clientX, event.clientY);
  const range =
    position === undefined
      ? documentWithCaret.caretRangeFromPoint?.(event.clientX, event.clientY)
      : position === null
        ? null
        : (() => {
            const value = document.createRange();
            value.setStart(position.offsetNode, position.offset);
            value.collapse(true);
            return value;
          })();
  if (range === null || range === undefined || !root.contains(range.startContainer))
    return undefined;
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

function targetAtEvent(event: MouseEvent): DiffNavigationTarget | undefined {
  if (
    props.codeNavigationEnabled !== true ||
    (!event.ctrlKey && !event.metaKey) ||
    event.altKey ||
    event.shiftKey
  )
    return undefined;
  const result = diffRowForEvent(event);
  if (result === undefined || result.row.lineNumber === null) return undefined;
  const content = (event.target as Element).closest<HTMLElement>('[data-diff-line-content]');
  if (content === null) return undefined;
  const offset = textOffsetAtPoint(content, event);
  if (offset === undefined) return undefined;
  const target = navigationTargetAtTextPosition(props.path, result.row.text, offset);
  return target === undefined ? undefined : { rowIndex: result.index, target };
}

function updateNavigationTarget(event: MouseEvent): void {
  navigationTarget.value = targetAtEvent(event);
}

function clearNavigationTarget(): void {
  navigationTarget.value = undefined;
}

function navigateAtEvent(event: MouseEvent): void {
  if (event.button !== 0) return;
  const target = targetAtEvent(event);
  if (target === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  navigationTarget.value = undefined;
  if (target.target.kind === 'symbol') {
    emit('navigateSymbol', target.target.value);
    return;
  }
  emit('navigateFile', {
    reference: target.target.reference,
    sourceContext: { text: targetAtEventText(event) ?? '', position: target.target.from }
  });
}

function targetAtEventText(event: MouseEvent): string | undefined {
  return diffRowForEvent(event)?.row.text;
}

async function focusDiff(index: number): Promise<void> {
  const count = hunks.value.length;
  if (count === 0) {
    activeDiffIndex.value = -1;
    return;
  }
  activeDiffIndex.value = (index + count) % count;
  await nextTick();
  workingTreePane.value
    ?.querySelector<HTMLElement>(`[data-diff-index="${activeDiffIndex.value}"]`)
    ?.scrollIntoView({ block: 'center' });
}

function moveDiff(direction: -1 | 1): void {
  void focusDiff(activeDiffIndex.value + direction);
}

function updateWorkingTreeMetrics(): void {
  const pane = workingTreePane.value;
  if (pane === undefined) return;
  workingTreeScrollTop.value = pane.scrollTop;
  workingTreeViewportHeight.value = pane.clientHeight;
  workingTreeScrollHeight.value = pane.scrollHeight;
  workingTreeScrollbarWidth.value = pane.offsetWidth - pane.clientWidth;
  workingTreeScrollbarHeight.value = pane.offsetHeight - pane.clientHeight;
}

function onMinimapPointerDown(event: PointerEvent): void {
  if (workingTreePane.value === undefined) return;
  minimapDragging.value = true;
  scrollWorkingTreeFromMinimap(event.clientY);
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}

function onMinimapPointerMove(event: PointerEvent): void {
  if (!minimapDragging.value) return;
  scrollWorkingTreeFromMinimap(event.clientY);
  event.preventDefault();
}

function scrollWorkingTreeFromMinimap(clientY: number): void {
  if (workingTreePane.value === undefined || minimap.value === undefined) return;
  const scrollableHeight = workingTreeScrollHeight.value - workingTreeViewportHeight.value;
  const viewportRatio =
    workingTreeScrollHeight.value > 0
      ? Math.min(1, workingTreeViewportHeight.value / workingTreeScrollHeight.value)
      : 1;
  const viewportHeight = minimap.value.clientHeight * Math.max(0.06, viewportRatio);
  const trackRange = minimap.value.clientHeight - viewportHeight;
  if (scrollableHeight <= 0 || trackRange <= 0) return;
  const pointerTop = clientY - minimap.value.getBoundingClientRect().top - viewportHeight / 2;
  workingTreePane.value.scrollTop =
    (Math.min(trackRange, Math.max(0, pointerTop)) / trackRange) * scrollableHeight;
  updateWorkingTreeMetrics();
}

function onMinimapPointerUp(event: PointerEvent): void {
  minimapDragging.value = false;
  const target = event.currentTarget as HTMLElement;
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
}

function onKeydown(event: KeyboardEvent): void {
  if (props.active === false) return;
  if (findOpen.value && event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeFind();
    return;
  }
  if ((event.target as HTMLElement | null)?.closest('input, textarea, [contenteditable="true"]'))
    return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    if (props.paths.length > 1 && !props.loading) emit('moveFile', -1);
    return;
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    if (props.paths.length > 1 && !props.loading) emit('moveFile', 1);
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveDiff(-1);
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveDiff(1);
  }
}

async function openFind(): Promise<void> {
  findOpen.value = true;
  await nextTick();
  await findBar.value?.focus();
}

function closeFind(): void {
  findOpen.value = false;
  focus();
}

function openInternalFind(): boolean {
  if (!findAvailable.value) return false;
  void openFind();
  return true;
}

function focus(): void {
  diffRoot.value?.root?.focus();
}

function selectAll(): boolean {
  const pane = hasWorkingTreeFullText.value ? workingTreePane.value : historyDiffPane.value;
  if (!findAvailable.value || pane === undefined || typeof window === 'undefined') return false;
  const selection = window.getSelection();
  if (selection === null) return false;
  selection.removeAllRanges();
  selection.selectAllChildren(pane);
  return true;
}

async function copySelection(): Promise<void> {
  const selection = window.getSelection();
  const root = diffRoot.value?.root;
  if (
    !selection ||
    selection.isCollapsed ||
    !root?.contains(selection.anchorNode) ||
    !root.contains(selection.focusNode)
  )
    return;
  try {
    await navigator.clipboard.writeText(selection.toString());
  } catch {
    ElMessage.error(translate('filePreviewContext.clipboardFailed'));
  }
}

function toggleEdit(): 'CHANGED' | 'UNAVAILABLE' {
  emit('edit');
  return 'CHANGED';
}

async function canClose(): Promise<boolean> {
  return true;
}

async function moveFind(direction: -1 | 1): Promise<void> {
  const total = findResult.value.total;
  if (total === 0) return;
  activeFindIndex.value = (activeFindIndex.value + direction + total) % total;
  await nextTick();
  const pane = hasWorkingTreeText.value ? workingTreePane.value : historyDiffPane.value;
  pane
    ?.querySelector<HTMLElement>(`[data-inline-find-index="${activeFindIndex.value}"]`)
    ?.scrollIntoView({ block: 'center', inline: 'nearest' });
}

watch(findQuery, () => {
  activeFindIndex.value = 0;
  void nextTick(() => {
    const pane = hasWorkingTreeText.value ? workingTreePane.value : historyDiffPane.value;
    pane
      ?.querySelector<HTMLElement>('[data-inline-find-index="0"]')
      ?.scrollIntoView({ block: 'center', inline: 'nearest' });
  });
});

watch(
  () => [props.path, props.diff],
  async () => {
    findOpen.value = false;
    findQuery.value = '';
    await focusDiff(0);
    await nextTick();
    updateWorkingTreeMetrics();
  },
  { immediate: true, flush: 'post' }
);
watch(
  () => props.active !== false,
  (active) => {
    if (typeof document === 'undefined' || props.embedded === true) return;
    document.documentElement.classList.toggle('file-preview-open', active);
    document.body.classList.toggle('file-preview-open', active);
  },
  { immediate: true }
);
onMounted(() => {
  if (props.active !== false) focus();
  updateWorkingTreeMetrics();
  if (workingTreePane.value !== undefined) {
    workingTreeResizeObserver = new ResizeObserver(updateWorkingTreeMetrics);
    workingTreeResizeObserver.observe(workingTreePane.value);
  }
});
onBeforeUnmount(() => {
  if (props.embedded !== true && props.active !== false) {
    document.documentElement.classList.remove('file-preview-open');
    document.body.classList.remove('file-preview-open');
  }
  workingTreeResizeObserver?.disconnect();
});
defineExpose({
  focus,
  openFind: openInternalFind,
  selectAll,
  toggleEdit,
  canClose
});
</script>

<template>
  <WorkspaceFilePageFrame
    ref="diffRoot"
    tabindex="-1"
    @keydown="onKeydown"
    :aria-modal="embedded ? undefined : true"
    :class="{ 'has-inline-find': findOpen, 'is-embedded': embedded }"
    :file-name="path.split('/').at(-1) ?? path"
    :path="path"
    :loading="props.loading"
    :source-label="
      translate(props.source === 'TOOL_CHANGE' ? 'presentation.thisChange' : 'common.gitDiff')
    "
    mobile-actions-layout="stacked"
    :mobile-actions-label="translate('generated.gitDiffViewer.diffPreviewActions')"
    :aria-label="`${path} ${translate(props.source === 'TOOL_CHANGE' ? 'presentation.thisChange' : 'common.gitDiff')}`"
  >
    <template #status>
      <div class="diff-mobile-summary" :aria-label="translate('gitDiffViewer.mobileSummary')">
        <span
          :title="translate('generated.gitDiffViewer.filesAvailable', { value0: paths.length })"
        >
          {{
            translate('gitDiffViewer.mobileFileSummary', {
              value0: currentFileNumber,
              value1: paths.length
            })
          }}
        </span>
        <span :title="translate('generated.gitDiffViewer.changes', { value0: hunks.length })">
          {{
            translate('gitDiffViewer.mobileChangeSummary', {
              value0: activeDiffNumber,
              value1: hunks.length
            })
          }}
        </span>
      </div>
    </template>
    <template #mobile-actions>
      <div class="diff-mobile-action-row diff-mobile-navigation">
        <el-button
          circle
          size="small"
          :disabled="props.paths.length < 2 || props.loading"
          :aria-label="translate('generated.gitDiffViewer.previousFile')"
          @click="emit('moveFile', -1)"
          ><el-icon><ArrowLeft /></el-icon
        ></el-button>
        <el-button
          circle
          size="small"
          :disabled="hunks.length === 0"
          :aria-label="translate('generated.gitDiffViewer.previousChange')"
          @click="moveDiff(-1)"
          ><el-icon><ArrowUp /></el-icon
        ></el-button>
        <el-button
          circle
          size="small"
          :disabled="hunks.length === 0"
          :aria-label="translate('generated.gitDiffViewer.nextChange')"
          @click="moveDiff(1)"
          ><el-icon><ArrowDown /></el-icon
        ></el-button>
        <el-button
          circle
          size="small"
          :disabled="props.paths.length < 2 || props.loading"
          :aria-label="translate('generated.gitDiffViewer.nextFile')"
          @click="emit('moveFile', 1)"
          ><el-icon><ArrowRight /></el-icon
        ></el-button>
      </div>
      <div class="diff-mobile-action-row diff-mobile-utilities">
        <el-button
          circle
          size="small"
          :aria-label="translate('fileEditor.openSource')"
          :title="translate('fileEditor.openSourceShortcut')"
          @click="toggleEdit"
          ><el-icon><Tickets /></el-icon
        ></el-button>
        <el-button
          v-if="findAvailable"
          circle
          size="small"
          :aria-label="translate('inlineFind.label')"
          @click="openInternalFind"
          ><el-icon><Search /></el-icon
        ></el-button>
        <el-button
          :aria-label="translate('generated.gitDiffViewer.downloadDiff')"
          circle
          size="small"
          @click="emit('download')"
        >
          <el-icon><Download /></el-icon>
        </el-button>
        <el-button
          v-if="!embedded"
          :aria-label="translate('generated.gitDiffViewer.closeDiffPreview2')"
          circle
          size="small"
          type="primary"
          @click="emit('close')"
        >
          <el-icon><Close /></el-icon>
        </el-button>
      </div>
    </template>
    <template #primary-actions>
      <div
        class="file-preview-actions diff-preview-toolbar"
        :aria-label="translate('generated.gitDiffViewer.diffToolbar')"
      >
        <el-button
          circle
          size="small"
          :aria-label="translate('fileEditor.openSource')"
          :title="translate('fileEditor.openSourceShortcut')"
          @click="toggleEdit"
          ><el-icon><Tickets /></el-icon
        ></el-button>
        <el-button
          :disabled="paths.length < 2 || loading"
          :aria-label="translate('generated.gitDiffViewer.previousFile')"
          circle
          size="small"
          :title="translate('generated.gitDiffViewer.previousFile2')"
          @click="emit('moveFile', -1)"
        >
          <el-icon><ArrowLeft /></el-icon>
        </el-button>
        <span
          class="diff-toolbar-count"
          :title="translate('generated.gitDiffViewer.filesAvailable', { value0: paths.length })"
        >
          {{ currentFileNumber }} / {{ paths.length }}
        </span>
        <el-button
          :disabled="paths.length < 2 || loading"
          :aria-label="translate('generated.gitDiffViewer.nextFile')"
          circle
          size="small"
          :title="translate('generated.gitDiffViewer.nextFile2')"
          @click="emit('moveFile', 1)"
        >
          <el-icon><ArrowRight /></el-icon>
        </el-button>
        <span class="diff-toolbar-divider" aria-hidden="true" />
        <el-button
          :disabled="hunks.length === 0"
          :aria-label="translate('generated.gitDiffViewer.previousChange')"
          circle
          size="small"
          :title="translate('generated.gitDiffViewer.previousChange2')"
          @click="moveDiff(-1)"
        >
          <el-icon><ArrowUp /></el-icon>
        </el-button>
        <span
          class="diff-toolbar-count"
          :title="translate('generated.gitDiffViewer.changes', { value0: hunks.length })"
        >
          {{ activeDiffNumber }} / {{ hunks.length }}
        </span>
        <el-button
          :disabled="hunks.length === 0"
          :aria-label="translate('generated.gitDiffViewer.nextChange')"
          circle
          size="small"
          :title="translate('generated.gitDiffViewer.nextChange2')"
          @click="moveDiff(1)"
        >
          <el-icon><ArrowDown /></el-icon>
        </el-button>
        <el-button
          v-if="!embedded"
          class="diff-close-button"
          :aria-label="translate('generated.gitDiffViewer.closeDiffPreview')"
          circle
          size="small"
          type="primary"
          @click="emit('close')"
        >
          <el-icon><Close /></el-icon>
        </el-button>
      </div>
    </template>
    <InlineFindBar
      v-if="findOpen && findAvailable"
      ref="findBar"
      v-model="findQuery"
      :current="activeFindNumber"
      :total="findResult.total"
      :truncated="findResult.truncated"
      @previous="moveFind(-1)"
      @next="moveFind(1)"
      @close="closeFind"
    />
    <main
      class="file-preview-content unified-diff-content"
      @click="focus"
      @contextmenu="contextMenu?.open($event)"
    >
      <template v-if="!props.loading">
        <section v-if="props.loadFailed" class="diff-state-message">
          <p>{{ translate('generated.gitDiffViewer.gitDiffLoadFailed') }}</p>
          <el-button type="primary" @click="emit('retry')">
            {{ translate('generated.gitDiffViewer.retry') }}
          </el-button>
        </section>
        <section v-else-if="value?.binary === true" class="binary-diff-preview">
          <p>{{ translate('generated.gitDiffViewer.binaryFilesDoNotSupportDiff') }}</p>
          <el-button
            type="primary"
            :disabled="!previewEnabled"
            :title="
              previewEnabled
                ? undefined
                : translate('generated.gitDiffViewer.filePreviewRequiresNewerNode')
            "
            @click="emit('preview')"
          >
            {{ translate('generated.gitDiffViewer.openFilePreview') }}
          </el-button>
        </section>
        <section v-else-if="hasWorkingTreeFullText" class="unified-diff-pane">
          <small v-if="value?.afterTruncated === true" class="unified-diff-truncation">{{
            translate('generated.gitDiffViewer.showingTheFirst512KiB')
          }}</small>
          <pre
            ref="workingTreePane"
            class="unified-diff-code"
            :aria-label="translate('generated.gitDiffViewer.fullWorkingTreeFile')"
            :style="previewPinchZoom.style.value"
            @scroll="updateWorkingTreeMetrics"
            @pointerdown="previewPinchZoom.pointerDown"
            @pointermove="previewPinchZoom.pointerMove"
            @pointerup="previewPinchZoom.pointerEnd"
            @pointercancel="previewPinchZoom.pointerEnd"
          ><code v-if="workingTreeRows.length > 0"><span v-for="(row, index) in workingTreeRows" :key="index" :class="['unified-diff-line', `is-${row.kind}`, { 'is-active': isActiveDiffRow(row) }]" :data-diff-index="row.diffIndex" :data-diff-row="index"><span class="unified-diff-line-number">{{ row.lineNumber ?? '−' }}</span><span class="unified-diff-line-prefix">{{ row.kind === 'deleted' ? '−' : row.kind === 'added' ? '+' : ' ' }}</span><span class="unified-diff-line-content" data-diff-line-content @mousedown="navigateAtEvent" @mousemove="updateNavigationTarget" @mouseleave="clearNavigationTarget"><template v-if="findOpen && findQuery"><template v-for="(segment, segmentIndex) in findResult.lines[index]" :key="segmentIndex"><mark v-if="segment.matchIndex !== undefined" :class="{ 'is-current': segment.matchIndex === activeFindIndex }" :data-inline-find-index="segment.matchIndex">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></template><template v-else-if="navigationTarget?.rowIndex === index"><template v-for="(segment, segmentIndex) in navigationSegments(row, index)" :key="segmentIndex"><span v-if="segmentIndex === 1" class="diff-code-navigation-target">{{ segment }}</span><template v-else>{{ segment }}</template></template></template><template v-else>{{ row.text }}</template></span></span></code><span v-else class="unified-diff-empty">{{ translate('generated.gitDiffViewer.emptyFile') }}</span></pre>
        </section>
        <template v-else-if="hasUnifiedDiffText">
          <p
            v-if="props.source !== 'HISTORY' && props.source !== 'TOOL_CHANGE'"
            class="diff-fallback-message"
          >
            {{ translate('generated.gitDiffViewer.theCurrentNodeDidNotReturnThe') }}
          </p>
          <pre
            ref="historyDiffPane"
            class="unified-history-diff"
          ><code><span v-for="(line, index) in diffText.split('\n')" :key="index" :class="historyDiffLineKinds[index]"><template v-if="findOpen && findQuery"><template v-for="(segment, segmentIndex) in findResult.lines[index]" :key="segmentIndex"><mark v-if="segment.matchIndex !== undefined" :class="{ 'is-current': segment.matchIndex === activeFindIndex }" :data-inline-find-index="segment.matchIndex">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></template><template v-else>{{ line }}</template></span></code></pre>
        </template>
        <p v-else class="diff-state-message">
          {{ translate('generated.gitDiffViewer.gitDiffHasNoDisplayableTextContent') }}
        </p>
        <aside
          v-if="hasWorkingTreeFullText && minimapRows.length"
          ref="minimap"
          class="diff-minimap"
          :class="{ 'is-dragging': minimapDragging }"
          :aria-label="translate('generated.gitDiffViewer.diffCodeMinimap')"
          :style="minimapStyle"
          @pointerdown="onMinimapPointerDown"
          @pointermove="onMinimapPointerMove"
          @pointerup="onMinimapPointerUp"
          @pointercancel="onMinimapPointerUp"
        >
          <div class="diff-minimap-content" aria-hidden="true">
            <span
              v-for="(row, index) in minimapRows"
              :key="index"
              class="diff-minimap-row"
              :class="`is-${row.kind}`"
              ><span v-html="row.html"
            /></span>
          </div>
          <span class="diff-minimap-viewport" aria-hidden="true" :style="minimapViewportStyle" />
        </aside>
      </template>
    </main>
    <WorkspacePreviewContextMenu
      ref="contextMenu"
      :paste-enabled="false"
      @copy="copySelection"
      @reload="emit('retry')"
    />
  </WorkspaceFilePageFrame>
</template>

<style scoped>
.unified-diff-content mark {
  border-radius: 2px;
  background: var(--mar-color-warning-bg);
  color: inherit;
}
.unified-diff-content mark.is-current {
  background: var(--mar-color-warning-text);
  color: var(--mar-bg-panel);
}
.diff-preview-toolbar {
  align-items: center;
}
.binary-diff-preview {
  place-self: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  color: var(--mar-text-secondary);
  text-align: center;
}
.diff-state-message {
  place-self: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  color: var(--mar-text-secondary);
  text-align: center;
}
.diff-fallback-message {
  margin: 0;
  border-bottom: 1px solid var(--mar-border-medium);
  background: var(--mar-fill-subtle);
  padding: 0.55rem 0.75rem;
  color: var(--mar-text-secondary);
  font-size: 0.78rem;
}
.diff-toolbar-count {
  min-width: 2.65rem;
  color: var(--mar-text-secondary);
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
  font-size: 0.72rem;
  text-align: center;
  white-space: nowrap;
}
.diff-toolbar-divider {
  width: 1px;
  height: 1.3rem;
  margin: 0 0.1rem;
  background: var(--mar-border-medium);
}
.diff-mobile-summary {
  display: none;
}
.unified-diff-content {
  position: relative;
  display: grid;
  min-width: 0;
  min-height: 0;
  flex: 1;
  overflow: hidden;
  padding: 0;
}
.unified-diff-content > .empty,
.unified-diff-content > pre {
  margin: 1rem;
}
.unified-history-diff code {
  display: block;
  width: max-content;
  min-width: 100%;
}
.unified-history-diff code > span {
  display: block;
}
.unified-history-diff code > .is-added {
  background: var(--mar-color-success-bg);
  color: var(--mar-color-diff-add-text) !important;
}
.unified-history-diff code > .is-deleted {
  background: var(--mar-color-danger-bg);
  color: var(--mar-color-diff-del-text) !important;
}
.unified-history-diff code > .is-hunk,
.unified-history-diff code > .is-meta {
  color: var(--mar-color-brand-text);
}
.unified-history-diff code > .is-mixed {
  background: var(--mar-fill-hover);
  color: var(--mar-color-brand-text);
}
.unified-diff-pane {
  position: relative;
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-rows: minmax(0, 1fr);
  background: var(--mar-bg-panel);
}
.unified-diff-truncation {
  position: absolute;
  z-index: 2;
  top: 0.4rem;
  right: 6rem;
  border: 1px solid var(--mar-border-medium);
  border-radius: 3px;
  background: var(--mar-bg-panel);
  padding: 0.2rem 0.4rem;
  color: var(--mar-text-tertiary);
  font-size: 0.66rem;
  font-weight: 500;
}
.file-preview-content pre.unified-diff-code {
  min-width: 0;
  min-height: 0;
  margin: 0;
  overflow: auto;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  padding: 0.55rem 5.5rem 0.55rem 0;
  font-size: 0.76rem;
  line-height: 1.65;
}
.diff-minimap {
  position: absolute;
  z-index: 1;
  top: 0;
  right: 0;
  bottom: 0;
  box-sizing: border-box;
  width: 5.5rem;
  overflow: hidden;
  border-left: 1px solid var(--mar-border-medium);
  background: color-mix(in srgb, var(--mar-fill-subtle) 92%, transparent);
  padding: 0.55rem 0.45rem;
  cursor: grab;
  touch-action: none;
  user-select: none;
  font:
    5px/1.65 'SFMono-Regular',
    Consolas,
    'Liberation Mono',
    monospace;
}
.diff-minimap.is-dragging {
  cursor: grabbing;
}
.diff-minimap-content {
  display: grid;
  height: 100%;
  grid-template-rows: repeat(v-bind('minimapRows.length'), minmax(0, 1fr));
  overflow: hidden;
}
.diff-minimap-row {
  display: block;
  min-width: 0;
  overflow: hidden;
  color: var(--mar-text-tertiary);
  opacity: 0.42;
  white-space: pre;
}
.diff-minimap-row.is-added {
  background: rgb(46 160 67 / 52%);
}
.diff-minimap-row.is-deleted {
  background: rgb(248 81 73 / 48%);
}
.diff-minimap-row.is-mixed {
  background: linear-gradient(to bottom, rgb(248 81 73 / 48%) 0 50%, rgb(46 160 67 / 52%) 50% 100%);
}
.diff-minimap-row > span {
  display: block;
  min-width: max-content;
  transform: scaleX(0.8);
  transform-origin: left center;
}
.diff-minimap-viewport {
  position: absolute;
  right: 0;
  left: 0;
  border: 1px solid var(--mar-text-secondary);
  background: rgb(87 96 106 / 48%);
  box-shadow: 0 0 0 1px rgb(27 31 36 / 34%);
  pointer-events: none;
}
.unified-diff-code code {
  display: block;
  min-width: max-content;
}
.unified-diff-line {
  display: grid;
  grid-template-columns: 3.5rem 1.2rem minmax(0, 1fr);
  min-height: 1.65em;
  scroll-margin-block: 8rem;
}
.unified-diff-line-number,
.unified-diff-line-prefix {
  user-select: none;
  color: var(--mar-text-faint);
  text-align: right;
}
.unified-diff-line-number {
  padding-right: 0.8rem;
}
.unified-diff-line-prefix {
  padding-right: 0.35rem;
}
.unified-diff-line-content {
  min-width: 0;
  border-left: 1px solid var(--mar-fill-hover);
  padding: 0 1rem;
}

.diff-code-navigation-target {
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: var(--mar-color-brand);
  text-decoration-thickness: 1px;
  text-underline-offset: 0.14em;
}
.unified-diff-line.is-deleted {
  background: var(--mar-color-danger-bg);
  color: var(--mar-color-diff-del-text);
}
.unified-diff-line.is-added {
  background: var(--mar-color-success-bg);
  color: var(--mar-color-diff-add-text);
}
.unified-diff-line.is-active {
  box-shadow:
    inset 3px 0 var(--mar-color-brand),
    inset 0 1px var(--mar-color-brand),
    inset 0 -1px var(--mar-color-brand);
}
.unified-diff-empty {
  display: block;
  padding: 0.55rem 1rem;
  color: var(--mar-text-tertiary);
}
@media (max-width: 767px) {
  .diff-preview-toolbar {
    display: none;
  }

  .diff-close-button {
    display: none;
  }
  .diff-mobile-summary {
    display: flex;
    gap: 0.55rem;
    margin-top: 0.2rem;
    color: var(--mar-text-secondary);
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
    font-size: 0.62rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .file-preview-content pre.unified-diff-code {
    padding-right: 4rem;
    touch-action: pan-x pan-y;
    font-size: calc(0.76rem * var(--mar-preview-zoom, 1));
  }
  .diff-minimap {
    width: 4rem;
  }
  .diff-mobile-action-row {
    display: flex;
    gap: 0.35rem;
    justify-content: flex-end;
  }
  .diff-mobile-action-row + .diff-mobile-action-row {
    border-top: 1px solid var(--mar-border-medium);
    padding-top: 0.25rem;
  }
  .diff-mobile-action-row :deep(.el-button + .el-button) {
    margin-left: 0;
  }
}
</style>
