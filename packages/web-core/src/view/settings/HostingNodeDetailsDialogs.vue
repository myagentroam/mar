<script setup lang="ts">
import { marIcon } from '../../util/mar-icons.js';
import { computed } from 'vue';
import type { ConversationHostingCapability } from '@myagentroam/protocol';
import type { ComputerUseCapability } from '@myagentroam/protocol';
import CoreDialogs from './NodeDetailsDialogs.vue';
import type { NodeDetailsProps, NodeDetailsHostingState } from '../../model/node-details.js';
export type { NodeDetailsHostingState } from '../../model/node-details.js';
import type { RunnerUsageName } from '../../model/runner-usage.js';
import ConversationHostingMaintenanceCard from './ConversationHostingMaintenanceCard.vue';
import { translate } from '../../service/locale-preference-service.js';
export type {
  NodeDetailsData,
  NodeDetailsRunnerCapability,
  NodeDetailsUpgradeState,
  WorkspaceDetailsData
} from './NodeDetailsDialogs.vue';

const props = defineProps<
  NodeDetailsProps & {
    hosting?: NodeDetailsHostingState | undefined;
    hostingCapability?: ConversationHostingCapability | undefined;
  }
>();
const emit = defineEmits<{
  'update:nodeOpen': [value: boolean];
  'update:workspaceOpen': [value: boolean];
  'update:usageOpen': [value: boolean];
  usage: [runner: RunnerUsageName];
  upgrade: [];
  cancelUpgrade: [];
  refreshNode: [];
  enableHosting: [];
  disableHosting: [];
  computerUseChanged: [capability: ComputerUseCapability];
}>();

const coreProps = computed(() => props);
</script>
<template>
  <CoreDialogs
    v-bind="coreProps"
    @update:node-open="emit('update:nodeOpen', $event)"
    @update:workspace-open="emit('update:workspaceOpen', $event)"
    @update:usage-open="emit('update:usageOpen', $event)"
    @usage="emit('usage', $event)"
    @upgrade="emit('upgrade')"
    @cancel-upgrade="emit('cancelUpgrade')"
    @refresh-node="emit('refreshNode')"
    @computer-use-changed="emit('computerUseChanged', $event)"
  >
    <template #node-properties>
      <el-descriptions-item
        v-if="hosting !== undefined"
        :label="translate('conversationHostingEnablement.title')"
      >
        <div class="hosting-enablement" :aria-busy="hosting.changing">
          <div class="hosting-enablement-actions">
            <el-button
              v-if="!hosting.enabled"
              type="primary"
              :icon="marIcon('success')"
              :loading="hosting.changing"
              :disabled="!hosting.canEnable"
              @click="emit('enableHosting')"
              :loading-icon="marIcon('loading-action')"
            >
              {{ translate('conversationHostingEnablement.enable') }}
            </el-button>
            <el-button
              v-else
              type="warning"
              :icon="marIcon('error')"
              :loading="hosting.changing"
              :disabled="!hosting.canDisable"
              @click="emit('disableHosting')"
              :loading-icon="marIcon('loading-action')"
            >
              {{ translate('conversationHostingEnablement.disable') }}
            </el-button>
          </div>
          <p class="hosting-enablement-hint">{{ hosting.hint }}</p>
        </div>
      </el-descriptions-item>
    </template>
    <template #node-sections>
      <ConversationHostingMaintenanceCard
        v-if="
          node !== undefined &&
          hosting !== undefined &&
          hosting.enabled &&
          hostingCapability !== undefined
        "
        :request="request"
        :node-id="node.id"
        :connected="node.connected"
        :disabled="node.disabled"
        :hosting-capability="hostingCapability"
        :writable="secretWritable === true"
      />
    </template>
  </CoreDialogs>
</template>
<style scoped>
.hosting-enablement {
  display: grid;
  gap: 8px;
}

.hosting-enablement-actions {
  display: flex;
}

.hosting-enablement-hint {
  margin: 0;
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
  line-height: 1.45;
}
</style>
