<script setup lang="ts">
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import { showMessage } from '../../service/message-feedback-service.js';

import { marIcon } from '../../util/mar-icons.js';
import { managementDateTime } from '../../util/time-presentation.js';

import { ref, watch } from 'vue';
import type { ComputerUseCapability } from '@myagentroam/protocol';
import { runnerUsageWindowLabel, type RunnerUsageName } from '../../service/runner-usage-service';
import EnvironmentSecretManager from './EnvironmentSecretManager.vue';
import NodeRuntimeEnvironment from './NodeRuntimeEnvironment.vue';
import WorkspaceGitSettings from './WorkspaceGitSettings.vue';
import { translate } from '../../service/locale-preference-service';
import { runnerLabel, workspaceKindLabel } from '../../util/workbench-presentation';
import { createComputerUseEnablementService } from '../../service/computer-use-enablement-service.js';
import { errorMessage } from '../../util/workbench-presentation';

import type { NodeDetailsData, NodeDetailsProps } from '../../model/node-details.js';
export type {
  NodeDetailsData,
  NodeDetailsProps,
  NodeDetailsRunnerCapability,
  NodeDetailsUpgradeState,
  WorkspaceDetailsData
} from '../../model/node-details.js';
const props = defineProps<NodeDetailsProps>();

const emit = defineEmits<{
  'update:nodeOpen': [value: boolean];
  'update:workspaceOpen': [value: boolean];
  'update:usageOpen': [value: boolean];
  usage: [runner: RunnerUsageName];
  upgrade: [];
  cancelUpgrade: [];
  refreshNode: [];
  computerUseChanged: [capability: ComputerUseCapability];
}>();
const computerUseChanging = ref(false);
const computerUseCapability = ref<ComputerUseCapability>();
const computerUse = createComputerUseEnablementService(props.request);
watch(
  () => [props.node?.id, props.node?.capabilities?.computerUse] as const,
  ([, capability]) => {
    computerUseCapability.value = capability;
  },
  { immediate: true }
);

async function setComputerUse(enabled: boolean): Promise<void> {
  const node = props.node;
  if (node === undefined || computerUseChanging.value) return;
  computerUseChanging.value = true;
  try {
    const capability = enabled
      ? await computerUse.enable(node.id)
      : await computerUse.disable(node.id);
    computerUseCapability.value = capability;
    emit('computerUseChanged', capability);
  } catch (error) {
    showMessage(errorMessage(error), 'error', error);
  } finally {
    computerUseChanging.value = false;
  }
}

function nodeStatus(node: NodeDetailsData): { label: string; type: 'success' | 'danger' | 'info' } {
  if (node.disabled === true)
    return { label: translate('generated.nodeDetailsDialogs.disabled'), type: 'danger' };
  if (node.connected === true)
    return { label: translate('generated.nodeDetailsDialogs.online'), type: 'success' };
  return { label: translate('generated.nodeDetailsDialogs.offline'), type: 'info' };
}

function osVersionLabel(node: NodeDetailsData): string | undefined {
  const metadata = node.metadata as
    { readonly osVersion?: string; readonly osRelease?: string } | undefined;
  return metadata?.osVersion ?? metadata?.osRelease;
}

type SupportedAgent = {
  readonly runner: 'codex' | 'claude-code' | 'opencode';
  readonly label: string;
  readonly version?: string;
};

function supportedAgents(node: NodeDetailsData): readonly SupportedAgent[] {
  const capabilities = node.capabilities;
  if (capabilities === undefined) return [];
  return [
    { runner: 'codex' as const, label: runnerLabel('codex'), ...capabilities.codex },
    {
      runner: 'claude-code' as const,
      label: runnerLabel('claude-code'),
      ...capabilities.claudeCode
    },
    { runner: 'opencode' as const, label: runnerLabel('opencode'), ...capabilities.openCode }
  ].filter((entry) => entry.available === true);
}

function supportedAgentTitle(entry: SupportedAgent): string {
  return `${entry.label} · ${entry.version ?? translate('generated.nodeDetailsDialogs.available')}`;
}

function usageTimestampLabel(value: number | null): string {
  return value === null
    ? translate('generated.runnerUsageService.notProvided')
    : managementDateTime(value);
}

function usagePercentageLabel(value: number): string {
  return `${Math.max(0, Math.round(value * 10) / 10)}%`;
}
</script>

<template>
  <el-dialog
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    v-if="nodeOpen"
    :model-value="nodeOpen"
    class="node-details-dialog"
    :title="translate('generated.nodeDetailsDialogs.nodeDetails')"
    width="min(720px, calc(100vw - 32px))"
    @update:model-value="emit('update:nodeOpen', $event)"
    :close-icon="marIcon('close')"
  >
    <el-descriptions v-if="node !== undefined" class="mar-detail-descriptions" :column="1" border>
      <el-descriptions-item :label="translate('common.nodeId')"
        ><code>{{ node.id }}</code></el-descriptions-item
      >
      <el-descriptions-item :label="translate('generated.nodeDetailsDialogs.name')">{{
        node.label
      }}</el-descriptions-item>
      <el-descriptions-item
        v-if="ownershipTypeLabel !== undefined"
        :label="translate('generated.resourceSharingPage.ownershipType')"
        ><el-tag :type="ownershipTypeTag ?? 'info'" effect="light">{{
          ownershipTypeLabel
        }}</el-tag></el-descriptions-item
      >
      <el-descriptions-item
        v-if="ownerLabel !== undefined"
        :label="translate('generated.resourceSharingPage.owner3')"
        >{{ ownerLabel }}</el-descriptions-item
      >
      <el-descriptions-item
        v-if="node.registeredAddress !== undefined"
        :label="translate('generated.nodeDetailsDialogs.registeredAddress')"
        >{{ node.registeredAddress }}</el-descriptions-item
      >
      <el-descriptions-item
        v-if="node.platform !== undefined"
        :label="translate('generated.nodeDetailsDialogs.system')"
      >
        {{ node.platform }} /
        {{ node.architecture ?? translate('generated.nodeDetailsDialogs.unknown')
        }}<template v-if="osVersionLabel(node) !== undefined">
          · {{ osVersionLabel(node) }}</template
        >
      </el-descriptions-item>
      <el-descriptions-item
        v-if="node.nodeAppVersion !== undefined"
        :label="translate('generated.nodeDetailsDialogs.nodeVersion')"
        >{{ node.nodeAppVersion }}</el-descriptions-item
      >
      <slot name="node-properties" :node="node" />
      <el-descriptions-item
        v-if="computerUseCapability !== undefined"
        :label="translate('generated.nodeDetailsDialogs.computerUse')"
      >
        <div class="computer-use-control">
          <el-switch
            :model-value="computerUseCapability.enabled"
            :loading="computerUseChanging"
            :disabled="
              computerUseChanging ||
              node.manageable !== true ||
              node.connected !== true ||
              node.disabled === true
            "
            @change="setComputerUse(Boolean($event))"
          />
          <span>{{
            translate(
              computerUseCapability.enabled
                ? 'generated.nodeDetailsDialogs.computerUseEnabled'
                : 'generated.nodeDetailsDialogs.computerUseDisabled'
            )
          }}</span>
        </div>
      </el-descriptions-item>
      <el-descriptions-item
        v-if="upgrade !== undefined"
        :label="translate('generated.resourceSharingPage.upgradeStatus2')"
        >{{ upgrade.label }}</el-descriptions-item
      >
      <el-descriptions-item :label="translate('common.nodeJs')">{{
        node.nodeVersion ?? translate('generated.nodeDetailsDialogs.unknown')
      }}</el-descriptions-item>
      <el-descriptions-item :label="translate('generated.nodeDetailsDialogs.toolEnvironment')">
        <NodeRuntimeEnvironment
          :metadata="node.metadata"
          :computer-use="computerUseCapability"
          :refreshable="nodeRefreshable"
          :refreshing="nodeRefreshing"
          @refresh="emit('refreshNode')"
        />
      </el-descriptions-item>
      <el-descriptions-item
        v-if="node.connected !== undefined"
        :label="translate('generated.nodeDetailsDialogs.status')"
        ><el-tag :type="nodeStatus(node).type" effect="light">{{
          nodeStatus(node).label
        }}</el-tag></el-descriptions-item
      >
      <el-descriptions-item :label="translate('generated.nodeDetailsDialogs.supportedAgents')">
        <div v-if="supportedAgents(node).length > 0" class="supported-agent-list">
          <div v-for="entry in supportedAgents(node)" :key="entry.runner">
            <span v-tooltip="supportedAgentTitle(entry)" class="supported-agent-label">{{
              supportedAgentTitle(entry)
            }}</span>
            <el-button
              v-tooltip="{
                content: usageDisabledReason(entry.runner),
                disabled: usageDisabledReason(entry.runner) === ''
              }"
              v-if="entry.runner !== 'opencode'"
              class="runner-usage-link"
              link
              type="primary"
              :loading="usageLoading === entry.runner"
              :disabled="usageDisabledReason(entry.runner) !== ''"
              @click="emit('usage', entry.runner)"
              :loading-icon="marIcon('loading-action')"
            >
              {{ translate('common.usage') }}
            </el-button>
          </div>
        </div>
        <span v-else>{{ translate('generated.nodeDetailsDialogs.none') }}</span>
      </el-descriptions-item>
    </el-descriptions>
    <slot name="node-sections" :node="node" />
    <div
      v-if="node !== undefined && (node.secretManageable ?? node.manageable) === true"
      class="node-secret-section"
    >
      <div class="node-secret-manager">
        <EnvironmentSecretManager
          :request="request"
          :scopes="['NODE']"
          :node-id="node.id"
          :active="nodeOpen"
          :writable="secretWritable === true"
        />
      </div>
    </div>
    <template #footer>
      <div v-if="upgrade?.canUpgrade || upgrade?.waitingForRuns" class="node-detail-actions">
        <el-button v-if="upgrade?.canUpgrade" :icon="marIcon('upload')" @click="emit('upgrade')">{{
          translate('generated.resourceSharingPage.pushUpgrade2')
        }}</el-button>
        <el-button
          v-if="upgrade?.waitingForRuns"
          :icon="marIcon('close')"
          :disabled="!upgrade.canCancelUpgrade"
          @click="emit('cancelUpgrade')"
          >{{ translate('generated.resourceSharingPage.cancelUpgrade') }}</el-button
        >
      </div>
      <el-button @click="emit('update:nodeOpen', false)">{{
        translate('generated.nodeDetailsDialogs.close')
      }}</el-button>
    </template>
  </el-dialog>
  <el-dialog
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    v-if="workspaceOpen"
    :model-value="workspaceOpen"
    class="node-details-dialog"
    :title="translate('generated.resourceSharingPage.workspaceDetails')"
    width="min(720px, calc(100vw - 32px))"
    @update:model-value="emit('update:workspaceOpen', $event)"
    :close-icon="marIcon('close')"
  >
    <el-descriptions
      v-if="workspace !== undefined"
      class="mar-detail-descriptions"
      :column="1"
      border
    >
      <el-descriptions-item :label="translate('common.workspaceId')"
        ><code>{{ workspace.id }}</code></el-descriptions-item
      >
      <el-descriptions-item :label="translate('generated.resourceSharingPage.workspaceName3')">{{
        workspace.label
      }}</el-descriptions-item>
      <el-descriptions-item
        v-if="ownershipTypeLabel !== undefined"
        :label="translate('generated.resourceSharingPage.ownershipType')"
        ><el-tag :type="ownershipTypeTag ?? 'info'" effect="light">{{
          ownershipTypeLabel
        }}</el-tag></el-descriptions-item
      >
      <el-descriptions-item
        v-if="ownerLabel !== undefined"
        :label="translate('generated.resourceSharingPage.owner3')"
        >{{ ownerLabel }}</el-descriptions-item
      >
      <el-descriptions-item
        v-if="workspaceNodeLabel !== undefined"
        :label="translate('generated.resourceSharingPage.node')"
        >{{ workspaceNodeLabel }}</el-descriptions-item
      >
      <el-descriptions-item :label="translate('generated.resourceSharingPage.fullPath')">{{
        workspace.path ?? translate('generated.resourceSharingPage.theNodeIsOfflineThePathIs')
      }}</el-descriptions-item>
      <el-descriptions-item
        v-if="workspace.kind !== undefined"
        :label="translate('generated.resourceSharingPage.type')"
        >{{
          workspaceKindLabel({ id: workspace.id, path: workspace.path ?? '', kind: workspace.kind })
        }}</el-descriptions-item
      >
      <el-descriptions-item
        v-if="workspace.kind === 'GIT_WORKSPACE'"
        :label="translate('generated.resourceSharingPage.branch')"
        >{{ workspace.gitSummary?.branch ?? '-' }}</el-descriptions-item
      >
    </el-descriptions>
    <WorkspaceGitSettings
      v-if="workspace !== undefined && workspaceNodeId !== undefined"
      :key="`${workspaceNodeId}:${workspace.id}`"
      :request="request"
      :node-id="workspaceNodeId"
      :workspace-id="workspace.id"
      :connected="workspaceNodeConnected === true"
      :writable="workspaceGitManageable === true && secretWritable === true"
      :initial-value="workspace.preserveGitConfig"
    />
    <div
      v-if="
        workspace !== undefined &&
        workspaceNodeId !== undefined &&
        workspaceSecretManageable === true
      "
      class="node-secret-section"
    >
      <div class="node-secret-manager">
        <EnvironmentSecretManager
          :request="request"
          :scopes="['WORKSPACE']"
          :key="`${workspaceNodeId}:${workspace.id}`"
          :node-id="workspaceNodeId"
          :workspace-id="workspace.id"
          :active="workspaceOpen"
          :writable="secretWritable === true"
        />
      </div>
    </div>
    <template #footer>
      <el-button @click="emit('update:workspaceOpen', false)">{{
        translate('generated.nodeDetailsDialogs.close')
      }}</el-button>
    </template>
  </el-dialog>
  <el-dialog
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    v-if="usageOpen"
    :model-value="usageOpen"
    class="runner-usage-dialog"
    :title="
      usage !== undefined
        ? usage.runner === 'claude-code'
          ? translate('nodeMessages.claudeUsage')
          : translate('nodeMessages.codexUsage')
        : ''
    "
    width="min(460px, calc(100vw - 32px))"
    @update:model-value="emit('update:usageOpen', $event)"
    :close-icon="marIcon('close')"
  >
    <el-descriptions v-if="usage !== undefined" class="mar-detail-descriptions" :column="1" border>
      <el-descriptions-item
        v-for="window in usage.windows"
        :key="window.id"
        :label="runnerUsageWindowLabel(window)"
      >
        <div class="runner-usage-window">
          <el-progress
            :percentage="Math.round(window.usedPercentage * 10) / 10"
            :show-text="false"
            :stroke-width="8"
          />
          <strong>{{ usagePercentageLabel(window.usedPercentage) }}</strong>
          <span
            >{{ translate('generated.nodeDetailsDialogs.resets')
            }}{{ usageTimestampLabel(window.resetsAt) }}</span
          >
        </div>
      </el-descriptions-item>
      <el-descriptions-item :label="translate('generated.nodeDetailsDialogs.updated')">
        {{ usageTimestampLabel(usage.fetchedAt) }}
      </el-descriptions-item>
    </el-descriptions>
    <template #footer>
      <el-button @click="emit('update:usageOpen', false)">{{
        translate('generated.nodeDetailsDialogs.close2')
      }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.runner-usage-link {
  margin-left: 0.45rem;
  vertical-align: baseline;
}

.supported-agent-list {
  display: grid;
  gap: 4px;
}

.runner-usage-window {
  display: grid;
  grid-template-columns: minmax(92px, 1fr) auto;
  align-items: center;
  column-gap: 0.7rem;
  row-gap: 0.28rem;
  min-width: 0;
}

.runner-usage-window strong {
  color: var(--mar-color-brand-text);
  font-size: var(--mar-font-size-body);
  font-variant-numeric: tabular-nums;
}

.runner-usage-window span {
  grid-column: 1 / -1;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
  font-variant-numeric: tabular-nums;
}
</style>

<style scoped>
.node-secret-section {
  padding-top: 12px;
  border-top: 1px solid var(--mar-border-default);
}

.node-detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.node-detail-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

:global(.node-details-dialog .el-dialog__title) {
  font-size: var(--mar-font-size-title);
  font-weight: 600;
}

:global(.node-details-dialog .el-dialog__body) {
  padding-top: 10px;
  font-size: var(--mar-font-size-body);
}

:global(.runner-usage-dialog .el-descriptions__label) {
  width: 108px;
}

:global(.runner-usage-window .el-progress) {
  min-width: 0;
}

@media (max-width: 480px) {
  :global(.node-details-dialog .el-dialog__body) {
    overflow-x: hidden;
  }

  .supported-agent-list > div {
    align-items: flex-start;
  }

  .runner-usage-link {
    flex: none;
    margin-top: -0.2rem;
  }
}
</style>
