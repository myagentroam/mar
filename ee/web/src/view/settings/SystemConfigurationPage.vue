<script setup lang="ts">
import CorePage from '@myagentroam/web-core/SystemConfigurationPage.vue';
import type { SystemSettingDefinition } from '@myagentroam/web-core/system-configuration';
defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly writable: boolean;
}>();
const settings: readonly SystemSettingDefinition[] = [
  {
    key: 'audit-retention',
    field: 'auditRetentionDays',
    payloadField: 'days',
    initialValue: 180,
    nameKey: 'generated.systemConfigurationPage.auditRetentionDays',
    descriptionKey: 'generated.systemConfigurationPage.theServerRemovesExpiredEventsInBatches',
    type: 'number',
    min: 1,
    max: 3650,
    placeholderKey: 'generated.systemConfigurationPage.enterRetentionDays'
  }
];
</script>
<template>
  <CorePage :request="request" :writable="writable" :settings="settings" />
</template>
