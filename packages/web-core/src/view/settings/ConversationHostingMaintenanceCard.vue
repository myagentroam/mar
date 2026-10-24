<script setup lang="ts">
import { showMessage } from '../../service/message-feedback-service.js';

import MarIcon from '../common/MarIcon.vue';
import { marIcon } from '../../util/mar-icons.js';
import { managementDateTime } from '../../util/time-presentation.js';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessageBox } from '../../service/message-box-service.js';
import type {
  ConversationHostingCleanupPreview,
  ConversationHostingCleanupResult,
  ConversationHostingCapability,
  ConversationHostingStorageCapacity
} from '@myagentroam/protocol';
import {
  conversationHostingMaintenanceAvailability,
  createConversationHostingMaintenanceService,
  sameConversationHostingMaintenanceContext
} from '../../service/conversation-hosting-maintenance-service.js';
import { currentLocale, translate } from '../../service/locale-preference-service.js';
import { errorMessage } from '../../util/workbench-presentation.js';

const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly nodeId: string;
  readonly connected: boolean | undefined;
  readonly disabled: boolean | undefined;
  readonly hostingCapability: ConversationHostingCapability | undefined;
  readonly writable: boolean;
}>();

const service = createConversationHostingMaintenanceService(props.request);
const storage = ref<ConversationHostingStorageCapacity>();
const preview = ref<ConversationHostingCleanupPreview>();
const previewNodeId = ref<string>();
const previewContextSequence = ref<number>();
const lastResult = ref<ConversationHostingCleanupResult>();
const inactiveDays = ref(60);
const loading = ref(false);
const previewing = ref(false);
const executing = ref(false);
const loadFailed = ref(false);
const contextSequence = ref(0);
let previewRequestSequence = 0;
let executeRequestSequence = 0;

const availability = computed(() =>
  conversationHostingMaintenanceAvailability(
    props.connected,
    props.disabled,
    props.hostingCapability
  )
);
const available = computed(() => availability.value.available);
const capacityLabel = computed(() => {
  if (storage.value?.capacity === 'HIGH')
    return translate('conversationHostingMaintenance.capacityHigh');
  if (storage.value?.capacity === 'FULL')
    return translate('conversationHostingMaintenance.capacityFull');
  return translate('conversationHostingMaintenance.capacityAvailable');
});
const capacityHint = computed(() => {
  if (storage.value?.capacity === 'HIGH')
    return translate('conversationHostingMaintenance.capacityHighHint');
  if (storage.value?.capacity === 'FULL')
    return translate('conversationHostingMaintenance.capacityFullHint');
  return translate('conversationHostingMaintenance.capacityAvailableHint');
});
const usageWidth = computed(
  () => `${Math.min(100, Math.max(0, (storage.value?.filesystemUsageBasisPoints ?? 0) / 100))}%`
);
const canExecuteCleanup = computed(() => {
  const current = preview.value;
  const nodeId = previewNodeId.value;
  const sequence = previewContextSequence.value;
  if (
    !available.value ||
    !props.writable ||
    current === undefined ||
    nodeId === undefined ||
    sequence === undefined ||
    current.candidateConversationCount === 0
  )
    return false;
  return sameConversationHostingMaintenanceContext(
    { nodeId, inactiveDays: current.inactiveDays, sequence },
    {
      nodeId: props.nodeId,
      inactiveDays: inactiveDays.value,
      sequence: contextSequence.value
    }
  );
});

function clearPreview(): void {
  preview.value = undefined;
  previewNodeId.value = undefined;
  previewContextSequence.value = undefined;
}

async function loadStorage(): Promise<void> {
  const nodeId = props.nodeId;
  const sequence = ++contextSequence.value;
  previewRequestSequence += 1;
  executeRequestSequence += 1;
  storage.value = undefined;
  clearPreview();
  lastResult.value = undefined;
  loadFailed.value = false;
  previewing.value = false;
  executing.value = false;
  if (!available.value) {
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const next = await service.storage(nodeId);
    if (
      !sameConversationHostingMaintenanceContext(
        { nodeId, sequence },
        { nodeId: props.nodeId, sequence: contextSequence.value }
      )
    )
      return;
    storage.value = next;
    inactiveDays.value = next.automaticCleanupInactiveDays;
  } catch (error) {
    if (
      !sameConversationHostingMaintenanceContext(
        { nodeId, sequence },
        { nodeId: props.nodeId, sequence: contextSequence.value }
      )
    )
      return;
    loadFailed.value = true;
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('conversationHostingMaintenance.loadFailed'),
      'error',
      error
    );
  } finally {
    if (
      sameConversationHostingMaintenanceContext(
        { nodeId, sequence },
        { nodeId: props.nodeId, sequence: contextSequence.value }
      )
    )
      loading.value = false;
  }
}

async function previewCleanup(): Promise<void> {
  if (!available.value) return;
  const requestContext = {
    nodeId: props.nodeId,
    inactiveDays: inactiveDays.value,
    sequence: contextSequence.value
  };
  const requestSequence = ++previewRequestSequence;
  previewing.value = true;
  lastResult.value = undefined;
  clearPreview();
  try {
    const next = await service.preview(requestContext.nodeId, requestContext.inactiveDays);
    if (
      requestSequence !== previewRequestSequence ||
      !sameConversationHostingMaintenanceContext(requestContext, {
        nodeId: props.nodeId,
        inactiveDays: inactiveDays.value,
        sequence: contextSequence.value
      })
    )
      return;
    preview.value = next;
    previewNodeId.value = requestContext.nodeId;
    previewContextSequence.value = requestContext.sequence;
  } catch (error) {
    if (
      requestSequence !== previewRequestSequence ||
      !sameConversationHostingMaintenanceContext(requestContext, {
        nodeId: props.nodeId,
        inactiveDays: inactiveDays.value,
        sequence: contextSequence.value
      })
    )
      return;
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('conversationHostingMaintenance.previewFailed'),
      'error',
      error
    );
  } finally {
    if (requestSequence === previewRequestSequence) previewing.value = false;
  }
}

async function executeCleanup(): Promise<void> {
  const current = preview.value;
  const nodeId = previewNodeId.value;
  const sequence = previewContextSequence.value;
  if (
    !canExecuteCleanup.value ||
    current === undefined ||
    nodeId === undefined ||
    sequence === undefined
  )
    return;
  const requestContext = {
    nodeId,
    inactiveDays: current.inactiveDays,
    sequence
  };
  try {
    await ElMessageBox.confirm(
      translate('conversationHostingMaintenance.executeConfirm', {
        count: current.candidateConversationCount,
        bytes: formatBytes(current.reclaimableBytes),
        days: current.inactiveDays
      }),
      translate('conversationHostingMaintenance.executeConfirmTitle'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('conversationHostingMaintenance.execute'),
        cancelButtonText: translate('conversationHostingMaintenance.cancel')
      }
    );
  } catch (error) {
    if (error === 'cancel' || error === 'close') return;
    throw error;
  }
  if (
    preview.value !== current ||
    !sameConversationHostingMaintenanceContext(requestContext, {
      nodeId: props.nodeId,
      inactiveDays: inactiveDays.value,
      sequence: contextSequence.value
    })
  )
    return;
  const requestSequence = ++executeRequestSequence;
  executing.value = true;
  try {
    const nextResult = await service.execute(requestContext.nodeId, requestContext.inactiveDays);
    if (
      requestSequence !== executeRequestSequence ||
      !sameConversationHostingMaintenanceContext(requestContext, {
        nodeId: props.nodeId,
        inactiveDays: inactiveDays.value,
        sequence: contextSequence.value
      })
    )
      return;
    lastResult.value = nextResult;
    clearPreview();
    showMessage(translate('conversationHostingMaintenance.cleanupComplete'), 'success');
    try {
      const nextStorage = await service.storage(requestContext.nodeId);
      if (
        requestSequence !== executeRequestSequence ||
        !sameConversationHostingMaintenanceContext(requestContext, {
          nodeId: props.nodeId,
          inactiveDays: inactiveDays.value,
          sequence: contextSequence.value
        })
      )
        return;
      storage.value = nextStorage;
      loadFailed.value = false;
    } catch (error) {
      if (
        requestSequence !== executeRequestSequence ||
        !sameConversationHostingMaintenanceContext(requestContext, {
          nodeId: props.nodeId,
          inactiveDays: inactiveDays.value,
          sequence: contextSequence.value
        })
      )
        return;
      loadFailed.value = true;
      showMessage(
        error instanceof Error
          ? errorMessage(error)
          : translate('conversationHostingMaintenance.loadFailed'),
        'error',
        error
      );
    }
  } catch (error) {
    if (
      requestSequence !== executeRequestSequence ||
      !sameConversationHostingMaintenanceContext(requestContext, {
        nodeId: props.nodeId,
        inactiveDays: inactiveDays.value,
        sequence: contextSequence.value
      })
    )
      return;
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('conversationHostingMaintenance.executeFailed'),
      'error',
      error
    );
  } finally {
    if (requestSequence === executeRequestSequence) executing.value = false;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1_024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1_024; index += 1) {
    value /= 1_024;
    unit = units[index]!;
  }
  return `${new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}

function formatUsage(basisPoints: number): string {
  return `${new Intl.NumberFormat(currentLocale(), {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(basisPoints / 100)}%`;
}

function formatTime(value: number): string {
  return managementDateTime(value);
}

watch(
  () => [props.nodeId, props.connected, props.disabled, props.hostingCapability],
  () => void loadStorage()
);
watch(inactiveDays, () => {
  previewRequestSequence += 1;
  previewing.value = false;
  clearPreview();
});
onMounted(loadStorage);
onBeforeUnmount(() => {
  contextSequence.value += 1;
  previewRequestSequence += 1;
  executeRequestSequence += 1;
  clearPreview();
});
</script>

<template>
  <section class="hosting-maintenance-card" :aria-busy="loading || previewing || executing">
    <header class="hosting-maintenance-header">
      <div>
        <span class="hosting-maintenance-eyebrow">{{
          translate('conversationHostingMaintenance.eyebrow')
        }}</span>
        <h3>{{ translate('conversationHostingMaintenance.title') }}</h3>
        <p>{{ translate('conversationHostingMaintenance.summary') }}</p>
      </div>
      <el-button
        :icon="marIcon('refresh')"
        circle
        :loading="loading"
        :disabled="!available || previewing || executing"
        :aria-label="translate('conversationHostingMaintenance.refresh')"
        @click="loadStorage"
        :loading-icon="marIcon('loading-action')"
      />
    </header>

    <el-alert
      v-if="availability.reasonCode === 'CONVERSATION_HOSTING_MAINTENANCE_NODE_OFFLINE'"
      type="warning"
      :closable="false"
      :title="translate('conversationHostingMaintenance.nodeOffline')"
    />
    <el-alert
      v-else-if="!available"
      type="warning"
      :closable="false"
      :title="translate('conversationHostingMaintenance.hostingUnavailable')"
      :description="
        translate('conversationHostingMaintenance.hostingUnavailableDetail', {
          code: availability.reasonCode ?? 'CONVERSATION_HOSTING_MAINTENANCE_UNAVAILABLE'
        })
      "
    />
    <el-alert
      v-else-if="loadFailed"
      type="error"
      :closable="false"
      :title="translate('conversationHostingMaintenance.loadFailed')"
    />

    <template v-else-if="storage">
      <div class="capacity-readout" :data-capacity="storage.capacity">
        <div class="capacity-copy">
          <div>
            <strong>{{ capacityLabel }}</strong>
            <span>{{ formatUsage(storage.filesystemUsageBasisPoints) }}</span>
          </div>
          <p>{{ capacityHint }}</p>
        </div>
        <div
          class="capacity-track"
          role="img"
          :aria-label="
            translate('conversationHostingMaintenance.capacityAria', {
              usage: formatUsage(storage.filesystemUsageBasisPoints)
            })
          "
        >
          <span class="capacity-fill" :style="{ width: usageWidth }" />
          <span class="capacity-marker capacity-marker-high" />
          <span class="capacity-marker capacity-marker-full" />
        </div>
        <div class="capacity-scale">
          <span>0%</span><span>85%</span><span>95%</span><span>100%</span>
        </div>
      </div>

      <dl class="storage-facts">
        <div>
          <dt>{{ translate('conversationHostingMaintenance.hostedStorage') }}</dt>
          <dd>{{ formatBytes(storage.hostedStorageUsedBytes) }}</dd>
        </div>
        <div>
          <dt>{{ translate('conversationHostingMaintenance.filesystemAvailable') }}</dt>
          <dd>
            {{ formatBytes(storage.filesystemAvailableBytes) }} /
            {{ formatBytes(storage.filesystemTotalBytes) }}
          </dd>
        </div>
        <div>
          <dt>{{ translate('conversationHostingMaintenance.automaticCleanup') }}</dt>
          <dd>
            {{
              translate('conversationHostingMaintenance.daysValue', {
                days: storage.automaticCleanupInactiveDays
              })
            }}
          </dd>
        </div>
        <div>
          <dt>{{ translate('conversationHostingMaintenance.measuredAt') }}</dt>
          <dd>{{ formatTime(storage.measuredAt) }}</dd>
        </div>
      </dl>

      <div class="cleanup-console">
        <div class="cleanup-heading">
          <div>
            <h4>{{ translate('conversationHostingMaintenance.cleanupTitle') }}</h4>
            <p>{{ translate('conversationHostingMaintenance.cleanupSummary') }}</p>
          </div>
          <el-input-number
            v-model="inactiveDays"
            :min="1"
            :max="365"
            :step="1"
            step-strictly
            :disabled="previewing || executing"
            :aria-label="translate('conversationHostingMaintenance.inactiveDays')"
            ><template #decrease-icon><MarIcon name="subtract" /></template
            ><template #increase-icon><MarIcon name="plus" /></template
          ></el-input-number>
        </div>
        <p class="cleanup-range">{{ translate('conversationHostingMaintenance.rangeHint') }}</p>
        <div class="cleanup-actions">
          <el-button
            :icon="marIcon('view')"
            :loading="previewing"
            @click="previewCleanup"
            :loading-icon="marIcon('loading-action')"
            >{{ translate('conversationHostingMaintenance.preview') }}</el-button
          >
          <el-button
            type="danger"
            plain
            :icon="marIcon('delete')"
            :loading="executing"
            :disabled="!canExecuteCleanup"
            @click="executeCleanup"
            :loading-icon="marIcon('loading-action')"
            >{{ translate('conversationHostingMaintenance.permanentCleanup') }}</el-button
          >
        </div>

        <div v-if="preview" class="cleanup-result cleanup-preview">
          <span>{{ translate('conversationHostingMaintenance.previewResult') }}</span>
          <strong>{{
            translate('conversationHostingMaintenance.candidateValue', {
              count: preview.candidateConversationCount
            })
          }}</strong>
          <span>{{
            translate('conversationHostingMaintenance.reclaimableValue', {
              bytes: formatBytes(preview.reclaimableBytes)
            })
          }}</span>
          <small>{{ formatTime(preview.measuredAt) }}</small>
        </div>
        <div v-if="lastResult" class="cleanup-result cleanup-complete">
          <span>{{ translate('conversationHostingMaintenance.lastCleanup') }}</span>
          <strong>{{
            translate('conversationHostingMaintenance.deletedValue', {
              count: lastResult.deletedConversationCount
            })
          }}</strong>
          <span>{{
            translate('conversationHostingMaintenance.cleanupResultDetail', {
              bytes: formatBytes(lastResult.releasedBytes),
              skipped: lastResult.skippedConversationCount
            })
          }}</span>
          <small>{{ formatTime(lastResult.completedAt) }}</small>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.hosting-maintenance-card {
  display: grid;
  gap: 14px;
  margin-top: 12px;
  padding: 14px;
  border: 1px solid var(--mar-border-default);
  border-radius: var(--el-border-radius-base);
  background: var(--mar-bg-panel);
}
.hosting-maintenance-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.hosting-maintenance-header h3,
.cleanup-heading h4 {
  margin: 2px 0 0;
  color: var(--mar-text-primary);
}
.hosting-maintenance-header p,
.cleanup-heading p,
.capacity-copy p,
.cleanup-range {
  margin: 4px 0 0;
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
  line-height: 1.5;
}
.hosting-maintenance-eyebrow {
  color: var(--mar-color-brand-text);
  font-size: var(--mar-font-size-meta);
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.capacity-readout {
  display: grid;
  gap: 7px;
  padding: 13px 14px;
  border: 1px solid var(--mar-border-subtle);
  border-radius: var(--el-border-radius-base);
  background: var(--mar-fill-subtle);
}
.capacity-copy > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.capacity-copy strong {
  color: var(--mar-text-primary);
}
.capacity-copy span {
  color: var(--mar-text-secondary);
  font-variant-numeric: tabular-nums;
}
.capacity-track {
  position: relative;
  height: 10px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--mar-border-subtle) 70%, transparent);
}
.capacity-fill {
  position: absolute;
  inset: 0 auto 0 0;
  min-width: 2px;
  border-radius: inherit;
  background: var(--el-color-success);
  transition: width 220ms ease;
}
.capacity-readout[data-capacity='HIGH'] .capacity-fill {
  background: var(--el-color-warning);
}
.capacity-readout[data-capacity='FULL'] .capacity-fill {
  background: var(--el-color-danger);
}
.capacity-marker {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 1px;
  background: color-mix(in srgb, var(--mar-text-primary) 52%, transparent);
}
.capacity-marker-high {
  left: 85%;
}
.capacity-marker-full {
  left: 95%;
}
.capacity-scale {
  display: grid;
  grid-template-columns: 85fr 10fr 5fr;
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-nano);
  font-variant-numeric: tabular-nums;
}
.capacity-scale span:nth-child(2),
.capacity-scale span:nth-child(3) {
  transform: translateX(-50%);
}
.capacity-scale span:last-child {
  justify-self: end;
}
.storage-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--mar-border-subtle);
  border-radius: var(--el-border-radius-base);
  background: var(--mar-border-subtle);
}
.storage-facts > div {
  min-width: 0;
  padding: 10px 12px;
  background: var(--mar-bg-panel);
}
.storage-facts dt {
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
}
.storage-facts dd {
  margin: 3px 0 0;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-body);
  font-variant-numeric: tabular-nums;
}
.cleanup-console {
  display: grid;
  gap: 10px;
  padding-top: 2px;
}
.cleanup-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.cleanup-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.cleanup-result {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 6px 12px;
  padding: 10px 12px;
  border-radius: var(--el-border-radius-base);
  color: var(--mar-text-secondary);
  background: color-mix(in srgb, var(--mar-color-brand-text) 8%, var(--mar-bg-panel));
}
.cleanup-result strong {
  color: var(--mar-text-primary);
}
.cleanup-result small {
  grid-column: 1 / -1;
  color: var(--mar-text-muted);
}
.cleanup-complete {
  background: color-mix(in srgb, var(--el-color-success) 9%, var(--mar-bg-panel));
}
@media (prefers-reduced-motion: reduce) {
  .capacity-fill {
    transition: none;
  }
}
@media (max-width: 640px) {
  .storage-facts {
    grid-template-columns: 1fr;
  }
  .cleanup-heading {
    align-items: stretch;
    flex-direction: column;
  }
  .cleanup-heading :deep(.el-input-number) {
    width: 100%;
  }
  .cleanup-result {
    grid-template-columns: 1fr;
  }
}
</style>
