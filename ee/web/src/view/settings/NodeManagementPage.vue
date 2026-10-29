<script setup lang="ts">
import ResourceManagementPanel from './ResourceManagementPanel.vue';
import type { NodeSummary } from '@myagentroam/web-core/node-model';

defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly writable: boolean;
  readonly nodes?: readonly NodeSummary[];
  readonly nodeUpgradeProgress?:
    Readonly<Record<string, NonNullable<NodeSummary['upgradeProgress']> | null>> | undefined;
  readonly edition: 'COMMUNITY' | 'ENTERPRISE';
  readonly role: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER' | null;
}>();

const emit = defineEmits<{ changed: [] }>();
</script>

<template>
  <ResourceManagementPanel
    :request="request"
    :writable="writable"
    :nodes="nodes"
    :node-upgrade-progress="nodeUpgradeProgress"
    :edition="edition"
    :role="role"
    resource-type="NODE"
    @changed="emit('changed')"
  />
</template>
