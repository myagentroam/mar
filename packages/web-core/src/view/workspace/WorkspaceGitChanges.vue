<script setup lang="ts">
import '../../styles/region-retry-action.css';
import './git-inline-loading.css';
import '@myagentroam/mar-ui/region-status.css';
import { MarTag } from '@myagentroam/mar-ui/tag';
import { MarAlert } from '@myagentroam/mar-ui/alert';
import { MarButton } from '@myagentroam/mar-ui/button';
import { computed, ref, watch, watchEffect } from 'vue';
import type { MessageType } from '../../model/message-feedback.js';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import { MarRegionStatus } from '@myagentroam/mar-ui/region-status';
import { marIcon } from '@myagentroam/mar-ui/icons';
import { MarMessageBox } from '../../service/message-box-service.js';
import type { PublicError } from '@myagentroam/protocol';
import { translate } from '../../service/locale-preference-service.js';
import type { WorkspaceGitService } from '../../service/workspace-git-service.js';
import type { WorkspaceWatchTopicStatus } from '../../service/workspace-watch-service.js';
import { changeKey } from '../../service/workspace-git-service.js';
import type { WorkspaceFileOperationTarget } from '../../service/workspace-file-operation-service.js';
import type {
  ChangeEntry,
  ChangeRepository,
  GitWorktreeSummary
} from '../../model/workspace-git.js';
import {
  workspaceChangePath,
  shortChange,
  changeFileName,
  changeDirectory,
  limitChangeRepositories
} from '../../util/workspace-git.js';
import { errorMessage } from '../../util/error-presentation.js';
import { ApiError } from '../../util/api-error.js';
import FileTypeIcon from './FileTypeIcon.vue';
import { usesRawFilePreview } from '../../util/file-preview.js';

const props = defineProps<{
  readonly service: WorkspaceGitService;
  readonly target: WorkspaceFileOperationTarget | undefined;
  readonly watchStatus?: WorkspaceWatchTopicStatus;
}>();
const emit = defineEmits<{
  open: [entry: ChangeEntry, external: boolean];
  notice: [value: string, type: MessageType, cause?: unknown];
  retryWatch: [];
}>();
const {
  repositories: visibleChangeRepositories,
  worktrees: visibleGitWorktrees,
  worktreesTruncated: gitWorktreesTruncated,
  discoveryErrors: changeDiscoveryErrors,
  changesRefreshing,
  restoringPath,
  loadChanges
} = props.service;
// Read state belongs to the Git/Watch services; this view owns only the local render window
// and its scroll observer. Appending already-read entries does not create a request busy state.
const changesLoading = computed(() => changesRefreshing.value || props.watchStatus === 'loading');
const changesReady = computed(() => props.service.changes.value !== undefined);
const changesReadFailed = computed(
  () => props.watchStatus === 'failed' || (!changesReady.value && props.service.changesError.value)
);
// This owns the retry control's lifetime, not the authoritative request busy state.
const keepRetryControl = ref(false);
const showRetryControl = computed(
  () => changesReadFailed.value || (keepRetryControl.value && changesLoading.value)
);
watch([changesLoading, changesReadFailed], ([loading, failed]) => {
  if (!loading && !failed) keepRetryControl.value = false;
});
watch([() => props.target?.nodeId, () => props.target?.workspaceId], () => {
  keepRetryControl.value = false;
});
const manualRefresh = ref(false);
const refreshBusy = computed(
  () => changesReady.value && changesRefreshing.value && manualRefresh.value
);
async function refreshChanges(): Promise<void> {
  if (changesLoading.value) return;
  manualRefresh.value = true;
  try {
    await loadChanges(true);
  } finally {
    manualRefresh.value = false;
  }
}
function retryRead(): void {
  if (changesLoading.value) return;
  keepRetryControl.value = true;
  if (props.watchStatus === 'failed') emit('retryWatch');
  else if (props.service.changesError.value) void props.service.retryChanges();
}
const CHANGE_RENDER_BATCH = 200;
const changeRenderLimit = ref(CHANGE_RENDER_BATCH);
const changeListElement = ref<HTMLElement>();
const loadMoreElements = ref<HTMLElement[]>([]);
const renderedChangeRepositories = computed(() =>
  limitChangeRepositories(visibleChangeRepositories.value, changeRenderLimit.value)
);
const renderedChangeCount = computed(() =>
  renderedChangeRepositories.value.reduce(
    (count, repository) => count + repository.changes.length,
    0
  )
);
const totalChangeCount = computed(() =>
  visibleChangeRepositories.value.reduce(
    (count, repository) => count + repository.changes.length,
    0
  )
);
const hasMoreChanges = computed(() => renderedChangeCount.value < totalChangeCount.value);
const changeBatchBoundary = computed(() =>
  hasMoreChanges.value
    ? renderedChangeRepositories.value.filter((repository) => repository.changes.length > 0).at(-1)
    : undefined
);
watch(visibleChangeRepositories, () => {
  changeRenderLimit.value = CHANGE_RENDER_BATCH;
});
watchEffect(
  (onCleanup) => {
    const element = loadMoreElements.value[0];
    const root = changeListElement.value;
    const limit = changeRenderLimit.value;
    if (!element || !root || typeof IntersectionObserver === 'undefined') return;
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          active &&
          changeRenderLimit.value === limit &&
          entries.some((entry) => entry.isIntersecting)
        )
          changeRenderLimit.value += CHANGE_RENDER_BATCH;
      },
      { root }
    );
    observer.observe(element);
    onCleanup(() => {
      active = false;
      observer.disconnect();
    });
  },
  { flush: 'post' }
);
function worktreeReference(worktree: GitWorktreeSummary): string {
  return (
    worktree.branch ??
    translate('gitWorktrees.detachedHead', {
      head: worktree.head.slice(0, 8)
    })
  );
}

function worktreeStatusLabel(status: GitWorktreeSummary['status']): string {
  if (status === 'CLEAN') return translate('gitWorktrees.clean');
  if (status === 'DIRTY') return translate('gitWorktrees.dirty');
  return translate('gitWorktrees.unavailable');
}

function worktreeStatusType(status: GitWorktreeSummary['status']): 'success' | 'warning' | 'info' {
  if (status === 'CLEAN') return 'success';
  if (status === 'DIRTY') return 'warning';
  return 'info';
}

function repositoryKey(repository: ChangeRepository): string {
  return `${repository.source}:${repository.worktreePath ?? repository.repositoryPath}`;
}

function repositoryKindLabel(source: ChangeRepository['source']): string {
  if (source === 'ROOT') return translate('gitWorktrees.rootRepository');
  if (source === 'SUBMODULE') return translate('gitWorktrees.submodule');
  return translate('gitWorktrees.worktree');
}

function repositoryReference(repository: ChangeRepository): string | undefined {
  if (repository.branch !== null) return repository.branch;
  if (repository.head === undefined) return undefined;
  return translate('gitWorktrees.detachedHead', { head: repository.head.slice(0, 8) });
}

function shortState(state: ChangeEntry['state']): string {
  return { STAGED: 'S', UNSTAGED: 'W', UNTRACKED: '?' }[state];
}

function gitGroupErrorMessage(error: PublicError): string {
  return errorMessage(new ApiError(error.code, error.message, error.parameters, error.details));
}

async function restoreChange(entry: ChangeEntry): Promise<void> {
  const target = props.target;
  if (target === undefined || restoringPath.value !== undefined) return;
  const workspacePath = workspaceChangePath(entry);
  const action =
    entry.state === 'UNTRACKED'
      ? translate('generated.workspaceInspector.deleteUntrackedFile')
      : translate('generated.workspaceInspector.revertChanges');
  try {
    await MarMessageBox.confirm(
      translate('generated.workspaceInspector.thisActionCannotBeUndone', {
        value0: action,
        value1: workspacePath
      }),
      action,
      {
        confirmButtonText:
          entry.state === 'UNTRACKED'
            ? translate('generated.workspaceInspector.delete2')
            : translate('generated.workspaceInspector.revert'),
        cancelButtonText: translate('generated.workspaceInspector.cancel3'),
        type: 'warning'
      }
    );
  } catch {
    return;
  }
  const restored = await props.service.restoreChange(entry, target);
  if (
    !restored ||
    props.target?.nodeId !== target.nodeId ||
    props.target.workspaceId !== target.workspaceId
  )
    return;
  emit(
    'notice',
    entry.state === 'UNTRACKED'
      ? translate('generated.workspaceInspector.deleted', { value0: workspacePath })
      : translate('generated.workspaceInspector.reverted', { value0: workspacePath }),
    'success'
  );
}
</script>

<template>
  <section class="current-changes">
    <MarRegionStatus
      v-if="!refreshBusy && (showRetryControl || changesLoading)"
      class="changes-read-state"
      :placement="changesReady ? 'top' : 'center'"
    >
      <MarButton
        class="mar-region-retry-action"
        v-if="showRetryControl"
        v-tooltip="
          !changesLoading && service.changesError.value
            ? errorMessage(service.changesFailureCause.value)
            : ''
        "
        link
        :aria-description="
          !changesLoading && service.changesError.value
            ? errorMessage(service.changesFailureCause.value)
            : undefined
        "
        :aria-disabled="changesLoading"
        :aria-busy="changesLoading || undefined"
        :aria-label="changesLoading ? translate('generated.workspaceInspector.loading') : undefined"
        @click="retryRead"
      >
        <span v-if="changesLoading" class="mar-inline-loading">
          <MarIcon name="loading-action" />{{ translate('generated.workspaceInspector.loading') }}
        </span>
        <template v-else>{{ translate('common.loadFailedRetry') }}</template>
      </MarButton>
      <p v-else class="mar-region-status" role="status">
        <MarIcon name="loading-action" /> {{ translate('generated.workspaceInspector.loading') }}
      </p>
    </MarRegionStatus>
    <MarAlert
      v-if="changesReady && service.changesFetchFailed.value"
      class="git-fetch-notice"
      type="warning"
      show-icon
      :closable="false"
      :description="translate('gitSync.fetchFailed')"
    />
    <div v-if="visibleGitWorktrees.length > 0" class="git-worktrees">
      <div class="git-worktree-heading">
        <strong>{{ translate('gitWorktrees.title') }}</strong>
        <small v-if="gitWorktreesTruncated">
          {{ translate('gitWorktrees.truncated') }}
        </small>
      </div>
      <ul class="git-worktree-list" :aria-label="translate('gitWorktrees.title')">
        <li
          v-for="(worktree, index) in visibleGitWorktrees"
          :key="`${worktree.directoryName}:${worktree.head}:${index}`"
        >
          <strong v-tooltip="worktree.directoryName" class="git-worktree-name">
            {{ worktree.directoryName }}
          </strong>
          <code v-tooltip="worktreeReference(worktree)">
            {{ worktreeReference(worktree) }}
          </code>
          <span class="git-worktree-statuses">
            <MarTag v-if="worktree.current" class="repository-current" type="info" effect="plain">
              {{ translate('gitWorktrees.current') }}
            </MarTag>
            <MarTag :type="worktreeStatusType(worktree.status)" effect="plain">
              {{ worktreeStatusLabel(worktree.status) }}
            </MarTag>
            <MarTag v-if="worktree.locked" type="warning" effect="plain">
              {{ translate('gitWorktrees.locked') }}
            </MarTag>
            <MarTag v-if="worktree.prunable" type="info" effect="plain">
              {{ translate('gitWorktrees.prunable') }}
            </MarTag>
          </span>
        </li>
      </ul>
    </div>
    <p v-else-if="gitWorktreesTruncated" class="git-worktrees-truncated" role="status">
      {{ translate('gitWorktrees.truncated') }}
    </p>
    <p
      v-for="(error, index) in changeDiscoveryErrors"
      :key="index"
      class="change-repository-empty"
      role="status"
    >
      {{ gitGroupErrorMessage(error) }}
    </p>
    <MarRegionStatus
      v-if="
        changesReady &&
        visibleChangeRepositories.length === 0 &&
        !changesLoading &&
        !changesReadFailed &&
        changeDiscoveryErrors.length === 0 &&
        visibleGitWorktrees.length === 0 &&
        !gitWorktreesTruncated
      "
      class="changes-empty"
    >
      {{ translate('generated.workspaceInspector.theWorkspaceHasNoRepositoriesToDisplay') }}
    </MarRegionStatus>
    <ul
      v-else-if="visibleChangeRepositories.length > 0"
      ref="changeListElement"
      class="change-list"
    >
      <template v-for="repository in renderedChangeRepositories" :key="repositoryKey(repository)">
        <li class="change-repository-heading" :data-repository-path="repository.repositoryPath">
          <div class="repository-heading-content">
            <div class="repository-title-row">
              <strong v-tooltip="repository.physicalPath || repository.repositoryPath">
                {{
                  repository.repositoryName ||
                  translate('generated.workspaceInspector.rootRepository')
                }}
              </strong>
              <code
                v-tooltip="repositoryReference(repository)"
                v-if="repositoryReference(repository)"
                class="repository-branch current-branch"
              >
                {{ repositoryReference(repository) }}
              </code>
              <button
                v-if="repository.source === 'ROOT'"
                v-tooltip="translate('generated.workspaceInspector.refreshGitChanges2')"
                class="changes-refresh-button file-explorer-utility-button mar-icon-action"
                :disabled="changesLoading"
                :aria-label="translate('generated.workspaceInspector.refreshGitChanges')"
                :aria-busy="refreshBusy || undefined"
                type="button"
                @click="refreshChanges"
              >
                <MarIcon :name="refreshBusy ? 'loading-action' : 'refresh'" />
              </button>
            </div>
            <div class="repository-tags-row">
              <MarTag class="repository-kind" type="info" effect="plain">
                {{ repositoryKindLabel(repository.source) }}
              </MarTag>
              <MarTag
                v-if="repository.current"
                class="repository-current"
                type="info"
                effect="plain"
              >
                {{ translate('gitWorktrees.current') }}
              </MarTag>
              <MarTag
                v-if="repository.status"
                :type="worktreeStatusType(repository.status)"
                effect="plain"
              >
                {{ worktreeStatusLabel(repository.status) }}
              </MarTag>
              <MarTag v-if="repository.locked" type="warning" effect="plain">
                {{ translate('gitWorktrees.locked') }}
              </MarTag>
              <MarTag v-if="repository.prunable" type="info" effect="plain">
                {{ translate('gitWorktrees.prunable') }}
              </MarTag>
              <MarTag
                v-if="
                  repository.tracking &&
                  (repository.tracking.ahead > 0 || repository.tracking.behind > 0)
                "
                class="repository-sync-tag"
                effect="plain"
                v-tooltip="translate('gitSync.description', repository.tracking)"
                :aria-label="translate('gitSync.description', repository.tracking)"
              >
                <span aria-hidden="true"
                  >↓ {{ repository.tracking.behind }} ↑ {{ repository.tracking.ahead }}</span
                >
              </MarTag>
            </div>
            <code
              v-tooltip="repository.repositoryPath"
              v-if="repository.source === 'SUBMODULE' && repository.repositoryPath"
              class="repository-relative-path"
            >
              {{ repository.repositoryPath }}
            </code>
            <code
              v-tooltip="repository.physicalPath"
              v-if="
                (repository.source === 'WORKTREE' || repository.source === 'ROOT') &&
                repository.physicalPath
              "
              class="repository-physical-path"
            >
              {{ repository.physicalPath }}
            </code>
          </div>
        </li>
        <li
          v-if="repository.changes.length === 0 && !repository.changesTruncated"
          class="change-repository-empty"
        >
          {{
            repository.error !== undefined
              ? gitGroupErrorMessage(repository.error)
              : repository.status === 'UNAVAILABLE'
                ? translate('gitWorktrees.unavailable')
                : translate('generated.workspaceInspector.noUncommittedChanges')
          }}
        </li>
        <li v-if="repository.changesTruncated" class="change-repository-empty" role="status">
          {{ translate('gitWorktrees.changesTruncated') }}
        </li>
        <li v-for="entry in repository.changes" :key="changeKey(entry)" class="change-entry">
          <button
            v-tooltip="workspaceChangePath(entry)"
            class="change-path"
            type="button"
            :aria-label="
              entry.diffAvailable && !usesRawFilePreview(entry.path)
                ? translate('generated.workspaceInspector.viewDiffFor', {
                    value0: workspaceChangePath(entry)
                  })
                : translate('generated.workspaceInspector.preview', {
                    value0: workspaceChangePath(entry)
                  })
            "
            @click="emit('open', entry, $event.ctrlKey || $event.metaKey)"
          >
            <span class="change-path-content">
              <span class="change-file-heading"
                ><FileTypeIcon :name="changeFileName(entry.path)" /><strong
                  class="change-file-name"
                  >{{ changeFileName(entry.path) }}</strong
                ></span
              >
              <small v-if="changeDirectory(entry.path)" class="change-directory">
                {{ changeDirectory(entry.path) }}
              </small>
            </span>
          </button>
          <span v-tooltip="entry.change" class="change-status">{{
            shortChange(entry.change)
          }}</span>
          <small v-tooltip="entry.state" class="change-status">{{ shortState(entry.state) }}</small>
          <MarButton
            v-tooltip="
              entry.state === 'UNTRACKED'
                ? translate('generated.workspaceInspector.deleteUntrackedFile2')
                : translate('generated.workspaceInspector.revertChanges2')
            "
            class="change-restore mar-icon-action mar-icon-action--inline"
            text
            :icon="marIcon('undo')"
            :loading="restoringPath === changeKey(entry)"
            :disabled="restoringPath !== undefined"
            :aria-label="
              entry.state === 'UNTRACKED'
                ? translate('generated.workspaceInspector.deleteChangesTo', {
                    value0: workspaceChangePath(entry)
                  })
                : translate('generated.workspaceInspector.revertChangesTo', {
                    value0: workspaceChangePath(entry)
                  })
            "
            @click="restoreChange(entry)"
          />
        </li>
        <li
          v-if="repository === changeBatchBoundary"
          ref="loadMoreElements"
          class="change-append-state"
          aria-hidden="true"
        />
      </template>
    </ul>
  </section>
</template>

<style scoped>
.git-fetch-notice {
  margin: 0 6px 4px;
  inline-size: auto;
  flex: none;
  padding: 6px 8px;
  font-size: var(--mar-font-size-meta);
}

.change-file-heading {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.35rem;
}

.change-file-heading strong {
  min-width: 0;
}

.git-worktrees {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--mar-border-subtle);
  padding: 0.15rem 2px 0.4rem;
}

.git-worktree-heading {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  justify-content: space-between;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-meta);
}

.git-worktree-heading small {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  font-weight: 400;
}

.git-worktree-list {
  display: grid;
  gap: 0.25rem;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  max-height: min(18rem, 35vh);
  margin: 0.3rem 0 0;
  padding: 0;
  list-style: none;
}

.git-worktree-list li {
  display: grid;
  grid-template-columns: minmax(6rem, 0.8fr) minmax(7rem, 1fr) auto;
  gap: 0.45rem;
  align-items: center;
  min-width: 0;
}

.git-worktree-name,
.git-worktree-list code {
  overflow: hidden;
  min-width: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-worktree-name {
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-meta);
  font-weight: 500;
}

.git-worktree-list code {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}

.git-worktree-statuses {
  display: flex;
  gap: 0.25rem;
  align-items: center;
  justify-content: flex-end;
}

.git-worktrees-truncated {
  margin: 0;
  border-bottom: 1px solid var(--mar-border-subtle);
  padding: 0.25rem 2px 0.4rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}

.change-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.changes-read-state,
.changes-empty {
  padding: 0.2rem 2px;
}

.changes-read-state button {
  font: inherit;
}

.change-list > .change-append-state {
  display: block;
  height: 1px;
  border: 0;
  padding: 0;
}

.change-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto;
  gap: 7px;
  align-items: center;
  border-top: 1px solid var(--mar-fill-hover);
  padding: 5px 2px;
}

.change-list .change-repository-heading {
  grid-column: 1 / -1;
  grid-template-columns: minmax(0, 1fr);
  margin-top: 0.5rem;
  border-top: 1px solid var(--mar-border-default);
  padding: 0.35rem 0.25rem 0;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  font-weight: 500;
}

.change-list > .change-repository-heading:first-child {
  margin-top: 0;
  border-top: 0;
  padding-top: 0.2rem;
}

.change-list .change-repository-empty {
  grid-column: 1 / -1;
  border-top: 0;
  padding: 0.2rem 2px 0.25rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}

.change-repository-heading strong {
  color: var(--mar-text-primary);
  font-weight: inherit;
}

.repository-heading-content {
  display: grid;
  gap: 0.2rem;
  min-width: 0;
}

.repository-title-row {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  min-width: 0;
  min-height: var(--mar-compact-control-size);
}

.repository-title-row strong {
  flex: 0 1 auto;
  overflow: hidden;
  min-width: 0;
  max-width: 60%;
  padding-block: 0.125rem;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repository-title-row .repository-branch {
  flex: 0 1 auto;
  line-height: 1.2;
}

.repository-title-row .changes-refresh-button {
  --mar-ui-action-icon-size: 14px;
  flex: 0 0 auto;
  margin-left: auto;
  font-size: var(--mar-ui-action-icon-size);
}

.repository-tags-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem;
}

.repository-tags-row :deep(.mar-ui-tag),
.git-worktree-statuses :deep(.mar-ui-tag) {
  padding-inline: 0.28rem;
  font-size: var(--mar-font-size-meta);
  font-weight: 400;
}

.repository-tags-row :deep(.mar-ui-tag) {
  height: 1.65em;
}

.repository-kind,
.repository-current {
  --mar-ui-tag-border-color: var(--mar-workbench-control-border);
}

.repository-sync-tag {
  --mar-ui-tag-border-color: var(--mar-border-default);
  font-variant-numeric: tabular-nums;
}

.change-repository-heading code {
  margin-left: 0;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  font-weight: 400;
}

.current-branch {
  display: block;
  width: fit-content;
  overflow: hidden;
  min-width: 0;
  max-width: min(46vw, 20rem);
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repository-physical-path,
.repository-relative-path {
  display: block;
  overflow-wrap: anywhere;
  color: var(--mar-text-secondary);
  line-height: 1.35;
  white-space: normal;
}

.change-list .change-path {
  justify-content: flex-start;
  overflow: hidden;
  min-width: 0;
  height: auto;
  padding: 0;
  color: var(--mar-text-primary);
  font-family: var(--mar-font-mono);
  font-size: var(--mar-font-size-meta);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.change-list .change-entry,
.change-list .change-path {
  border-radius: var(--mar-radius-selection);
}

.change-list .change-entry:hover {
  background: var(--mar-fill-row-hover);
}

.change-list .change-path:not(.is-disabled):hover {
  color: var(--mar-text-primary);
}

.change-list .change-restore {
  min-width: 1.4rem;
  padding: 0.15rem;
}

.change-list > li > span {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}

.change-list small {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}

.current-changes {
  margin-top: 0.2rem;
  padding-top: 0;
}

.current-changes {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.current-changes .change-list {
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
  overscroll-behavior: contain;
}

@media (max-width: 767px) {
  .git-worktree-list li {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .git-worktree-list code {
    grid-column: 1 / -1;
    grid-row: 2;
  }
  .git-worktree-statuses {
    flex-wrap: wrap;
  }
}
</style>

<style scoped>
button.file-explorer-utility-button {
  display: inline-grid;
  width: var(--mar-compact-control-size);
  min-width: var(--mar-compact-control-size);
  height: var(--mar-compact-control-size);
  min-height: var(--mar-compact-control-size);
  place-items: center;
  border: 0;
  border-radius: var(--mar-radius-control);
  background: transparent;
  color: var(--mar-text-secondary);
  font: inherit;
  padding: 0;
  cursor: pointer;
}

button.file-explorer-utility-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>

<style scoped>
.change-list li {
  gap: 3px;
  border-top: 0;
  min-height: 18px;
  color: var(--mar-text-primary);
  padding: 0 2px;
}

.change-list .change-path {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 18px;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 1px 2px;
  line-height: 1.1;
  font-size: var(--mar-font-size-meta);
  text-align: left;
  cursor: pointer;
}

.change-list .change-path:hover:not(:disabled),
.change-list .change-path:focus-visible {
  background: var(--mar-fill-hover);
}

.change-list .change-path:disabled {
  cursor: default;
  opacity: 0.6;
}

.change-path-content {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.change-file-heading {
  flex: 0 0 auto;
  overflow: hidden;
  max-width: 60%;
}

.change-file-heading .change-file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.change-list .change-file-name,
.change-list .change-directory {
  display: inline;
}

.change-list .change-file-name {
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-meta);
  font-weight: 500;
}

.change-list .change-directory {
  flex: 1 1 auto;
  overflow: hidden;
  min-width: 0;
  margin-left: 0.45rem;
  color: var(--mar-text-secondary);
  font-family: inherit;
  font-size: var(--mar-font-size-nano);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.change-list > li > small {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  line-height: 1;
}

.change-list .change-entry > .change-status {
  inline-size: 1ch;
  font-family: var(--mar-font-mono);
  font-size: var(--mar-font-size-meta);
  font-weight: 400;
  line-height: 1;
  text-align: center;
}

.change-list .change-restore {
  --mar-ui-action-icon-size: 14px;
  min-width: 20px;
  min-height: 18px;
  padding: 0.1rem;
  font-size: var(--mar-ui-action-icon-size);
}

:deep(.change-list .change-restore.mar-ui-button) {
  min-height: 18px;
}
</style>
