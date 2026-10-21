<script setup lang="ts">
import ResourceManagementPanel from './ResourceManagementPanel.vue';

defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly writable: boolean;
  readonly edition: 'COMMUNITY' | 'ENTERPRISE';
  readonly role: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER' | null;
}>();

const emit = defineEmits<{ changed: [] }>();
</script>

<template>
  <ResourceManagementPanel
    :request="request"
    :writable="writable"
    :edition="edition"
    :role="role"
    resource-type="WORKSPACE"
    @changed="emit('changed')"
  />
</template>
