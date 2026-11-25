<script setup lang="ts">
import { computed } from 'vue';
import { MarOption, MarSelect } from '@myagentroam/mar-ui/select';
import type {
  ScheduleScope,
  ScheduleWorkspaceOption
} from '../../service/scheduled-task-client.js';

const props = defineProps<{ workspaces: readonly ScheduleWorkspaceOption[] }>();
const workspace = defineModel<ScheduleScope | undefined>();
const key = ({ nodeId, workspaceId }: ScheduleScope) => JSON.stringify([nodeId, workspaceId]);
const options = computed(() =>
  props.workspaces
    .map((item) => ({
      key: key(item),
      label: `${item.workspaceName} · ${item.nodeName}`,
      scope: { nodeId: item.nodeId, workspaceId: item.workspaceId }
    }))
    .sort((left, right) => left.label.localeCompare(right.label))
);
</script>

<template>
  <div class="mar-filter-row">
    <label class="mar-filter-field">
      <span>{{ $t('generated.scheduledSession.workspace') }}</span>
      <MarSelect
        :model-value="workspace ? key(workspace) : undefined"
        :aria-label="$t('generated.scheduledSession.workspace')"
        :placeholder="$t('generated.scheduledSession.allWorkspaces')"
        clearable
        filterable
        @update:model-value="workspace = options.find((option) => option.key === $event)?.scope"
      >
        <MarOption
          v-for="option in options"
          :key="option.key"
          :label="option.label"
          :value="option.key"
        />
      </MarSelect>
    </label>
  </div>
</template>
