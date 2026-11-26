<script setup lang="ts">
import type { WhiteboardOperationPresentation } from '@myagentroam/protocol';
import { computed } from 'vue';
import { translate } from '../../../service/locale-preference-service.js';

const props = defineProps<{ operation: WhiteboardOperationPresentation }>();
const fields = computed(() => {
  const { boardAgentId, boardRevision, entryCount, operationCount, changed } = props.operation;
  return {
    boardAgentId,
    boardRevision,
    entryCount,
    operationCount,
    result:
      changed === undefined
        ? undefined
        : translate(
            changed
              ? 'presentation.whiteboardDetail.changed'
              : 'presentation.whiteboardDetail.unchanged'
          )
  };
});
</script>

<template>
  <dl v-if="Object.values(fields).some((value) => value !== undefined)" class="whiteboard-detail">
    <template v-for="(value, field) in fields" :key="field">
      <div
        v-if="value !== undefined"
        :class="{ 'whiteboard-detail-owner': field === 'boardAgentId' }"
      >
        <dt>{{ translate(`presentation.whiteboardDetail.${field}`) }}</dt>
        <dd>{{ value }}</dd>
      </div>
    </template>
  </dl>
</template>

<style scoped>
.whiteboard-detail {
  display: flex;
  flex-wrap: wrap;
  column-gap: 1rem;
  margin: 0 0 0.5rem;
  font-size: var(--mar-font-size-detail);
}
.whiteboard-detail > div {
  display: flex;
  flex-wrap: wrap;
  column-gap: 0.5rem;
  max-width: 100%;
}
.whiteboard-detail-owner {
  flex-basis: 100%;
}
.whiteboard-detail dt {
  color: var(--mar-text-secondary);
}
.whiteboard-detail dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
