<script setup lang="ts">
import { marIcon } from '../../util/mar-icons.js';
import { computed } from 'vue';
import { translate } from '../../service/locale-preference-service';
import type { ComputerUseCapability } from '@myagentroam/protocol';

type RuntimeCommand = {
  readonly id: 'npx' | 'git' | 'python' | 'pip';
  readonly command: string;
  readonly available: boolean;
  readonly version?: string;
  readonly path?: string;
};

const props = defineProps<{
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  readonly computerUse?: ComputerUseCapability | undefined;
  readonly refreshable?: boolean;
  readonly refreshing?: boolean;
}>();
const emit = defineEmits<{ refresh: [] }>();

const rows = computed(() => {
  const value = props.metadata?.['runtimeCommands'];
  if (!Array.isArray(value)) return [];
  return value.filter(isRuntimeCommand);
});

const commandIds = new Set<RuntimeCommand['id']>(['npx', 'git', 'python', 'pip']);

function isRuntimeCommand(value: unknown): value is RuntimeCommand {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  return (
    typeof command['id'] === 'string' &&
    commandIds.has(command['id'] as RuntimeCommand['id']) &&
    typeof command['command'] === 'string' &&
    typeof command['available'] === 'boolean' &&
    (command['version'] === undefined || typeof command['version'] === 'string') &&
    (command['path'] === undefined || typeof command['path'] === 'string')
  );
}

function computerUseStatus(capability: ComputerUseCapability): string {
  if (capability.state === 'DISABLED')
    return translate('generated.nodeRuntimeEnvironment.computerUseDisabled');
  if (capability.state === 'INITIALIZING')
    return translate('generated.nodeRuntimeEnvironment.computerUseInitializing');
  if (capability.state === 'AVAILABLE')
    return translate('generated.nodeRuntimeEnvironment.computerUseAvailable');
  return translate('generated.nodeRuntimeEnvironment.computerUseUnavailable', {
    reason: capability.reasonCode ?? translate('generated.nodeDetailsDialogs.unknown')
  });
}
</script>

<template>
  <div class="runtime-environment" :class="{ 'runtime-environment--refreshable': refreshable }">
    <div v-if="refreshable" class="runtime-environment-actions">
      <el-button
        link
        :icon="marIcon('refresh')"
        :loading="refreshing"
        @click="emit('refresh')"
        :loading-icon="marIcon('loading-action')"
      >
        {{ translate('generated.nodeDetailsDialogs.refreshCapabilities') }}
      </el-button>
    </div>
    <div v-if="rows.length || computerUse !== undefined" class="runtime-command-list">
      <div v-if="computerUse !== undefined" class="runtime-command-row">
        <code>{{ translate('generated.nodeRuntimeEnvironment.gui') }}</code>
        <el-tag
          :type="
            computerUse.state === 'AVAILABLE'
              ? 'success'
              : computerUse.state === 'UNAVAILABLE'
                ? 'danger'
                : 'info'
          "
          effect="plain"
        >
          {{ computerUseStatus(computerUse) }}
        </el-tag>
        <span class="runtime-command-version">{{
          translate('generated.nodeRuntimeEnvironment.pyAutoGui')
        }}</span>
      </div>
      <div v-for="row in rows" :key="row.id" class="runtime-command-row">
        <code>{{ row.command }}</code>
        <el-tag :type="row.available ? 'success' : 'info'" effect="plain">
          {{
            row.available
              ? translate('generated.nodeRuntimeEnvironment.available')
              : translate('generated.nodeRuntimeEnvironment.notFound')
          }}
        </el-tag>
        <span v-if="row.version" class="runtime-command-version">{{ row.version }}</span>
        <span v-tooltip="row.path" v-if="row.path" class="runtime-command-path">{{
          row.path
        }}</span>
      </div>
    </div>
    <span v-else>{{
      translate('generated.nodeRuntimeEnvironment.theNodeHasNotReportedItsEnvironment')
    }}</span>
  </div>
</template>

<style scoped>
.runtime-environment {
  position: relative;
  display: grid;
  gap: 8px;
  min-width: 0;
}

.runtime-environment--refreshable {
  padding-inline-end: 10rem;
}

.runtime-environment-actions {
  position: absolute;
  inset-block-start: 0;
  inset-inline-end: 0;
  z-index: 1;
  white-space: nowrap;
}

.runtime-command-list {
  display: grid;
  gap: 8px;
}

.runtime-command-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  color: var(--el-text-color-secondary);
  font-size: var(--mar-font-size-meta);
}

.runtime-command-row code {
  flex: 0 0 54px;
  color: var(--el-text-color-primary);
}

.runtime-command-version {
  flex: none;
  white-space: nowrap;
}

.runtime-command-path {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 520px) {
  .runtime-environment--refreshable {
    padding-inline-end: 0;
  }

  .runtime-environment-actions {
    position: static;
    display: flex;
    justify-content: flex-end;
  }
}
</style>
