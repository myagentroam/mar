<script setup lang="ts">
import { ref } from 'vue';
import BusyIndicator from '../../src/view/common/BusyIndicator.vue';
import ConversationScroll from '../../src/view/conversation/ConversationScroll.vue';
import ManagementPagination from '../../src/view/settings/ManagementPagination.vue';
import FilePreviewLoading from '../../src/view/workspace/FilePreviewLoading.vue';
import WorkspaceFileTree from '../../src/view/workspace/WorkspaceFileTree.vue';
import type { WorkspaceFileTreeNode } from '../../src/service/WorkspaceFileTreeService.js';

const previewLoading = ref(true);
const loadingInitial = ref(true);
const initialLoadFailed = ref(false);
const initialRequests = ref(0);
const loadingOlder = ref(true);
const olderError = ref<string>();
const olderRequests = ref(0);

function reloadHistory() {
  initialRequests.value++;
  initialLoadFailed.value = false;
  loadingInitial.value = true;
}

function loadOlderHistory() {
  olderRequests.value++;
  olderError.value = undefined;
  loadingOlder.value = true;
}

const root = ref<WorkspaceFileTreeNode>({
  path: '.',
  name: 'project',
  kind: 'DIRECTORY',
  size: null,
  expanded: true,
  loaded: true,
  loading: false,
  nextCursor: null,
  placeholder: false,
  children: [
    {
      path: 'src',
      name: 'src',
      kind: 'DIRECTORY',
      size: null,
      expanded: false,
      loaded: false,
      loading: true,
      nextCursor: null,
      placeholder: false,
      children: []
    }
  ]
});
</script>

<template>
  <main class="loading-fixture">
    <section data-testid="file-content">
      <h2>File content</h2>
      <FilePreviewLoading v-if="previewLoading" />
      <p v-else>Preview ready</p>
      <button @click="previewLoading = false">Finish file load</button>
    </section>
    <section data-testid="file-page-content">
      <h2>Standalone file</h2>
      <div class="file-page-surface">
        <FilePreviewLoading v-if="previewLoading" variant="page" overlay />
      </div>
    </section>
    <section
      data-testid="history-initial"
      class="history-surface"
      :data-request-count="initialRequests"
    >
      <ConversationScroll
        :has-older="false"
        :loading-initial="loadingInitial"
        :initial-load-failed="initialLoadFailed"
        :loading-older="false"
        :has-turns="false"
        following
        @reload="reloadHistory"
      />
    </section>
    <button
      @click="
        loadingInitial = false;
        initialLoadFailed = true;
      "
    >
      Fail initial history load
    </button>
    <section
      data-testid="history-older"
      class="history-surface"
      :data-request-count="olderRequests"
    >
      <ConversationScroll
        has-older
        :loading-initial="false"
        :initial-load-failed="false"
        :loading-older="loadingOlder"
        :older-error="olderError"
        has-turns
        following
        @load-older="loadOlderHistory"
      >
        <p>Existing message remains readable</p>
      </ConversationScroll>
    </section>
    <button @click="loadingOlder = false">Finish history load</button>
    <button
      @click="
        loadingOlder = false;
        olderError = 'History page failed';
      "
    >
      Fail history load
    </button>
    <section data-testid="management-append">
      <ManagementPagination
        :page="1"
        :total="60"
        mobile
        :mobile-visible-count="30"
        :has-more="true"
        loading
        loading-more
      />
    </section>
    <section data-testid="file-tree" class="tree-surface">
      <WorkspaceFileTree
        :root="root"
        filter=""
        :selected-path="undefined"
        :disabled="false"
        :mutations-enabled="false"
        :mobile-viewport="false"
      />
    </section>
    <button
      @click="
        root.children[0]!.loading = false;
        root.children[0]!.loaded = true;
      "
    >
      Finish directory load
    </button>
    <p class="runtime-status">Running <BusyIndicator data-testid="runtime-indicator" /></p>
  </main>
</template>

<style scoped>
.loading-fixture {
  display: grid;
  gap: 0.75rem;
  max-width: 44rem;
  padding: 1rem;
}
.loading-fixture h2 {
  font-size: 1rem;
}
.file-page-surface {
  position: relative;
  height: 4rem;
}
.history-surface {
  display: flex;
  height: 7rem;
}
.tree-surface {
  display: flex;
  height: 5rem;
}
.runtime-status {
  color: var(--mar-text-secondary);
}
</style>
