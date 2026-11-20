<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import ToolChangeReviewWindow from '../../src/view/workspace/ToolChangeReviewWindow.vue';
import WorkspaceFileTabs from '../../src/view/workspace/WorkspaceFileTabs.vue';
import { createMobileMenuHistoryService } from '../../src/service/mobile-menu-history-service.js';
import { MarMessageBox } from '../../src/service/message-box-service.js';
import { createToolChangeReviewService } from '../../src/service/tool-change-review-service.js';
import type { WorkspaceFileTab } from '../../src/util/workspace-file-tab.js';

const aside = ref(false);
const file = ref(false);
const dirty = ref(false);
const diffText = '--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-old contents\n+new contents\n';
const resource = {
  resourceRef: 'c10a59dd-680f-46f6-9b75-31bfbd520506',
  format: 'unified-diff' as const,
  byteSize: diffText.length,
  sha256: 'fc28480fc8d0528050fadd50de654cfb5c526c6a2656395bab37919bd0bbee92'
};
const review = createToolChangeReviewService(async () => ({
  type: 'file_changes',
  version: 1,
  ...resource,
  content: diffText
}));
function openChange() {
  review.open(
    {
      path: 'notes.txt',
      change: 'MODIFIED',
      status: 'Modified',
      changeId: 'f22e0a23-1281-4b99-aeb4-96dfd041bfb1',
      diff: { ...resource, status: 'available', source: 'TOOL_CHANGE' }
    },
    { nodeId: 'node', workspaceId: '', sessionId: 'conversation', scope: 'HOSTED' }
  );
}
const historyOwner = createMobileMenuHistoryService({
  isOpen: () => aside.value,
  close: () => (aside.value = false),
  syncRoute: () => {}
});
historyOwner.start();
onBeforeUnmount(historyOwner.dispose);
const tab: WorkspaceFileTab = {
  id: 1,
  identity: 'preview',
  kind: 'WORKTREE_TEXT',
  nodeId: 'node',
  workspaceId: 'workspace',
  path: 'notes.txt',
  fileName: 'notes.txt',
  repositoryPath: '',
  worktreePath: ''
};
const handle = {
  focus() {},
  openFind: () => false,
  selectAll: () => false,
  toggleEdit: () => 'UNAVAILABLE' as const,
  async canClose() {
    if (!dirty.value) return true;
    try {
      await MarMessageBox.confirm('Discard the edited file?', 'Unsaved file', {
        confirmButtonText: 'Discard',
        cancelButtonText: 'Keep editing'
      });
      dirty.value = false;
      return true;
    } catch {
      return false;
    }
  }
};
</script>

<template>
  <main>
    <section aria-label="File changes">
      <button @click="openChange">notes.txt</button>
    </section>
    <ToolChangeReviewWindow :review="review" />
    <button @click="aside = true">Open Aside</button>
    <aside v-if="aside" aria-label="Aside">
      <label><input v-model="dirty" type="checkbox" /> Unsaved changes</label>
      <button @click="file = true">Open file</button>
    </aside>
    <WorkspaceFileTabs
      v-if="file"
      :tabs="[tab]"
      :active-tab-id="1"
      @close-all="file = false"
      @close="file = false"
    >
      <template #default="{ registerPageHandle }">
        <p :ref="() => registerPageHandle(handle)">Preview text</p>
      </template>
    </WorkspaceFileTabs>
  </main>
</template>
