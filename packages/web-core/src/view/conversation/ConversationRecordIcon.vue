<script setup lang="ts">
import { computed } from 'vue';
import type { ToolPresentation } from '@myagentroam/protocol';
import MarIcon from '../common/MarIcon.vue';
import type { MarIconName } from '../../util/icon-shapes.js';

const props = defineProps<{
  kind: 'reasoning' | 'command_execution' | 'tool_call' | 'file_change' | ToolPresentation['kind'];
}>();
const names: Readonly<Record<string, MarIconName>> = {
  reasoning: 'reasoning',
  command_execution: 'terminal',
  READ: 'document',
  file_change: 'file-change',
  SKILL: 'skill',
  WEB_SEARCH: 'search',
  WEB_FETCH: 'web',
  SLEEP: 'clock'
};
const name = computed(() => names[props.kind] ?? 'tool');
</script>

<template><MarIcon :name="name" /></template>
