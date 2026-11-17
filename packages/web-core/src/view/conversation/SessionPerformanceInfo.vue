<script setup lang="ts">
import { computed } from 'vue';
import type { RunPerformance } from '@myagentroam/protocol';
import { translate } from '../../service/locale-preference-service.js';
import MarIcon from '../common/MarIcon.vue';
import { sessionPerformanceDetails } from '../../util/session-performance-presentation.js';

const props = defineProps<{ readonly performance: RunPerformance | undefined }>();
const details = computed(() => sessionPerformanceDetails(props.performance));
</script>

<template>
  <button
    v-tooltip="{ content: details, placement: 'top', touch: true }"
    v-if="details"
    class="session-performance-info mar-icon-button mar-icon-action"
    type="button"
    :aria-label="`${translate('generated.conversationTimeline.modelPerformanceDetails')}: ${details}`"
  >
    <MarIcon name="info" />
  </button>
</template>

<style scoped>
.session-performance-info {
  --mar-action-icon-size: var(--mar-font-size-body);
  display: inline-flex;
  flex: none;
  width: 20px;
  height: 20px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--mar-radius-control);
  padding: 0;
  font: inherit;
}

.session-performance-info .mar-icon {
  width: 1em;
  height: 1em;
}
</style>
