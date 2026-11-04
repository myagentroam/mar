<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import WorkspaceFileTabs from '../../src/view/workspace/WorkspaceFileTabs.vue';
import { createMobileMenuHistoryService } from '../../src/service/mobile-menu-history-service.js';
import { ElMessageBox } from '../../src/service/message-box-service.js';
import type { WorkspaceFileTab } from '../../src/util/workspace-file-tab.js';

const aside = ref(false);
const file = ref(false);
const dirty = ref(false);
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
      await ElMessageBox.confirm('Discard the edited file?', 'Unsaved file', {
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
