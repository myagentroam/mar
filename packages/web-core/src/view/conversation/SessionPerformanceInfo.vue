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
    class="session-performance-info icon-button utility-control"
    type="button"
    :aria-label="`${translate('generated.conversationTimeline.modelPerformanceDetails')}: ${details}`"
  >
    <MarIcon name="info" />
  </button>
</template>

<style scoped>
.session-performance-info {
  display: inline-flex;
  width: var(--mar-utility-control-size);
  height: var(--mar-utility-control-size);
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 4px;
  padding: 0;
}

.session-performance-info .mar-icon {
  width: 16px;
  height: 16px;
  font-size: 16px;
}
</style>
