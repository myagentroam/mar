<script setup lang="ts">
import '@myagentroam/mar-ui/disclosure.css';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarInput } from '@myagentroam/mar-ui/input';
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { NodeSummary, Session, WorkspaceTab } from '../../model/workbench.js';
import {
  createQuickOpenQueryService,
  type QuickOpenTab,
  sortQuickOpenCandidates,
  type QuickOpenCandidate,
  type QuickOpenSessionCandidate,
  type QuickOpenSourceStatus
} from '../../service/quick-open-service.js';
import { createScopedHttpService } from '../../service/scoped-http-service.js';
import { WORKBENCH_HTTP_KEY } from '../../service/workbench-http-service.js';
import { translate } from '../../service/locale-preference-service.js';
import { consoleKeyboardShortcutService } from '../../service/console-keyboard-shortcut-service.js';
import { fileKeys } from '../../service/console-shortcut-keys.js';
import { workspaceFileTarget } from '../../util/file-preview.js';
import { errorMessage } from '../../util/error-presentation.js';
import FileTypeIcon from './FileTypeIcon.vue';

const props = defineProps<{
  readonly open: boolean;
  readonly nodeId: string | undefined;
  readonly workspaceId: string | undefined;
  readonly filesReady: boolean;
  readonly symbolsReady: boolean;
  readonly nodes: readonly NodeSummary[];
  readonly sessions: readonly Session[];
  readonly sessionTitle: (session: Session) => string;
  readonly openSession: (sessionId: string) => Promise<void>;
  readonly openWorkspace: (nodeId: string, workspaceId: string) => Promise<boolean>;
  readonly workspaceTabs: readonly WorkspaceTab[];
}>();
const emit = defineEmits<{
  close: [selected?: boolean];
  openFile: [path: string, line: number | undefined, column: number | undefined, external: boolean];
}>();
const dialog = ref<InstanceType<typeof MarDialog>>();
const input = ref<InstanceType<typeof MarInput>>();
const results = ref<HTMLUListElement>();
const tab = ref<QuickOpenTab>('ALL');
const query = ref('');
const activeKey = ref<string>();
const selectionCommitted = ref(false);
const dismissing = ref(false);
const http = inject(WORKBENCH_HTTP_KEY, undefined) ?? createScopedHttpService();
const queryService = createQuickOpenQueryService({
  open: () => props.open && !dismissing.value,
  query: () => query.value,
  tab: () => tab.value,
  nodeId: () => props.nodeId,
  workspaceId: () => props.workspaceId,
  filesReady: () => props.filesReady,
  symbolsReady: () => props.symbolsReady,
  nodes: () => props.nodes,
  workspaceTabs: () => props.workspaceTabs,
  origin: () => (typeof window === 'undefined' ? 'http://localhost' : window.location.origin),
  http
});
const { workspaces, files, symbols, workspaceStatus, fileStatus, symbolStatus, referenceStatus } =
  queryService;
const scheduleSearch = () => {
  if (!dismissing.value) queryService.scheduleSearch();
};
const loadWorkspaces = queryService.loadWorkspaces;
const busy = (source: QuickOpenSourceStatus) =>
  source.phase === 'SEARCHING' || source.phase === 'BUILDING';
const workspaceLoading = computed(() => busy(workspaceStatus));
const fileLoading = computed(() => busy(fileStatus));
const symbolLoading = computed(() => busy(symbolStatus));
const rankingQuery = computed(() => {
  const location = workspaceFileTarget(
    query.value.trim(),
    undefined,
    typeof window === 'undefined' ? 'http://localhost' : window.location.origin
  );
  return location?.path ?? query.value;
});
const sessionEntries = computed<QuickOpenSessionCandidate[]>(() =>
  props.sessions.map((session, index) => ({
    kind: 'SESSION',
    key: `session\0${session.id}`,
    sessionId: session.id,
    title: props.sessionTitle(session),
    runner: session.runner,
    stableIndex: index
  }))
);

const entries = computed<QuickOpenCandidate[]>(() => {
  const workspaceEntries = sortQuickOpenCandidates(workspaces.value, rankingQuery.value);
  const fileEntries = sortQuickOpenCandidates(files.value, rankingQuery.value);
  const symbolEntries = sortQuickOpenCandidates(symbols.value, rankingQuery.value);
  const sessions = sortQuickOpenCandidates(sessionEntries.value, rankingQuery.value);
  if (tab.value === 'WORKSPACE') return workspaceEntries;
  if (tab.value === 'SESSION') return sessions;
  if (tab.value === 'SYMBOL') return symbolEntries;
  if (tab.value === 'FILE') return fileEntries;
  return sortQuickOpenCandidates(
    [...workspaceEntries, ...sessions, ...symbolEntries, ...fileEntries],
    rankingQuery.value
  );
});
const activeIndex = computed(() => {
  const index = entries.value.findIndex((entry) => entry.key === activeKey.value);
  return index < 0 ? 0 : index;
});
const loading = computed(
  () =>
    ((tab.value === 'ALL' || tab.value === 'WORKSPACE') && workspaceLoading.value) ||
    ((tab.value === 'ALL' || tab.value === 'FILE') && fileLoading.value) ||
    ((tab.value === 'ALL' || tab.value === 'SYMBOL') && symbolLoading.value)
);
const statusNotices = computed(() => {
  const values: Array<{
    readonly kind: string;
    readonly label: string;
    readonly status: QuickOpenSourceStatus;
  }> = [];
  if (tab.value === 'ALL' || tab.value === 'WORKSPACE')
    values.push({
      kind: 'WORKSPACE',
      label: 'generated.quickOpenDialog.workspace',
      status: workspaceStatus
    });
  if (tab.value === 'ALL' || tab.value === 'FILE')
    values.push({ kind: 'FILE', label: 'generated.quickOpenDialog.file', status: fileStatus });
  if (tab.value === 'ALL' || tab.value === 'SYMBOL')
    values.push(
      { kind: 'SYMBOL', label: 'generated.quickOpenDialog.definition', status: symbolStatus },
      { kind: 'REFERENCE', label: 'generated.quickOpenDialog.reference', status: referenceStatus }
    );
  return values.filter(
    ({ status }) => status.phase !== 'IDLE' && (status.phase !== 'READY' || status.truncated)
  );
});

function statusText(status: QuickOpenSourceStatus): string {
  if (status.phase === 'READY' && status.truncated)
    return translate('generated.quickOpenDialog.incomplete');
  const keys = {
    IDLE: 'generated.quickOpenDialog.searching',
    READY: 'generated.quickOpenDialog.searching',
    SEARCHING: 'generated.quickOpenDialog.searching',
    BUILDING: 'generated.quickOpenDialog.preparing',
    FAILED: 'generated.quickOpenDialog.failed',
    UNAVAILABLE: 'generated.quickOpenDialog.unavailable',
    LIMITED: 'fileEditor.navigationLimited',
    TIMED_OUT: 'generated.quickOpenDialog.timedOut',
    INVALID: 'generated.quickOpenDialog.completeSymbolRequired'
  } as const;
  return translate(keys[status.phase]);
}

function retrySource(kind: string): void {
  if (kind === 'WORKSPACE') void loadWorkspaces();
  else scheduleSearch();
}

watch(entries, (values) => {
  if (values.length === 0) activeKey.value = undefined;
  else if (!values.some((entry) => entry.key === activeKey.value)) activeKey.value = values[0]?.key;
});
watch(
  () => props.open,
  (open) => {
    if (!open) {
      cancelSearch();
      return;
    }
    tab.value = 'ALL';
    query.value = '';
    selectionCommitted.value = false;
    dismissing.value = false;
    files.value = [];
    symbols.value = [];
    activeKey.value = undefined;
    void loadWorkspaces();
  }
);
watch(query, scheduleSearch);
watch(tab, () => {
  activeKey.value = entries.value[0]?.key;
  scheduleSearch();
});
watch(
  [() => props.nodeId, () => props.workspaceId, () => props.filesReady, () => props.symbolsReady],
  scheduleSearch
);

function cancelSearch(): void {
  queryService.cancel();
}

function onDismissStart(): void {
  dismissing.value = true;
  // Abort immediately without changing the content or layout as the dialog fades out.
  queryService.cancel({ preserveStatus: true });
}

function onVisibilityChange(): void {
  if (dismissing.value) return;
  if (document.visibilityState === 'hidden') cancelSearch();
  else if (props.open) {
    void loadWorkspaces();
    scheduleSearch();
  }
}
let unregisterShortcuts: (() => void)[] = [];
onMounted(() => {
  const owner = () => input.value?.input?.closest('[role="dialog"]') ?? undefined;
  unregisterShortcuts = [
    consoleKeyboardShortcutService.register({
      command: 'quickOpen.choose',
      scope: 'overlay',
      priority: 130,
      owner: () => input.value?.input ?? undefined,
      keys: fileKeys.choose,
      when: () =>
        props.open &&
        !dismissing.value &&
        !selectionCommitted.value &&
        entries.value[activeIndex.value] !== undefined,
      execute: (event) => {
        choose(undefined, event.ctrlKey || event.metaKey);
        return 'HANDLED';
      }
    }),
    consoleKeyboardShortcutService.register({
      command: 'quickOpen.dismiss',
      scope: 'overlay',
      priority: 130,
      owner,
      keys: fileKeys.dismiss,
      when: () => props.open,
      execute: () => {
        dialog.value?.handleClose();
        return 'HANDLED';
      }
    })
  ];
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function')
    document.addEventListener('visibilitychange', onVisibilityChange);
});
onBeforeUnmount(() => {
  unregisterShortcuts.forEach((release) => release());
  queryService.dispose();
  if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function')
    document.removeEventListener('visibilitychange', onVisibilityChange);
});

function choose(entry = entries.value[activeIndex.value], external = false): void {
  if (entry === undefined || dismissing.value || selectionCommitted.value) return;
  if (
    (entry.kind === 'FILE' || entry.kind === 'SYMBOL') &&
    (entry.nodeId !== props.nodeId || entry.workspaceId !== props.workspaceId)
  )
    return;
  selectionCommitted.value = true;
  emit('close', true);
  if (entry.kind === 'FILE' || entry.kind === 'SYMBOL') {
    emit('openFile', entry.path, entry.line, entry.column, external);
    return;
  }
  if (entry.kind === 'SESSION') {
    void props.openSession(entry.sessionId);
    return;
  }
  void props.openWorkspace(entry.nodeId, entry.workspaceId);
}

function entryName(entry: QuickOpenCandidate): string {
  switch (entry.kind) {
    case 'WORKSPACE':
      return entry.workspaceLabel;
    case 'SESSION':
      return entry.title;
    case 'FILE':
      return entry.name;
    case 'SYMBOL':
      return entry.symbol;
  }
}

function entryContext(entry: QuickOpenCandidate): string | undefined {
  if (entry.kind === 'WORKSPACE') return entry.nodeLabel;
  if (entry.kind === 'SESSION') return entry.runner;
  if (entry.kind === 'SYMBOL') return entry.detail;
}

function overflowedEntryText(index: number): string | undefined {
  const labels = results.value?.children[index]?.querySelectorAll<HTMLElement>(
    '.entry-name, .entry-context, .entry-path'
  );
  if (!labels) return undefined;
  return (
    [...labels]
      .filter((label) => label.clientWidth > 0 && label.scrollWidth > label.clientWidth)
      .map((label) => label.textContent?.trim())
      .filter(Boolean)
      .join('\n') || undefined
  );
}

function highlightedPath(
  path: string
): readonly { readonly text: string; readonly matched: boolean }[] {
  const location = workspaceFileTarget(
    query.value.trim(),
    undefined,
    typeof window === 'undefined' ? 'http://localhost' : window.location.origin
  );
  const terms = (location?.path ?? query.value.trim())
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
  const source = path.toLocaleLowerCase();
  const matched = new Set<number>();
  for (const term of terms) {
    let cursor = 0;
    const positions: number[] = [];
    for (const character of term) {
      const index = source.indexOf(character, cursor);
      if (index < 0) {
        positions.length = 0;
        break;
      }
      positions.push(index);
      cursor = index + 1;
    }
    for (const index of positions) matched.add(index);
  }
  const fragments: { text: string; matched: boolean }[] = [];
  for (let index = 0; index < path.length; index += 1) {
    const next = { text: path[index] ?? '', matched: matched.has(index) };
    const previous = fragments.at(-1);
    if (previous?.matched === next.matched) previous.text += next.text;
    else fragments.push(next);
  }
  return fragments;
}

function selectActiveEntry(key: string | undefined): void {
  activeKey.value = key;
  void nextTick(() => {
    results.value
      ?.querySelector<HTMLElement>('li[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'ArrowDown' && entries.value.length > 0) {
    event.preventDefault();
    selectActiveEntry(entries.value[(activeIndex.value + 1) % entries.value.length]?.key);
  } else if (event.key === 'ArrowUp' && entries.value.length > 0) {
    event.preventDefault();
    selectActiveEntry(
      entries.value[(activeIndex.value - 1 + entries.value.length) % entries.value.length]?.key
    );
  }
}
</script>

<template>
  <MarDialog
    v-if="open"
    ref="dialog"
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    :model-value="open"
    :title="translate('generated.quickOpenDialog.quickOpen')"
    class="quick-open-dialog"
    :class="{ 'has-status-notices': statusNotices.length > 0 }"
    width="min(680px, calc(100vw - 32px))"
    :show-close="false"
    @close="onDismissStart"
    @closed="emit('close')"
    @focus.once="input?.focus({ preventScroll: true })"
  >
    <div
      class="quick-open-tabs"
      role="group"
      :aria-label="translate('generated.quickOpenDialog.resultTypes')"
    >
      <button
        v-for="candidateTab in ['ALL', 'WORKSPACE', 'SESSION', 'FILE', 'SYMBOL'] as const"
        :key="candidateTab"
        type="button"
        :aria-pressed="tab === candidateTab"
        @click="tab = candidateTab"
      >
        {{
          translate(
            `generated.quickOpenDialog.${candidateTab.toLocaleLowerCase()}` as 'generated.quickOpenDialog.all'
          )
        }}
      </button>
    </div>
    <MarInput
      ref="input"
      v-model="query"
      class="quick-open-input"
      :aria-label="translate('generated.quickOpenDialog.quickOpen')"
      autocomplete="off"
      :placeholder="translate('generated.quickOpenDialog.enterANameOrPath')"
      @keydown="onKeydown"
    />
    <ul v-if="entries.length > 0" ref="results" class="quick-open-results" role="listbox">
      <li
        v-for="(entry, index) in entries"
        :key="entry.key"
        role="option"
        :aria-selected="index === activeIndex"
      >
        <button
          type="button"
          v-tooltip="() => overflowedEntryText(index)"
          @click="choose(entry, $event.ctrlKey || $event.metaKey)"
        >
          <FileTypeIcon :name="entry.kind === 'SYMBOL' ? entry.path : entryName(entry)" />
          <span class="entry-main">
            <span class="entry-heading">
              <span class="entry-name">
                <span
                  v-for="(fragment, fragmentIndex) in highlightedPath(entryName(entry))"
                  :key="fragmentIndex"
                  :class="{ 'quick-open-match': fragment.matched }"
                  >{{ fragment.text }}</span
                >
              </span>
              <small v-if="entryContext(entry)" class="entry-context">{{
                entryContext(entry)
              }}</small>
            </span>
            <code v-if="entry.kind !== 'SESSION'" class="entry-path"
              ><span
                v-for="(fragment, fragmentIndex) in highlightedPath(entry.path)"
                :key="fragmentIndex"
                :class="{ 'quick-open-match': fragment.matched }"
                >{{ fragment.text }}</span
              ><span v-if="entry.kind === 'SYMBOL'"
                >:{{ entry.line }}{{ entry.column === undefined ? '' : `:${entry.column}` }}</span
              ></code
            >
          </span>
          <span class="entry-kind">{{
            translate(
              entry.kind === 'SYMBOL'
                ? entry.source === 'DEFINITION'
                  ? 'generated.quickOpenDialog.definition'
                  : 'generated.quickOpenDialog.reference'
                : entry.kind === 'FILE'
                  ? 'generated.quickOpenDialog.file'
                  : entry.kind === 'SESSION'
                    ? 'generated.quickOpenDialog.session'
                    : 'generated.quickOpenDialog.workspace'
            )
          }}</span>
        </button>
      </li>
    </ul>
    <p v-else-if="loading" class="mar-empty" role="status">
      <MarIcon name="loading-action" /> {{ translate('generated.quickOpenDialog.searching') }}
    </p>
    <p v-else-if="statusNotices.length === 0" class="mar-empty">
      {{ translate('generated.quickOpenDialog.noMatches') }}
    </p>
    <div class="quick-open-statuses" role="status" aria-live="polite">
      <div
        v-for="notice in statusNotices"
        :key="notice.kind"
        class="quick-open-status"
        :data-source="notice.kind"
      >
        <span>{{ translate(notice.label) }}: {{ statusText(notice.status) }}</span>
        <details v-if="notice.status.error !== undefined">
          <summary class="mar-disclosure-summary">
            <MarIcon class="mar-disclosure-icon" name="chevron-right" />{{
              translate('generated.quickOpenDialog.details')
            }}
          </summary>
          <pre>{{ errorMessage(notice.status.error) }}</pre>
        </details>
        <MarButton
          v-if="notice.status.phase === 'FAILED' || notice.status.phase === 'TIMED_OUT'"
          link
          @click="retrySource(notice.kind)"
        >
          {{ translate('generated.quickOpenDialog.retry') }}
        </MarButton>
      </div>
    </div>
  </MarDialog>
</template>

<style scoped>
:global(.quick-open-dialog > .mar-ui-dialog__body) {
  display: flex;
  flex-direction: column;
}

.quick-open-tabs,
.quick-open-input {
  flex: none;
}

.quick-open-statuses {
  display: grid;
  flex: 0 1 auto;
  min-height: 0;
  max-height: min(40dvh, 20rem);
  overflow: auto;
  gap: 0.4rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
}

.quick-open-status {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem;
}

.quick-open-dialog.has-status-notices .quick-open-statuses {
  min-height: min(2rem, 10dvh);
}

.quick-open-status pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.quick-open-tabs {
  display: flex;
  gap: 0.2rem;
  margin-bottom: 0.25rem;
  border-bottom: 1px solid var(--mar-border-subtle);
  padding: 0 0.15rem 0.2rem;
  overflow-x: auto;
  scrollbar-width: none;
}
.quick-open-tabs button {
  flex: 0 0 auto;
  border: 0;
  border-radius: var(--mar-radius-selection);
  padding: 0.24rem 0.5rem;
  background: transparent;
  color: var(--mar-text-secondary);
  font: inherit;
  font-size: var(--mar-font-size-body);
  font-weight: 400;
  cursor: pointer;
}
.quick-open-tabs button:hover {
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}
.quick-open-tabs button[aria-pressed='true'] {
  background: var(--mar-fill-selection);
  color: var(--mar-text-primary);
}
.quick-open-tabs button:focus-visible {
  outline-offset: -1px;
}
.quick-open-results {
  display: grid;
  align-content: start;
  flex: 0 1 auto;
  min-height: 0;
  gap: 0.125rem;
  max-height: min(48vh, 360px);
  margin: 0.4rem 0 0;
  padding: 0;
  overflow: auto;
  list-style: none;
}
.quick-open-results li button:hover {
  background: var(--mar-fill-row-hover);
}
.quick-open-results li[aria-selected='true'] button,
.quick-open-results li[aria-selected='true'] button:hover {
  background: var(--mar-fill-selection);
  color: var(--mar-text-primary);
}
.quick-open-results button {
  display: grid;
  width: 100%;
  grid-template-columns: max-content minmax(0, 1fr) max-content;
  align-items: center;
  gap: 0.5rem;
  border: 0;
  border-radius: var(--mar-radius-selection);
  padding: 0.25rem 0.5rem;
  background: transparent;
  color: var(--mar-text-secondary);
  font: inherit;
  font-size: var(--mar-font-size-body);
  line-height: 1.35;
  cursor: pointer;
  text-align: left;
}
.quick-open-results button:focus-visible {
  outline-offset: -2px;
}
.entry-main {
  min-width: 0;
  display: grid;
}
.entry-heading {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  min-width: 0;
}
.entry-name,
.entry-context,
.entry-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entry-name {
  font-weight: 400;
}
.entry-context,
.entry-path,
.entry-kind {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}
.entry-context {
  flex: 0 0 auto;
  max-width: 40%;
}
.entry-path {
  font-family: var(--mar-font-mono);
}
.quick-open-match {
  color: var(--mar-text-primary);
  text-decoration: underline;
  text-underline-offset: 0.14em;
}
.mar-empty {
  margin: 1rem 0 0;
  color: var(--mar-text-secondary);
  text-align: center;
}
</style>
