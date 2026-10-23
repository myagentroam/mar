<script setup lang="ts">
import { marIcon } from '../../util/mar-icons.js';
import MarIcon from '../common/MarIcon.vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { NodeSummary, Session, WorkspaceTab } from '../../model/workbench.js';
import {
  createQuickOpenQueryService,
  type QuickOpenTab,
  sortQuickOpenCandidates,
  type QuickOpenCandidate,
  type QuickOpenSessionCandidate,
  type QuickOpenSourceStatus
} from '../../service/QuickOpenService.js';
import { createScopedHttpService } from '../../service/ScopedHttpService.js';
import { translate } from '../../service/LocalePreferenceService.js';
import { workspaceFileTarget } from '../../util/file-preview.js';
import { supportsNodeFeature } from '../../util/node-features.js';
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
const input = ref<HTMLInputElement>();
const results = ref<HTMLUListElement>();
const tab = ref<QuickOpenTab>('ALL');
const query = ref('');
const activeKey = ref<string>();
const selectionCommitted = ref(false);
const http = createScopedHttpService();
const nonblockingFiles = computed(() =>
  supportsNodeFeature(
    props.nodes.find((node) => node.id === props.nodeId)?.nodeAppVersion ?? '',
    'WORKSPACE_INDEX_PREPARATION'
  )
);
const queryService = createQuickOpenQueryService({
  open: () => props.open,
  query: () => query.value,
  tab: () => tab.value,
  nodeId: () => props.nodeId,
  workspaceId: () => props.workspaceId,
  filesReady: () => props.filesReady,
  symbolsReady: () => props.symbolsReady,
  nonblockingFiles: () => nonblockingFiles.value,
  nodes: () => props.nodes,
  workspaceTabs: () => props.workspaceTabs,
  origin: () => (typeof window === 'undefined' ? 'http://localhost' : window.location.origin),
  http
});
const { workspaces, files, symbols, workspaceStatus, fileStatus, symbolStatus, referenceStatus } =
  queryService;
const scheduleSearch = queryService.scheduleSearch;
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
    files.value = [];
    symbols.value = [];
    activeKey.value = undefined;
    void loadWorkspaces();
    void nextTick(() => input.value?.focus());
  }
);
watch(query, scheduleSearch);
watch(tab, () => {
  activeKey.value = entries.value[0]?.key;
  scheduleSearch();
});
watch(
  [
    () => props.nodeId,
    () => props.workspaceId,
    () => props.filesReady,
    () => props.symbolsReady,
    nonblockingFiles
  ],
  scheduleSearch
);

function cancelSearch(): void {
  queryService.cancel();
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') cancelSearch();
  else if (props.open) {
    void loadWorkspaces();
    scheduleSearch();
  }
}
onMounted(() => {
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function')
    document.addEventListener('visibilitychange', onVisibilityChange);
});
onBeforeUnmount(() => {
  queryService.dispose();
  if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function')
    document.removeEventListener('visibilitychange', onVisibilityChange);
});

function choose(entry = entries.value[activeIndex.value], external = false): void {
  if (entry === undefined || selectionCommitted.value) return;
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
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
  } else if (event.key === 'ArrowDown' && entries.value.length > 0) {
    event.preventDefault();
    selectActiveEntry(entries.value[(activeIndex.value + 1) % entries.value.length]?.key);
  } else if (event.key === 'ArrowUp' && entries.value.length > 0) {
    event.preventDefault();
    selectActiveEntry(
      entries.value[(activeIndex.value - 1 + entries.value.length) % entries.value.length]?.key
    );
  } else if (event.key === 'Enter') {
    event.preventDefault();
    choose(undefined, event.ctrlKey || event.metaKey);
  }
}
</script>

<template>
  <el-dialog
    :model-value="open"
    :title="translate('generated.quickOpenDialog.quickOpen')"
    width="min(680px, calc(100vw - 32px))"
    :show-close="false"
    @close="emit('close')"
    @opened="input?.focus()"
    :close-icon="marIcon('close')"
  >
    <div
      class="quick-open-tabs"
      role="tablist"
      :aria-label="translate('generated.quickOpenDialog.resultTypes')"
    >
      <button
        v-for="candidateTab in ['ALL', 'WORKSPACE', 'SESSION', 'FILE', 'SYMBOL'] as const"
        :key="candidateTab"
        type="button"
        role="tab"
        :aria-selected="tab === candidateTab"
        @click="tab = candidateTab"
      >
        {{
          translate(
            `generated.quickOpenDialog.${candidateTab.toLocaleLowerCase()}` as 'generated.quickOpenDialog.all'
          )
        }}
      </button>
    </div>
    <input
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
        <button type="button" @click="choose(entry, $event.ctrlKey || $event.metaKey)">
          <FileTypeIcon
            :name="
              entry.kind === 'WORKSPACE'
                ? entry.workspaceLabel
                : entry.kind === 'FILE'
                  ? entry.name
                  : entry.kind === 'SESSION'
                    ? entry.title
                    : entry.path
            "
          />
          <span class="entry-main">
            <strong>
              <span
                v-for="(fragment, fragmentIndex) in highlightedPath(
                  entry.kind === 'FILE'
                    ? entry.name
                    : entry.kind === 'SYMBOL'
                      ? entry.symbol
                      : entry.kind === 'SESSION'
                        ? entry.title
                        : entry.workspaceLabel
                )"
                :key="fragmentIndex"
                :class="{ 'quick-open-match': fragment.matched }"
                >{{ fragment.text }}</span
              >
            </strong>
            <code v-if="entry.kind !== 'SESSION'"
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
          <span
            class="entry-kind"
            :class="{
              'entry-kind-workspace': entry.kind === 'WORKSPACE',
              'entry-kind-session': entry.kind === 'SESSION',
              'entry-kind-file': entry.kind === 'FILE',
              'entry-kind-definition': entry.kind === 'SYMBOL' && entry.source === 'DEFINITION',
              'entry-kind-reference': entry.kind === 'SYMBOL' && entry.source === 'REFERENCE'
            }"
            >{{
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
            }}</span
          >
          <small v-if="entry.kind === 'WORKSPACE'">{{ entry.nodeLabel }}</small>
          <small v-else-if="entry.kind === 'SESSION'">{{ entry.runner }}</small>
          <small v-else-if="entry.kind === 'SYMBOL' && entry.detail">{{ entry.detail }}</small>
        </button>
      </li>
    </ul>
    <p v-else-if="loading" class="empty" role="status">
      <MarIcon name="loading-action" /> {{ translate('generated.quickOpenDialog.searching') }}
    </p>
    <p v-else-if="statusNotices.length === 0" class="empty">
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
        <button
          v-if="notice.status.phase === 'FAILED' || notice.status.phase === 'TIMED_OUT'"
          type="button"
          @click="retrySource(notice.kind)"
        >
          {{ translate('generated.quickOpenDialog.retry') }}
        </button>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.quick-open-statuses {
  display: grid;
  gap: 0.4rem;
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-body);
}

.quick-open-status {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem;
}

.quick-open-status pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 10rem;
  overflow: auto;
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
.quick-open-tabs::-webkit-scrollbar {
  display: none;
}
.quick-open-tabs button {
  flex: 0 0 auto;
  border: 0;
  border-radius: var(--mar-radius-selection);
  padding: 0.24rem 0.5rem;
  background: transparent;
  color: var(--mar-text-muted);
  font: inherit;
  font-size: var(--mar-font-size-body);
  font-weight: 400;
  cursor: pointer;
}
.quick-open-tabs button:hover {
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}
.quick-open-tabs button[aria-selected='true'] {
  background: var(--mar-fill-selection);
  color: var(--mar-text-primary);
}
.quick-open-tabs button:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: -1px;
}
.quick-open-input {
  box-sizing: border-box;
  width: 100%;
  min-height: 42px;
  border: 1px solid var(--mar-border-strong);
  border-radius: 8px;
  padding: 0.65rem 0.8rem;
  background: var(--mar-bg-subtle);
  color: var(--mar-text-primary);
  caret-color: var(--mar-color-brand);
  font: inherit;
}
.quick-open-input::placeholder {
  color: var(--mar-text-faint);
  opacity: 1;
}
.quick-open-input:focus {
  border-color: var(--mar-color-brand);
  outline: 0;
  background: var(--mar-bg-panel);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--mar-color-brand) 12%, transparent);
}
.quick-open-results {
  display: grid;
  gap: 0.15rem;
  max-height: min(48vh, 360px);
  margin: 0.4rem 0 0;
  padding: 0;
  overflow: auto;
  list-style: none;
}
.quick-open-results li button:hover {
  background: color-mix(in srgb, var(--mar-color-brand) 7%, var(--mar-bg-subtle));
}
.quick-open-results li[aria-selected='true'] button {
  background: var(--mar-color-brand-selected);
  box-shadow: inset 2px 0 0 var(--mar-color-brand);
}
.quick-open-results li[aria-selected='true'] button:hover {
  background: color-mix(in srgb, var(--mar-color-brand) 14%, var(--mar-bg-subtle));
}
.quick-open-results button {
  display: grid;
  width: 100%;
  grid-template-columns: max-content minmax(0, 1fr) max-content;
  align-items: center;
  gap: 0.55rem;
  border: 0;
  border-radius: 4px;
  padding: 0.55rem 0.65rem;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.quick-open-results button:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: -2px;
}
.entry-main {
  min-width: 0;
  display: grid;
  gap: 0.15rem;
}
.quick-open-results strong,
.quick-open-results code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.quick-open-results code,
.quick-open-results small {
  color: var(--mar-text-secondary);
}
.quick-open-results small {
  grid-column: 2;
}
.entry-kind {
  border: 1px solid var(--mar-border-subtle);
  border-radius: 4px;
  padding: 0.1rem 0.45rem;
  background: var(--mar-bg-subtle);
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  font-weight: 600;
  line-height: 1.25;
}
.entry-kind-workspace {
  border-color: var(--mar-color-brand-border);
  background: var(--mar-color-brand-subtle);
  color: var(--mar-color-brand-text);
}
.entry-kind-session {
  --quick-open-session-color: color-mix(
    in srgb,
    var(--mar-color-brand-text) 48%,
    var(--mar-text-secondary)
  );
  border-color: color-mix(in srgb, var(--quick-open-session-color) 32%, var(--mar-border-subtle));
  background: color-mix(in srgb, var(--quick-open-session-color) 9%, var(--mar-bg-subtle));
  color: var(--quick-open-session-color);
}
.entry-kind-definition {
  border-color: color-mix(in srgb, var(--mar-color-success-text) 35%, transparent);
  background: var(--mar-color-success-bg);
  color: var(--mar-color-success-text);
}
.entry-kind-reference {
  border-color: color-mix(in srgb, var(--mar-color-warning-text) 35%, transparent);
  background: var(--mar-color-warning-bg);
  color: var(--mar-color-warning-text);
}
.entry-kind-file {
  border-color: var(--mar-border-medium);
  background: var(--mar-fill-muted);
  color: var(--mar-text-secondary);
}
.quick-open-match {
  color: var(--mar-color-brand-text);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--mar-color-brand) 55%, transparent);
  text-underline-offset: 0.14em;
}
.empty {
  margin: 1rem 0 0;
  color: var(--mar-text-secondary);
  text-align: center;
}
</style>
