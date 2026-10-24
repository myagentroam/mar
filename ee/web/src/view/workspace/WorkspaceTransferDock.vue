<script setup lang="ts">
import MarIcon from '@myagentroam/web-core/MarIcon.vue';
import type { WorkspaceUploadTask } from '@/service/workspace-upload-service';
import { translate } from '@/service/locale-preference-service';

defineProps<{
  readonly tasks: readonly WorkspaceUploadTask[];
  readonly progress: number;
  readonly activeCount: number;
  readonly collapsed: boolean;
  readonly statusLabel: (task: WorkspaceUploadTask) => string;
}>();

const emit = defineEmits<{
  'update:collapsed': [value: boolean];
  closeDock: [];
  retry: [task: WorkspaceUploadTask];
  cancel: [task: WorkspaceUploadTask];
  deleteTask: [task: WorkspaceUploadTask];
}>();
</script>

<template>
  <aside
    v-if="tasks.length"
    class="workspace-transfer-dock"
    :aria-label="translate('generated.workspaceTransferDock.fileTransfers')"
  >
    <header>
      <button type="button" @click="emit('update:collapsed', !collapsed)">
        {{ translate('generated.workspaceTransferDock.fileTransfers2') }} · {{ progress }}%
      </button>
      <button
        v-if="activeCount === 0"
        type="button"
        :aria-label="translate('generated.workspaceTransferDock.closeFileTransfers')"
        @click="emit('closeDock')"
      >
        <MarIcon name="close" />
      </button>
    </header>
    <div v-if="!collapsed" class="workspace-transfer-list">
      <div v-for="task in tasks" :key="task.id" class="workspace-transfer-row">
        <div>
          <strong v-tooltip="task.name">{{ task.name }}</strong>
          <small
            >{{ task.directory }} · {{ task.receivedBytes }} / {{ task.size }}
            {{ translate('generated.workspaceTransferDock.bytes') }}</small
          >
        </div>
        <progress :value="task.receivedBytes" :max="Math.max(task.size, 1)" />
        <span>{{ statusLabel(task) }}</span>
        <button
          v-if="task.status === 'FAILED' || task.status === 'INTERRUPTED'"
          type="button"
          @click="emit('retry', task)"
        >
          {{
            task.file === undefined
              ? translate('generated.workspaceTransferDock.resume')
              : translate('generated.workspaceTransferDock.retry')
          }}
        </button>
        <button
          v-if="task.status === 'QUEUED' || task.status === 'UPLOADING'"
          type="button"
          @click="emit('cancel', task)"
        >
          {{ translate('generated.workspaceTransferDock.cancel') }}
        </button>
        <button
          v-else-if="task.status !== 'COMPLETED'"
          type="button"
          @click="emit('deleteTask', task)"
        >
          {{ translate('generated.workspaceTransferDock.delete') }}
        </button>
      </div>
    </div>
  </aside>
</template>
