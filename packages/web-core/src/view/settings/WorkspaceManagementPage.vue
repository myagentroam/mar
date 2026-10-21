<script setup lang="ts">
import ResourceManagementPanel from './ResourceManagementPanel.vue';

defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly writable: boolean;
}>();

const emit = defineEmits<{ changed: [] }>();
</script>

<template>
  <ResourceManagementPanel
    :request="request"
    :writable="writable"
    resource-type="WORKSPACE"
    @changed="emit('changed')"
  />
</template>
