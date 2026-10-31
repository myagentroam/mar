<script setup lang="ts">
import { ref } from 'vue';
import type { DialogInstance } from 'element-plus';
import { translate } from '../../service/locale-preference-service.js';
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import { marIcon } from '../../util/mar-icons.js';
import WorkspaceSessionTree from './WorkspaceSessionTree.vue';

defineProps<{
  nodeId: string;
  workspaceId: string;
  sessionId: string;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
}>();
const emit = defineEmits<{ open: [sessionId: string]; close: [] }>();
const dialog = ref<DialogInstance>();
const visible = ref(true);
const active = ref(true);

function close(): void {
  dialog.value?.handleClose();
}
function select(sessionId: string): void {
  close();
  emit('open', sessionId);
}
</script>

<template>
  <el-dialog
    v-if="visible"
    ref="dialog"
    v-model="visible"
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    class="session-tree-dialog"
    :title="translate('sessionGroups.tree')"
    width="min(720px, calc(100vw - 32px))"
    append-to-body
    :close-icon="marIcon('close')"
    @close="active = false"
    @closed="emit('close')"
  >
    <div class="session-tree-content" :inert="!active">
      <WorkspaceSessionTree
        :active="active"
        :node-id="nodeId"
        :workspace-id="workspaceId"
        :session-id="sessionId"
        :request="request"
        @close="close"
        @open="select"
      />
    </div>
  </el-dialog>
</template>
