<script setup lang="ts">
import { computed } from 'vue';
import { tooltipOptions } from '../../util/tooltip.js';
import type { RunPerformance } from '@myagentroam/protocol';
import { translate } from '../../service/LocalePreferenceService.js';
import MarIcon from '../common/MarIcon.vue';

const props = defineProps<{ readonly performance: RunPerformance | undefined }>();
const details = computed(() => {
  const value = props.performance;
  if (value === undefined) return '';
  return [
    ...(value.latencyMs === undefined
      ? []
      : [
          translate('generated.conversationTimeline.modelResponseLatency', {
            value:
              value.latencyMs < 1_000
                ? `${value.latencyMs} ms`
                : `${(value.latencyMs / 1_000).toFixed(value.latencyMs < 10_000 ? 2 : 1)} s`
          })
        ]),
    ...(value.tokensPerSecond === undefined
      ? []
      : [
          translate('generated.conversationTimeline.providerOutputTps', {
            value: value.tokensPerSecond.toFixed(1)
          })
        ])
  ].join(' · ');
});
</script>

<template>
  <el-tooltip
    v-bind="tooltipOptions"
    v-if="details"
    :content="details"
    placement="top"
    :trigger="['hover', 'focus']"
  >
    <button
      class="session-performance-info icon-button utility-control"
      type="button"
      :aria-label="`${translate('generated.conversationTimeline.modelPerformanceDetails')}: ${details}`"
    >
      <MarIcon name="info" />
    </button>
  </el-tooltip>
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
