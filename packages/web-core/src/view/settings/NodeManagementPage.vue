<script setup lang="ts">
import ResourceManagementPanel from './ResourceManagementPanel.vue';
import type { NodeSummary } from '../../model/node.js';
import type { NodeUpgradeProgress } from '../../model/node-upgrade.js';

defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly writable: boolean;
  readonly openRegistrationOnEntry?: boolean;
  readonly nodes?: readonly NodeSummary[];
  readonly nodeUpgradeProgress?: Readonly<Record<string, NodeUpgradeProgress | null>> | undefined;
}>();

const emit = defineEmits<{ changed: [] }>();
</script>

<template>
  <ResourceManagementPanel
    :request="request"
    :writable="writable"
    :open-registration-on-entry="openRegistrationOnEntry"
    :nodes="nodes"
    :node-upgrade-progress="nodeUpgradeProgress"
    resource-type="NODE"
    @changed="emit('changed')"
  />
</template>
