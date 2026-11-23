<script setup lang="ts">
import '../../styles/region-retry-action.css';
import './git-inline-loading.css';
import './file-explorer-utility.css';
import './inspector-row.css';
import '@myagentroam/mar-ui/region-status.css';
import { MarAlert } from '@myagentroam/mar-ui/alert';
import { MarCheckbox } from '@myagentroam/mar-ui/checkbox';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarButton } from '@myagentroam/mar-ui/button';
import { computed, nextTick, ref } from 'vue';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import { MarRegionStatus } from '@myagentroam/mar-ui/region-status';
import FileTypeIcon from './FileTypeIcon.vue';
import { translate } from '../../service/locale-preference-service.js';
import type { createWorkspaceContentSearchService } from '../../service/workspace-content-search-service.js';
import { errorMessage } from '../../util/error-presentation.js';
import { changeDirectory, changeFileName } from '../../util/workspace-git.js';
import { marIcon } from '@myagentroam/mar-ui/icons';

const props = defineProps<{
  service: ReturnType<typeof createWorkspaceContentSearchService>;
  enabled: boolean;
  nodeId: string | undefined;
  workspaceId: string | undefined;
}>();
const emit = defineEmits<{
  open: [path: string, line: number, column: number, external: boolean];
}>();
const contentQuery = ref('');
const contentUseRegex = ref(false);
const contentSearchInput = ref<{ focus: () => void }>();
const contentSearch = props.service;
const contentAppliedQuery = contentSearch.appliedQuery;
const contentAppliedUseRegex = contentSearch.appliedUseRegex;
const contentMatches = contentSearch.matches;
const contentSearchLoading = contentSearch.loading;
const contentSearchError = contentSearch.error;
const contentSearchTruncated = contentSearch.truncated;
const buttonLoading = computed(
  () =>
    contentSearchLoading.value &&
    contentSearch.rereading.value &&
    contentSearchError.value === undefined
);
const newQueryState = computed(
  () =>
    !contentSearch.rereading.value &&
    (contentSearchLoading.value || contentSearchError.value !== undefined)
);

async function searchContent(): Promise<void> {
  if (
    !props.enabled ||
    contentSearchLoading.value ||
    props.nodeId === undefined ||
    props.workspaceId === undefined
  )
    return;
  await contentSearch.search({
    nodeId: props.nodeId,
    workspaceId: props.workspaceId,
    query: contentQuery.value,
    useRegex: contentUseRegex.value
  });
}
function contentMatchFragments(
  preview: string
): readonly { readonly text: string; readonly match: boolean }[] {
  if (contentAppliedUseRegex.value) return [{ text: preview, match: false }];
  const index = preview.toLocaleLowerCase().indexOf(contentAppliedQuery.value.toLocaleLowerCase());
  if (index < 0 || contentAppliedQuery.value === '') return [{ text: preview, match: false }];
  const end = index + contentAppliedQuery.value.length;
  return [
    { text: preview.slice(0, index), match: false },
    { text: preview.slice(index, end), match: true },
    { text: preview.slice(end), match: false }
  ].filter((fragment) => fragment.text !== '');
}
defineExpose({
  focus: () => nextTick(() => contentSearchInput.value?.focus()),
  snapshot: () => ({ contentQuery: contentQuery.value, contentUseRegex: contentUseRegex.value }),
  restore: (value: { contentQuery?: unknown; contentUseRegex?: unknown }) => {
    contentQuery.value = typeof value.contentQuery === 'string' ? value.contentQuery : '';
    contentUseRegex.value = value.contentUseRegex === true;
  }
});
</script>

<template>
  <section class="content-search">
    <div class="content-search-toolbar">
      <form @submit.prevent="searchContent">
        <MarInput
          ref="contentSearchInput"
          v-model="contentQuery"
          :aria-label="translate('generated.workspaceInspector.searchFileContents')"
          maxlength="256"
          :placeholder="translate('generated.workspaceInspector.searchFileContents2')"
          :prefix-icon="marIcon('search')"
        />
        <button
          v-tooltip="translate('generated.workspaceInspector.runContentSearch2')"
          class="content-search-button file-explorer-utility-button mar-icon-button mar-icon-action"
          :disabled="contentSearchLoading"
          :aria-label="translate('generated.workspaceInspector.runContentSearch')"
          :aria-busy="buttonLoading || undefined"
          type="submit"
        >
          <MarIcon :name="buttonLoading ? 'loading-action' : 'refresh'" />
        </button>
      </form>
      <div class="content-search-options">
        <MarCheckbox v-model="contentUseRegex">{{
          translate('generated.workspaceInspector.useRegularExpression')
        }}</MarCheckbox>
      </div>
    </div>
    <div class="content-search-body">
      <MarRegionStatus
        v-if="contentSearchError !== undefined || (contentSearchLoading && !buttonLoading)"
        class="content-search-state"
        :placement="newQueryState ? 'center' : 'top'"
      >
        <MarButton
          v-if="contentSearchError !== undefined"
          v-tooltip="!contentSearchLoading ? errorMessage(contentSearchError) : ''"
          :aria-description="!contentSearchLoading ? errorMessage(contentSearchError) : undefined"
          class="watch-status mar-region-retry-action"
          link
          :class="{ failed: !contentSearchLoading }"
          :aria-disabled="contentSearchLoading"
          :aria-busy="contentSearchLoading || undefined"
          :aria-label="
            contentSearchLoading ? translate('generated.workspaceInspector.loading') : undefined
          "
          @click="contentSearch.retry()"
        >
          <span v-if="contentSearchLoading" class="mar-inline-loading">
            <MarIcon name="loading-action" />{{ translate('generated.workspaceInspector.loading') }}
          </span>
          <template v-else>{{ translate('common.loadFailedRetry') }}</template>
        </MarButton>
        <p v-else class="mar-region-status" role="status">
          <MarIcon name="loading-action" />
          {{ translate('generated.workspaceInspector.loading') }}
        </p>
      </MarRegionStatus>
      <MarAlert
        v-if="contentSearchTruncated && !newQueryState"
        class="content-search-warning"
        type="warning"
        show-icon
        :closable="false"
        :description="
          translate('generated.workspaceInspector.resultsAreIncompleteNarrowTheSearchScope')
        "
      />
      <ul
        v-show="!newQueryState"
        class="content-search-results"
        :aria-label="translate('generated.workspaceInspector.contentSearchResults')"
      >
        <li v-for="match in contentMatches" :key="`${match.path}:${match.line}:${match.column}`">
          <button
            v-tooltip="match.path"
            :aria-label="match.path"
            class="mar-inspector-row mar-inspector-row-action"
            type="button"
            @click="
              emit('open', match.path, match.line, match.column, $event.ctrlKey || $event.metaKey)
            "
          >
            <FileTypeIcon :name="changeFileName(match.path)" />
            <span class="content-search-path">
              <span class="content-search-file">{{ changeFileName(match.path) }}</span>
              <span v-if="changeDirectory(match.path)" class="content-search-directory">{{
                changeDirectory(match.path)
              }}</span>
            </span>
            <small>{{
              translate('generated.workspaceInspector.line', { value0: match.line })
            }}</small>
            <code
              ><template
                v-for="(fragment, index) in contentMatchFragments(match.preview)"
                :key="index"
                ><mark v-if="fragment.match">{{ fragment.text }}</mark
                ><template v-else>{{ fragment.text }}</template></template
              ></code
            >
          </button>
        </li>
        <li
          v-if="
            contentAppliedQuery !== '' &&
            contentMatches.length === 0 &&
            !contentSearchTruncated &&
            contentSearchError === undefined
          "
          class="file-search-empty mar-region-status"
        >
          {{ translate('generated.workspaceInspector.noMatchingContent') }}
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.content-search-state:not(.mar-region-status--center) {
  padding-block-start: 8px;
}

.content-search {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

.content-search-toolbar {
  display: grid;
  gap: 0.25rem;
  border-bottom: 1px solid var(--mar-border-subtle);
  padding-block: 0.375rem;
}

.content-search-toolbar,
.content-search-body {
  padding-inline: 0.375rem;
}

.content-search-toolbar form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.25rem;
  margin: 0;
}

.content-search-warning {
  margin-block-start: 0.375rem;
  inline-size: auto;
  flex: none;
  padding: 0.375rem 0.5rem;
  font-size: var(--mar-font-size-meta);
}

.content-search-body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  flex-direction: column;
  overflow: auto;
  overscroll-behavior: contain;
}

.content-search-results {
  margin: 0.25rem 0 0;
  padding: 0;
  list-style: none;
}

.content-search-results button {
  display: grid;
  width: 100%;
  grid-template-columns: auto minmax(0, 1fr) max-content;
  align-items: center;
  gap: 0.125rem 0.375rem;
  border: 0;
  border-radius: var(--mar-radius-selection);
  background: transparent;
  color: var(--mar-text-primary);
  font: inherit;
  font-size: var(--mar-font-size-meta);
  line-height: 1.25;
  padding: 0.25rem 0.375rem;
  text-align: left;
  cursor: pointer;
}

.content-search-file,
.content-search-directory,
.content-search-results code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.content-search-path {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 0.375rem;
}

.content-search-file:not(:only-child) {
  max-width: 60%;
}

.content-search-results mark {
  background: var(--mar-color-warning-bg);
  color: var(--mar-color-warning-text);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.content-search-directory,
.content-search-results small {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-nano);
}

.content-search-directory {
  flex: 1 1 0;
}

.content-search-results code {
  grid-column: 2 / -1;
}
</style>
