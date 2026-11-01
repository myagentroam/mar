<script setup lang="ts">
import { ref, watch } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import MarIcon from '../common/MarIcon.vue';
import WorkspaceSessionTreeDialog from './WorkspaceSessionTreeDialog.vue';

const props = defineProps<{
  nodeId: string;
  workspaceId: string;
  sessionId: string;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
}>();
const emit = defineEmits<{ open: [sessionId: string] }>();
const open = ref(false);
watch(
  () => [props.nodeId, props.workspaceId, props.sessionId],
  () => (open.value = false)
);
</script>

<template>
  <button
    type="button"
    class="icon-button utility-control conversation-tree-button"
    v-tooltip="translate('sessionGroups.tree')"
    :aria-label="translate('sessionGroups.tree')"
    :aria-expanded="open"
    aria-haspopup="dialog"
    @click="open = true"
  >
    <MarIcon name="session-tree" />
  </button>
  <WorkspaceSessionTreeDialog
    v-if="open"
    :node-id="nodeId"
    :workspace-id="workspaceId"
    :session-id="sessionId"
    :request="request"
    @close="open = false"
    @open="emit('open', $event)"
  />
</template>

<style scoped>
.conversation-tree-button {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 1.25rem;
  height: 1.25rem;
}
</style>
