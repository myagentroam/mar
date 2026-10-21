<script setup lang="ts">
import CorePage from '@myagentroam/web-core/McpCenterPanel.vue';
import { translate } from '@/service/LocalePreferenceService';
defineProps<{
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  nodes: readonly {
    readonly id: string;
    readonly displayName: string | null;
    readonly registeredAddress: string;
    readonly connected: boolean;
    readonly disabled: boolean;
    readonly nodeAppVersion: string;
  }[];
}>();
function scopeLabel(scope: string): string {
  return scope === 'ENTERPRISE'
    ? translate('generated.mcpCenterPanel.enterprise')
    : scope === 'ORGANIZATION'
      ? translate('generated.mcpCenterPanel.organization')
      : translate('generated.mcpCenterPanel.personal');
}
</script>
<template><CorePage :request="request" :nodes="nodes" :scope-label="scopeLabel" /></template>
