<script setup lang="ts">
import { nextTick, ref } from 'vue';
import MarIcon from '../common/MarIcon.vue';
import FileTypeIcon from './FileTypeIcon.vue';
import { translate } from '../../service/locale-preference-service.js';
import type { createWorkspaceContentSearchService } from '../../service/workspace-content-search-service.js';
import { errorMessage } from '../../util/error-presentation.js';
import { changeFileName } from '../../util/workspace-git.js';

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

async function searchContent(): Promise<void> {
  if (!props.enabled || props.nodeId === undefined || props.workspaceId === undefined) return;
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
    <div class="content-search-options">
      <el-checkbox v-model="contentUseRegex" size="small">{{
        translate('generated.workspaceInspector.useRegularExpression')
      }}</el-checkbox>
    </div>
    <form class="explorer-toolbar content-search-toolbar" @submit.prevent="searchContent">
      <el-input
        ref="contentSearchInput"
        v-model="contentQuery"
        :aria-label="translate('generated.workspaceInspector.searchFileContents')"
        maxlength="256"
        :placeholder="translate('generated.workspaceInspector.searchFileContents2')"
        size="small"
      />
      <button
        v-tooltip="translate('generated.workspaceInspector.runContentSearch2')"
        class="content-search-button file-explorer-utility-button utility-control"
        :disabled="contentSearchLoading"
        :aria-label="translate('generated.workspaceInspector.runContentSearch')"
        :aria-busy="contentSearchLoading || undefined"
        type="submit"
      >
        <MarIcon name="search" />
      </button>
    </form>
    <el-button
      v-if="contentSearchError !== undefined"
      v-tooltip="!contentSearchLoading ? errorMessage(contentSearchError) : ''"
      :aria-description="!contentSearchLoading ? errorMessage(contentSearchError) : undefined"
      class="watch-status"
      link
      :class="{ failed: !contentSearchLoading }"
      :aria-disabled="contentSearchLoading"
      :aria-busy="contentSearchLoading || undefined"
      @click="contentSearch.retry()"
    >
      <template v-if="contentSearchLoading"
        ><MarIcon name="loading-action" />
        {{ translate('generated.workspaceInspector.loading') }}</template
      ><template v-else>{{ translate('common.loadFailedRetry') }}</template>
    </el-button>
    <p v-else-if="contentSearchLoading" class="watch-status" role="status">
      <MarIcon name="loading-action" />
      {{ translate('generated.workspaceInspector.loading') }}
    </p>
    <p v-if="contentSearchTruncated" class="content-search-warning">
      {{ translate('generated.workspaceInspector.resultsAreIncompleteNarrowTheSearchScope') }}
    </p>
    <ul
      class="content-search-results"
      :aria-label="translate('generated.workspaceInspector.contentSearchResults')"
    >
      <li v-for="match in contentMatches" :key="`${match.path}:${match.line}:${match.column}`">
        <button
          v-tooltip="match.path"
          :aria-label="match.path"
          type="button"
          @click="
            emit('open', match.path, match.line, match.column, $event.ctrlKey || $event.metaKey)
          "
        >
          <span class="content-search-name"
            ><FileTypeIcon :name="changeFileName(match.path)" /><strong>{{
              match.path
            }}</strong></span
          ><small>{{
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
          !contentSearchLoading &&
          contentSearchError === undefined
        "
        class="file-search-empty"
      >
        {{ translate('generated.workspaceInspector.noMatchingContent') }}
      </li>
    </ul>
  </section>
</template>

<style scoped>
.watch-status {
  margin: 0.2rem 0.55rem;
  font-size: var(--mar-font-size-meta);
}

.watch-status:not(button) {
  color: var(--mar-text-muted);
}

button.watch-status {
  align-self: flex-start;
  border: 0;
  padding: 0;
  background: transparent;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

button.watch-status[aria-disabled='true'] {
  color: var(--mar-text-muted);
  cursor: default;
}

.content-search {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

.content-search-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  margin-top: 0.2rem;
}

.content-search-options {
  padding: 0.375rem 0.375rem 0;
}

.content-search-options :deep(.el-checkbox) {
  height: 1.2rem;
  font-size: var(--mar-font-size-meta);
}

.content-search-warning {
  margin: 0.35rem 0 0;
  color: var(--mar-color-warning-text);
  font-size: var(--mar-font-size-meta);
}

.content-search-results {
  min-height: 0;
  margin: 0.45rem 0 0;
  padding: 0;
  list-style: none;
  overflow: auto;
}

.content-search-results > li + li {
  margin-top: 2px;
}

.content-search-results button {
  display: grid;
  width: 100%;
  grid-template-columns: minmax(0, 1fr) max-content;
  gap: 0.18rem 0.5rem;
  border: 0;
  border-radius: var(--mar-radius-selection);
  background: transparent;
  color: var(--mar-text-primary);
  padding: 0.35rem 0.25rem;
  text-align: left;
  cursor: pointer;
}

.content-search-results button:hover,
.content-search-results button:focus-visible {
  background: var(--mar-fill-row-hover);
}

.content-search-results button:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: -2px;
}

.content-search-results strong,
.content-search-results code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.content-search-results strong {
  font-size: var(--mar-font-size-body);
  font-weight: 600;
  line-height: 1.25;
}

.content-search-name {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.35rem;
}

.content-search-name strong {
  min-width: 0;
}

.content-search-results mark {
  border-radius: 2px;
  background: var(--mar-color-warning-bg);
  color: var(--mar-text-primary);
}

.content-search-results small {
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
}

.content-search-results code {
  grid-column: 1 / -1;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}

.explorer-toolbar {
  display: flex;
  justify-content: flex-start;
  gap: 0.25rem;
  align-items: center;
  margin: 0.3rem 0 0;
  border-bottom: 1px solid var(--mar-border-subtle);
  padding: 0 0.375rem 0.375rem;
}

button.file-explorer-utility-button {
  display: inline-grid;
  width: 26px;
  min-width: 26px;
  height: 26px;
  min-height: 26px;
  place-items: center;
  border: 0;
  border-radius: 5px;
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

:deep(.el-input__wrapper) {
  min-height: 26px;
  border: 1px solid var(--mar-border-medium);
  border-radius: 6px;
  background: var(--mar-bg-subtle);
  box-shadow: none;
  padding: 1px 7px;
}

:deep(.el-input__inner) {
  font-size: var(--mar-font-size-input);
}

:deep(.el-input__wrapper.is-focus),
:deep(.el-input__wrapper:focus-within) {
  background: var(--mar-bg-panel);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--mar-color-brand) 14%, transparent);
}
</style>
