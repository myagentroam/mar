<script setup lang="ts">
import type { ToolPresentation } from '@myagentroam/protocol';
import MarIcon from '../common/MarIcon.vue';

defineProps<{
  kind: 'reasoning' | 'command_execution' | 'tool_call' | 'file_change' | ToolPresentation['kind'];
}>();
</script>

<template>
  <MarIcon v-if="kind === 'reasoning'" name="reasoning" />
  <svg
    v-else
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <template v-if="kind === 'command_execution'">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m7 9 3 3-3 3m6 0h4" />
    </template>
    <template v-else-if="kind === 'READ'">
      <path d="M13 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9l-6-6Zm0 0v6h6" />
      <path d="M9 13h6m-6 4h4" />
    </template>
    <template v-else-if="kind === 'file_change'">
      <path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8l5 5v3M14 3v5h5" />
      <path d="m17 13 3 3m-8 5 1-4 5-5 3 3-5 5-4 1Z" />
    </template>
    <template v-else-if="kind === 'SKILL'">
      <path d="M12 6C9 4 6 4 3 5v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v14" />
    </template>
    <template v-else-if="kind === 'WEB_SEARCH'">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </template>
    <template v-else-if="kind === 'WEB_FETCH'">
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3 12h18" />
    </template>
    <template v-else-if="kind === 'SLEEP'">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </template>
    <template v-else>
      <path d="M8 3v4m8-4v4M6 7h12v4a6 6 0 0 1-12 0V7Zm6 10v4" />
    </template>
  </svg>
</template>

<style scoped>
svg {
  width: 1em;
  height: 1em;
  flex: none;
}
</style>
