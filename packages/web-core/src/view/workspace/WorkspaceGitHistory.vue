<script setup lang="ts">
import '../../styles/region-retry-action.css';
import '../../styles/file-change-colors.css';
import './git-inline-loading.css';
import './file-explorer-utility.css';
import './inspector-row.css';
import './file-tooltip-trigger.css';
import { MarOption, MarOptionGroup, MarSelect } from '@myagentroam/mar-ui/select';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarAlert } from '@myagentroam/mar-ui/alert';
import {
  MarDropdown,
  MarDropdownItem,
  MarDropdownMenu,
  type MarDropdownInstance
} from '@myagentroam/mar-ui/dropdown';
import type { MessageType } from '../../model/message-feedback.js';
import { errorMessage } from '../../util/error-presentation.js';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import { MarRegionStatus } from '@myagentroam/mar-ui/region-status';
import { computed, nextTick, ref, shallowRef, watch, watchEffect } from 'vue';
import type { HistoryCommit, HistoryFile } from '../../model/workspace-git.js';
import type { WorkspaceGitService } from '../../service/workspace-git-service.js';
import { translate } from '../../service/locale-preference-service.js';
import {
  buildGitHistoryGraph,
  gitGraphNodeX,
  gitGraphWidth
} from '../../util/git-history-graph.js';
import { managementDateTime } from '../../util/time-presentation.js';
import { shortChange } from '../../util/workspace-git.js';
import FileTypeIcon from './FileTypeIcon.vue';

const props = defineProps<{ readonly service: WorkspaceGitService }>();
const emit = defineEmits<{
  open: [commit: HistoryCommit, file: HistoryFile, external: boolean];
  notice: [value: string, type: MessageType, cause?: unknown];
}>();
const {
  historyRefs,
  historyCommits,
  historyNextCursor,
  historyLoading,
  historyLoaded,
  historyReadPlacement,
  historyError,
  historyFiles,
  historyFilesLoading,
  historyFilesErrors,
  loadHistory
} = props.service;
const refreshBusy = computed(
  () => historyLoading.value && historyReadPlacement.value === 'refresh'
);
const readPlacement = computed(() => historyError.value?.placement ?? historyReadPlacement.value);
const showFetchNotice = computed(
  () =>
    props.service.historyFetchFailed.value &&
    historyLoaded.value &&
    props.service.historySource.value.repositoryPath === props.service.historyRepositoryPath.value
);
const showReadState = computed(
  () => !!historyError.value || (historyLoading.value && !refreshBusy.value)
);
const topOrCenterState = computed(() => showReadState.value && readPlacement.value !== 'append');
function retryHistory(): void {
  if (historyLoading.value || !historyError.value) return;
  void loadHistory(historyError.value.resetPage, historyError.value.fetch, 'retry');
}
const historyBoundary = ref<HTMLElement>();
const historyContainer = ref<HTMLElement>();
watchEffect(
  (onCleanup) => {
    const boundary = historyBoundary.value;
    const root = historyContainer.value;
    if (
      !boundary ||
      !root ||
      historyLoading.value ||
      historyError.value ||
      typeof IntersectionObserver === 'undefined'
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadHistory(false);
      },
      { root, rootMargin: '0px 0px 96px 0px' }
    );
    observer.observe(boundary);
    onCleanup(() => observer.disconnect());
  },
  { flush: 'post' }
);
const historyRepositoryPath = ref(props.service.historyRepositoryPath.value);
const selectedHistoryRefs = ref([...props.service.selectedHistoryRefs.value]);
const expandedHistoryCommits = ref<string[]>([]);
const expandedHistoryDirectories = ref<Record<string, readonly string[]>>({});
const historyMenu = ref<MarDropdownInstance>();
const historyMenuTarget = shallowRef<{
  readonly hash: string;
  readonly anchor: { readonly contextElement: HTMLElement; getBoundingClientRect(): DOMRect };
}>();
watch(props.service.historyRepositoryPath, (path) => {
  historyRepositoryPath.value = path;
});
watch(props.service.selectedHistoryRefs, (refs) => {
  selectedHistoryRefs.value = [...refs];
});
watch(props.service.historySource, () => {
  expandedHistoryCommits.value = [];
  expandedHistoryDirectories.value = {};
  closeHistoryContextMenu();
});
const historyRepositorySelection = computed({
  get: () =>
    historyRepositoryPath.value === '' ? '__ROOT_REPOSITORY__' : historyRepositoryPath.value,
  set: (value: string) => {
    historyRepositoryPath.value = value === '__ROOT_REPOSITORY__' ? '' : value;
  }
});
const historyRepositories = computed(() =>
  props.service.repositories.value
    .filter((repository) => repository.source !== 'WORKTREE' && repository.status !== 'UNAVAILABLE')
    .map((repository) => ({
      value: repository.repositoryPath === '' ? '__ROOT_REPOSITORY__' : repository.repositoryPath,
      label: repository.repositoryName || translate('generated.workspaceInspector.rootRepository')
    }))
);
const historyGraphRows = computed(() => {
  const rows = buildGitHistoryGraph(historyCommits.value);
  return historyCommits.value.map((commit, index) => ({ commit, graph: rows[index]! }));
});
function resetHistory(): Promise<void> {
  return props.service.selectHistory(historyRepositoryPath.value, selectedHistoryRefs.value);
}
function changeHistoryRepository(): Promise<void> {
  selectedHistoryRefs.value = [];
  return resetHistory();
}
async function toggleHistoryCommit(commit: HistoryCommit): Promise<void> {
  if (expandedHistoryCommits.value.includes(commit.hash)) {
    expandedHistoryCommits.value = expandedHistoryCommits.value.filter(
      (hash) => hash !== commit.hash
    );
    return;
  }
  expandedHistoryCommits.value = [...expandedHistoryCommits.value, commit.hash];
  if (expandedHistoryDirectories.value[commit.hash] === undefined)
    expandedHistoryDirectories.value = { ...expandedHistoryDirectories.value, [commit.hash]: [] };
  await props.service.loadHistoryFiles(commit);
}
function historyTime(value: number): string {
  return Number.isFinite(value) ? managementDateTime(value) : '-';
}

function openHistoryContextMenu(hash: string, event: MouseEvent): void {
  event.preventDefault();
  const row = event.currentTarget as HTMLElement;
  const rect = new DOMRect(event.clientX, event.clientY);
  closeHistoryContextMenu();
  const target = {
    hash,
    anchor: { contextElement: row, getBoundingClientRect: () => rect }
  };
  historyMenuTarget.value = target;
  row.focus({ preventScroll: true });
  void nextTick(() => {
    if (historyMenuTarget.value === target) historyMenu.value?.handleOpen();
  });
}

function closeHistoryContextMenu(): void {
  historyMenu.value?.handleClose();
  historyMenuTarget.value = undefined;
}

async function copyHistoryCommitId(): Promise<void> {
  const hash = historyMenuTarget.value?.hash;
  if (hash === undefined) return;
  try {
    await navigator.clipboard.writeText(hash);
    emit('notice', translate('generated.workspaceInspector.commitIdCopied'), 'info');
  } catch (error) {
    emit('notice', errorMessage(error), 'error', error);
  }
}

function historyTreeIndent(depth: number): string {
  const safeDepth = Math.min(8, Math.max(0, depth));
  return `${safeDepth * 10 + 2}px`;
}

type HistoryFileRow =
  | {
      readonly kind: 'DIRECTORY';
      readonly path: string;
      readonly name: string;
      readonly depth: number;
    }
  | {
      readonly kind: 'FILE';
      readonly file: HistoryFile;
      readonly name: string;
      readonly depth: number;
    };

function isVisibleHistoryPath(path: string, expandedDirectories: readonly string[]): boolean {
  const parts = path.split('/').filter(Boolean);
  return parts
    .slice(0, -1)
    .every((_, index) => expandedDirectories.includes(parts.slice(0, index + 1).join('/')));
}

function historyFileRows(
  files: readonly HistoryFile[],
  expandedDirectories: readonly string[]
): readonly HistoryFileRow[] {
  const directories = new Set<string>();
  const rows: HistoryFileRow[] = [];
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const parts = file.path.split('/').filter(Boolean);
    for (let depth = 0; depth < parts.length - 1; depth += 1) {
      const path = parts.slice(0, depth + 1).join('/');
      if (directories.has(path)) continue;
      directories.add(path);
      if (!isVisibleHistoryPath(path, expandedDirectories)) continue;
      rows.push({ kind: 'DIRECTORY', path, name: parts[depth] ?? path, depth });
    }
    if (!isVisibleHistoryPath(file.path, expandedDirectories)) continue;
    rows.push({ kind: 'FILE', file, name: parts.at(-1) ?? file.path, depth: parts.length - 1 });
  }
  return rows;
}

function toggleHistoryDirectory(commitHash: string, path: string): void {
  const expanded = expandedHistoryDirectories.value[commitHash] ?? [];
  expandedHistoryDirectories.value = {
    ...expandedHistoryDirectories.value,
    [commitHash]: expanded.includes(path)
      ? expanded.filter((item) => item !== path)
      : [...expanded, path]
  };
}
</script>

<template>
  <section ref="historyContainer" class="git-history" @scroll="closeHistoryContextMenu">
    <div class="history-toolbar">
      <MarSelect
        v-model="historyRepositorySelection"
        class="history-filter"
        :aria-label="translate('generated.workspaceInspector.selectGitRepository')"
        :placeholder="translate('generated.workspaceInspector.selectAGitRepository')"
        @change="changeHistoryRepository"
      >
        <MarOption
          v-for="repository in historyRepositories"
          :key="repository.value"
          :label="repository.label"
          :value="repository.value"
        />
      </MarSelect>
      <MarSelect
        v-model="selectedHistoryRefs"
        class="history-filter"
        :aria-label="translate('generated.workspaceInspector.selectGitBranch')"
        :placeholder="translate('generated.workspaceInspector.allBranches')"
        multiple
        collapse-tags
        collapse-tags-tooltip
        clearable
        @change="resetHistory"
      >
        <MarOptionGroup :label="translate('generated.workspaceInspector.localBranches')">
          <MarOption
            v-for="item in historyRefs.filter((entry) => entry.kind === 'LOCAL')"
            :key="item.name"
            :label="item.displayName"
            :value="item.name"
          />
        </MarOptionGroup>
        <MarOptionGroup :label="translate('generated.workspaceInspector.remoteBranches')">
          <MarOption
            v-for="item in historyRefs.filter((entry) => entry.kind === 'REMOTE')"
            :key="item.name"
            :label="item.displayName"
            :value="item.name"
          />
        </MarOptionGroup>
      </MarSelect>
      <button
        v-tooltip="translate('generated.workspaceInspector.refreshGitHistory2')"
        class="history-refresh file-explorer-utility-button mar-icon-button mar-icon-action"
        :disabled="historyLoading"
        :aria-label="translate('generated.workspaceInspector.refreshGitHistory')"
        :aria-busy="refreshBusy || undefined"
        type="button"
        @click="loadHistory(true, true, 'refresh')"
      >
        <MarIcon :name="refreshBusy ? 'loading-action' : 'refresh'" />
      </button>
    </div>
    <MarAlert
      v-if="showFetchNotice"
      class="git-fetch-notice"
      type="warning"
      show-icon
      :closable="false"
      :description="translate('gitSync.fetchFailed')"
    />
    <MarRegionStatus
      v-if="topOrCenterState"
      :placement="readPlacement === 'center' ? 'center' : 'top'"
    >
      <MarButton
        v-if="historyError"
        link
        v-tooltip="!historyLoading ? errorMessage(service.historyFailureCause.value) : ''"
        :aria-description="
          !historyLoading ? errorMessage(service.historyFailureCause.value) : undefined
        "
        class="history-load-more mar-region-retry-action"
        :aria-disabled="historyLoading"
        :aria-busy="historyLoading || undefined"
        :aria-label="historyLoading ? translate('generated.workspaceInspector.loading') : undefined"
        @click="retryHistory"
      >
        <span v-if="historyLoading" class="mar-inline-loading">
          <MarIcon name="loading-action" />{{ translate('generated.workspaceInspector.loading') }}
        </span>
        <template v-else>{{ translate('common.loadFailedRetry') }}</template>
      </MarButton>
      <div v-else class="history-load-more" role="status">
        <MarIcon name="loading-action" />{{ translate('generated.workspaceInspector.loading') }}
      </div>
    </MarRegionStatus>
    <MarRegionStatus v-if="historyLoaded && !showReadState && historyCommits.length === 0">
      {{ translate('generated.workspaceInspector.noGitCommitHistory') }}
    </MarRegionStatus>
    <ul v-show="historyCommits.length > 0" class="history-list">
      <li v-for="{ commit, graph } in historyGraphRows" :key="commit.hash" class="history-commit">
        <button
          v-tooltip="
            `${commit.subject || translate('generated.workspaceInspector.untitled')}\n${commit.authorName} · ${historyTime(commit.committedAt)}${commit.refs.length > 0 ? `\n${commit.refs.join(', ')}` : ''}`
          "
          :aria-label="`${commit.subject || translate('generated.workspaceInspector.untitled')}\n${commit.authorName} · ${historyTime(commit.committedAt)}${commit.refs.length > 0 ? `\n${commit.refs.join(', ')}` : ''}`"
          class="history-commit-row mar-inspector-row mar-inspector-row-action"
          type="button"
          @click="toggleHistoryCommit(commit)"
          @contextmenu="openHistoryContextMenu(commit.hash, $event)"
        >
          <svg
            class="history-graph"
            :style="{ width: `${gitGraphWidth(graph)}px` }"
            :viewBox="`0 0 ${gitGraphWidth(graph)} 38`"
            aria-hidden="true"
          >
            <path
              v-for="(edge, edgeIndex) in graph.edges"
              :key="`${commit.hash}:${edgeIndex}`"
              class="history-graph-edge"
              :class="`history-graph-color-${edge.color % 6}`"
              :d="edge.path"
            />
            <circle class="history-graph-node-ring" :cx="gitGraphNodeX(graph)" cy="19" r="4.5" />
            <circle
              class="history-graph-node"
              :class="`history-graph-color-${graph.lane % 6}`"
              :cx="gitGraphNodeX(graph)"
              cy="19"
              r="3"
            />
          </svg>
          <span class="history-content">
            <span class="history-title-row">
              <span class="history-subject">{{
                commit.subject || translate('generated.workspaceInspector.untitled2')
              }}</span>
              <span
                v-tooltip="refName"
                v-for="refName in commit.refs"
                :key="refName"
                class="history-ref"
                >{{ refName }}</span
              >
            </span>
            <small>{{ commit.authorName }} · {{ historyTime(commit.committedAt) }}</small>
          </span>
        </button>
        <div
          v-if="expandedHistoryCommits.includes(commit.hash)"
          class="history-expanded"
          :style="{ gridTemplateColumns: `${gitGraphWidth(graph)}px minmax(0, 1fr)` }"
        >
          <svg
            class="history-graph-continuation"
            :style="{ width: `${gitGraphWidth(graph)}px` }"
            aria-hidden="true"
          >
            <line
              v-for="lane in graph.outgoingLaneCount"
              :key="lane"
              :class="`history-graph-color-${(lane - 1) % 6}`"
              :x1="(lane - 1) * 14 + 7"
              y1="0"
              :x2="(lane - 1) * 14 + 7"
              y2="100%"
            />
          </svg>
          <ul class="history-files">
            <li
              v-if="
                historyFilesLoading.includes(commit.hash) &&
                !historyFilesErrors.includes(commit.hash)
              "
              class="mar-empty"
              role="status"
            >
              <MarIcon name="loading-action" />
              {{ translate('generated.workspaceInspector.loading') }}
            </li>
            <li v-if="historyFilesErrors.includes(commit.hash)" class="mar-empty">
              <MarButton
                link
                v-tooltip="
                  !historyFilesLoading.includes(commit.hash)
                    ? errorMessage(service.historyFilesFailureCauses.value[commit.hash])
                    : ''
                "
                :aria-description="
                  !historyFilesLoading.includes(commit.hash)
                    ? errorMessage(service.historyFilesFailureCauses.value[commit.hash])
                    : undefined
                "
                :aria-disabled="historyFilesLoading.includes(commit.hash)"
                :aria-busy="historyFilesLoading.includes(commit.hash) || undefined"
                :aria-label="
                  historyFilesLoading.includes(commit.hash)
                    ? translate('generated.workspaceInspector.loading')
                    : undefined
                "
                @click="
                  !historyFilesLoading.includes(commit.hash) && service.loadHistoryFiles(commit)
                "
              >
                <span v-if="historyFilesLoading.includes(commit.hash)" class="mar-inline-loading">
                  <MarIcon name="loading-action" />{{
                    translate('generated.workspaceInspector.loading')
                  }}
                </span>
                <template v-else>{{ translate('common.loadFailedRetry') }}</template>
              </MarButton>
            </li>
            <li
              v-for="row in historyFileRows(
                historyFiles[commit.hash] ?? [],
                expandedHistoryDirectories[commit.hash] ?? []
              )"
              :key="
                row.kind === 'DIRECTORY'
                  ? `directory:${row.path}`
                  : `file:${row.file.previousPath ?? ''}:${row.file.path}`
              "
            >
              <span v-tooltip="row.path" v-if="row.kind === 'DIRECTORY'" class="mar-tooltip-control"
                ><MarButton
                  text
                  class="history-directory"
                  :style="{ paddingLeft: historyTreeIndent(row.depth) }"
                  :aria-expanded="
                    (expandedHistoryDirectories[commit.hash] ?? []).includes(row.path)
                  "
                  @click.stop="toggleHistoryDirectory(commit.hash, row.path)"
                >
                  <MarIcon
                    name="chevron-right"
                    class="history-directory-toggle"
                    :class="{
                      'is-expanded': (expandedHistoryDirectories[commit.hash] ?? []).includes(
                        row.path
                      )
                    }"
                  />
                  <FileTypeIcon :name="row.name" kind="DIRECTORY" />{{ row.name }}
                </MarButton></span
              >
              <MarButton
                v-tooltip="
                  row.file.previousPath
                    ? `${row.file.previousPath} → ${row.file.path}`
                    : row.file.path
                "
                v-else
                text
                :style="{ paddingLeft: historyTreeIndent(row.depth) }"
                @click.stop="emit('open', commit, row.file, $event.ctrlKey || $event.metaKey)"
              >
                <span
                  class="history-file-status mar-file-change-status"
                  :data-file-change="row.file.change"
                  >{{ shortChange(row.file.change) }}</span
                >
                <FileTypeIcon :name="row.name" />
                <span class="history-file-path">{{ row.name }}</span>
              </MarButton>
            </li>
          </ul>
        </div>
      </li>
    </ul>
    <MarDropdown
      v-if="historyMenuTarget"
      ref="historyMenu"
      trigger="contextmenu"
      virtual-triggering
      :virtual-ref="historyMenuTarget.anchor"
      placement="bottom-start"
      :offset="2"
      @command="copyHistoryCommitId"
      @visible-change="!$event && (historyMenuTarget = undefined)"
    >
      <template #dropdown>
        <MarDropdownMenu :aria-label="translate('generated.workspaceInspector.gitHistory')">
          <MarDropdownItem command="copy" icon="copy">{{
            translate('generated.workspaceInspector.copyCommitId')
          }}</MarDropdownItem>
        </MarDropdownMenu>
      </template>
    </MarDropdown>
    <MarButton
      v-if="historyError && readPlacement === 'append'"
      link
      v-tooltip="!historyLoading ? errorMessage(service.historyFailureCause.value) : ''"
      :aria-description="
        !historyLoading ? errorMessage(service.historyFailureCause.value) : undefined
      "
      class="history-load-more"
      :aria-disabled="historyLoading"
      :aria-busy="historyLoading || undefined"
      :aria-label="historyLoading ? translate('generated.workspaceInspector.loading') : undefined"
      @click="retryHistory"
    >
      <span v-if="historyLoading" class="mar-inline-loading">
        <MarIcon name="loading-action" />{{ translate('generated.workspaceInspector.loading') }}
      </span>
      <template v-else>{{ translate('common.loadFailedRetry') }}</template>
    </MarButton>
    <div
      v-else-if="historyLoading && readPlacement === 'append'"
      class="history-load-more"
      role="status"
    >
      <MarIcon name="loading-action" /> {{ translate('generated.workspaceInspector.loading') }}
    </div>
    <div
      v-if="historyNextCursor !== null && !historyError && !historyLoading"
      ref="historyBoundary"
      class="history-boundary"
      aria-hidden="true"
    />
  </section>
</template>

<style scoped>
.history-boundary {
  min-height: 1px;
}
.git-fetch-notice {
  flex: none;
  padding: 6px 8px;
  font-size: var(--mar-font-size-meta);
}

.history-commit-row,
.history-files :deep(.mar-ui-button) {
  border-radius: var(--mar-radius-selection);
}
</style>

<style scoped>
.git-history {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  gap: 8px;
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 6px;
}

.history-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr) auto;
  gap: 6px;
  align-items: center;
  min-width: 0;
}

.history-toolbar :deep(.mar-ui-select) {
  min-width: 0;
}

button.history-refresh {
  --mar-ui-action-icon-size: 14px;
  width: 24px;
  min-width: 24px;
  height: 24px;
  min-height: 24px;
  font-size: var(--mar-ui-action-icon-size);
}

.history-list,
.history-files {
  width: 100%;
  min-width: 0;
  list-style: none;
  margin: 0;
  padding: 0;
}

.history-commit {
  min-width: 0;
}

.history-commit-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 0 2px;
  text-align: left;
  cursor: pointer;
  min-height: 38px;
}

.history-graph {
  display: block;
  height: 38px;
  min-width: 14px;
  overflow: visible;
}

.history-expanded {
  display: grid;
  min-width: 0;
  position: relative;
  padding-inline: 2px;
}

.history-graph-continuation {
  display: block;
  position: absolute;
  inset-block: 0;
  left: 2px;
  height: 100%;
  overflow: visible;
}

.history-graph-continuation line {
  stroke: currentColor;
  stroke-linecap: round;
  stroke-width: 1.6;
}

.history-graph-edge {
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-width: 1.6;
}

.history-graph-node-ring {
  fill: var(--mar-bg-panel);
  stroke: var(--mar-bg-panel);
  stroke-width: 3;
}

.history-graph-node {
  fill: currentColor;
  stroke: currentColor;
}

.history-graph-color-0 {
  color: var(--mar-color-git-graph-main);
}

.history-graph-color-1 {
  color: var(--mar-palette-green-fg);
}

.history-graph-color-2 {
  color: var(--mar-palette-cyan-fg);
}

.history-graph-color-3 {
  color: var(--mar-palette-amber-fg);
}

.history-graph-color-4 {
  color: var(--mar-text-secondary);
}

.history-graph-color-5 {
  color: var(--mar-palette-red-fg);
}

.history-content,
.history-title-row {
  display: flex;
  min-width: 0;
}

.history-content {
  flex-direction: column;
  gap: 1px;
  padding-block: 4px;
}

.history-title-row {
  align-items: center;
  gap: 4px;
}

.history-subject {
  min-width: 0;
  overflow: hidden;
  font-size: var(--mar-font-size-meta);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-ref {
  flex: 0 1 auto;
  max-width: 92px;
  overflow: hidden;
  border-radius: 8px;
  background: color-mix(in srgb-linear, var(--mar-fill-soft), currentColor 4%);
  color: var(--mar-color-git-graph-main);
  font-size: var(--mar-font-size-nano);
  outline: 1px solid color-mix(in srgb, var(--mar-fill-soft), currentColor 42%);
  outline-offset: -1px;
  padding: 1px 5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-content small {
  overflow: hidden;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-nano);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-files {
  grid-column: 2;
  min-width: 0;
  margin: 0;
}

.history-files > .mar-empty {
  padding: 1px 2px;
  font-size: var(--mar-font-size-meta);
  line-height: 18px;
}

.history-directory {
  display: flex;
  align-items: center;
  min-width: 0;
  min-height: 20px;
  gap: 4px;
  overflow: hidden;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-files :deep(.history-directory.mar-ui-button) {
  justify-content: flex-start;
}

.history-directory .mar-icon {
  flex: none;
  font-size: 10px;
}

.history-directory-toggle {
  margin-right: 2px;
  transition: transform 120ms ease;
}

.history-directory-toggle.is-expanded {
  transform: rotate(90deg);
}

.history-files :deep(.mar-ui-button) {
  justify-content: flex-start;
  width: 100%;
  min-height: 20px;
  overflow: hidden;
  padding: 1px 2px;
  font-size: var(--mar-font-size-meta);
  line-height: 18px;
}

.history-files :deep(.mar-ui-button__label) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-file-path {
  flex: 1;
  text-align: left;
}

.history-file-status {
  display: inline-block;
  flex: none;
  width: 16px;
  color: var(--mar-file-change-fg, var(--mar-text-secondary));
  font-size: var(--mar-font-size-nano);
}

.history-files :deep(.file-type-icon) {
  width: 12px;
  flex-basis: 12px;
  margin-right: 3px;
  overflow: visible;
  font-size: var(--mar-font-size-meta);
}

.history-load-more {
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--mar-font-size-meta);
  line-height: 20px;
  text-decoration: none;
}

.history-load-more[aria-disabled='true'] {
  color: var(--mar-text-disabled);
  cursor: default;
  text-decoration: none;
}

@media (max-width: 767px) {
  .history-toolbar {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .history-toolbar > .history-filter:nth-child(2) {
    grid-column: 1 / -1;
    grid-row: 2;
  }
  .history-toolbar > .history-refresh {
    grid-column: 2;
    grid-row: 1;
  }
}
</style>
