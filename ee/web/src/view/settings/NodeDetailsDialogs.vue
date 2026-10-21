<script setup lang="ts">
import { computed } from 'vue';
import type { ComputerUseCapability, ConversationHostingCapability } from '@myagentroam/protocol';
import CoreDialogs from '@myagentroam/web-core/HostingNodeDetailsDialogs.vue';
import type { NodeDetailsProps } from '@myagentroam/web-core/node-details';
import type { RunnerUsageName } from '@/service/RunnerUsageService';
import { translate } from '@/service/LocalePreferenceService';
export type {
  NodeDetailsData,
  NodeDetailsRunnerCapability,
  NodeDetailsUpgradeState,
  WorkspaceDetailsData
} from '@myagentroam/web-core/NodeDetailsDialogs.vue';
export type NodeDetailsOwnership =
  | { readonly ownerType: 'PERSONAL'; readonly ownerUserId: number }
  | { readonly ownerType: 'ORGANIZATION'; readonly ownerOrganizationId: number };

export interface NodeDetailsHostingState {
  readonly enabled: boolean;
  readonly canEnable: boolean;
  readonly canDisable: boolean;
  readonly hint: string;
  readonly changing: boolean;
}

const props = defineProps<
  NodeDetailsProps & {
    ownership?: NodeDetailsOwnership | undefined;
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
  enableHosting: [];
  disableHosting: [];
  computerUseChanged: [capability: ComputerUseCapability];
}>();

const ownershipTypeLabel = computed(() =>
  props.ownership?.ownerType === 'PERSONAL'
    ? translate('generated.resourceSharingPage.personal2')
    : translate('generated.resourceSharingPage.organization')
);
const ownershipTypeTag = computed<'info' | 'primary'>(() =>
  props.ownership?.ownerType === 'PERSONAL' ? 'info' : 'primary'
);

const coreProps = computed(() => ({
  nodeOpen: props.nodeOpen,
  workspaceOpen: props.workspaceOpen,
  usageOpen: props.usageOpen,
  ...(props.node === undefined ? {} : { node: props.node }),
  ...(props.workspace === undefined ? {} : { workspace: props.workspace }),
  ...(props.workspaceNodeId === undefined ? {} : { workspaceNodeId: props.workspaceNodeId }),
  ...(props.workspaceNodeLabel === undefined
    ? {}
    : { workspaceNodeLabel: props.workspaceNodeLabel }),
  ...(props.workspaceSecretManageable === undefined
    ? {}
    : { workspaceSecretManageable: props.workspaceSecretManageable }),
  ...(props.usage === undefined ? {} : { usage: props.usage }),
  ...(props.usageLoading === undefined ? {} : { usageLoading: props.usageLoading }),
  usageDisabledReason: props.usageDisabledReason,
  ...(props.ownerLabel === undefined ? {} : { ownerLabel: props.ownerLabel }),
  ...(props.secretWritable === undefined ? {} : { secretWritable: props.secretWritable }),
  ...(props.upgrade === undefined ? {} : { upgrade: props.upgrade }),
  request: props.request,
  ...(props.ownership === undefined
    ? {}
    : { ownershipTypeLabel: ownershipTypeLabel.value, ownershipTypeTag: ownershipTypeTag.value })
}));
</script>
<template>
  <CoreDialogs
    v-bind="{ ...props, ...coreProps }"
    @update:node-open="emit('update:nodeOpen', $event)"
    @update:workspace-open="emit('update:workspaceOpen', $event)"
    @update:usage-open="emit('update:usageOpen', $event)"
    @usage="emit('usage', $event)"
    @upgrade="emit('upgrade')"
    @cancel-upgrade="emit('cancelUpgrade')"
    @enable-hosting="emit('enableHosting')"
    @disable-hosting="emit('disableHosting')"
    @computer-use-changed="emit('computerUseChanged', $event)"
  />
</template>
