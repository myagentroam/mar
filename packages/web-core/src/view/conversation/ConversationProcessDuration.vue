<script setup lang="ts">
// Own the live clock dependency here so a tick never re-renders the Timeline or its slots.
import { computed } from 'vue';
import { createWorkbenchSecondClock } from '../../service/workbench-clock-service.js';
import { translate } from '../../service/locale-preference-service.js';
import {
  conversationProcessDuration,
  type ConversationProcessBlock
} from '../../util/conversation-work-process.js';
import { preciseElapsedDurationLabel } from '../../util/time-presentation.js';

const props = defineProps<{
  readonly block: ConversationProcessBlock;
  readonly synchronized: boolean;
}>();
const ticking = computed(
  () => props.block.active && props.synchronized && props.block.startedAt !== undefined
);
const now = createWorkbenchSecondClock(ticking);
const durationMs = computed(() =>
  conversationProcessDuration(
    props.block,
    ticking.value ? now.value : undefined,
    props.synchronized
  )
);
</script>

<template>
  <span v-if="durationMs !== undefined" class="process-duration"
    >·
    {{
      translate('conversationActivity.step', { value: preciseElapsedDurationLabel(durationMs) })
    }}</span
  >
</template>

<style scoped>
.process-duration {
  flex: none;
  color: var(--mar-text-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
