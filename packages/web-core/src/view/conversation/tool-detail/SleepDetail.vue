<script setup lang="ts">
import '../conversation-detail.css';
import { computed } from 'vue';
import { translate } from '../../../service/locale-preference-service.js';
import type { ToolPresentation } from '@myagentroam/protocol';
import type { readToolOutput } from '../../../util/tool-presentation.js';
type Output = ReturnType<typeof readToolOutput>;
import { durationLabel } from '../../../util/tool-presentation.js';
const props = defineProps<{
  compactDetail: Extract<ToolPresentation, { kind: 'SLEEP' }>;
  toolName?: string | undefined;
  status: string;
  genericOutput: Output;
  inputTruncated?: boolean;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  permissionReason?: string | undefined;
}>();
const outputText = computed(() =>
  props.genericOutput?.blocks
    .map((block) => block.text)
    .filter(Boolean)
    .join('\n')
);
const compactShowsOutput = computed(
  () =>
    ['FAILED', 'DECLINED', 'CANCELLED', 'INTERRUPTED'].includes(props.status) ||
    props.compactDetail.elapsedMs === undefined
);
const detailDuration = (ms: number) =>
  ms >= 1000 && ms % 1000 !== 0
    ? translate('toolPresentation.milliseconds', { value: ms })
    : durationLabel(ms);
</script>

<template>
  <div class="tool-content compact-detail">
    <p v-if="toolName" class="tool-detail-heading tool-detail-meta">
      {{ toolName
      }}<template v-if="compactDetail.durationMs !== undefined">
        · {{ detailDuration(compactDetail.durationMs) }}</template
      >
    </p>
    <p v-if="compactDetail.elapsedMs !== undefined" class="mar-conversation-detail-text">
      <span class="tool-detail-meta">{{ translate('toolPresentation.elapsedDuration') }}:</span>
      {{ detailDuration(compactDetail.elapsedMs) }}
    </p>
    <p v-if="compactDetail.wakeReason" class="mar-conversation-detail-text">
      <span class="tool-detail-meta">{{ translate('toolPresentation.wakeReason') }}:</span>
      {{ translate(`toolPresentation.wake.${compactDetail.wakeReason}`) }}
    </p>
    <p v-if="inputTruncated === true" class="tool-detail-meta">
      {{ translate('presentation.input') }}:
      {{ translate('toolPresentation.detail.truncated') }}
    </p>
    <p v-if="genericOutput?.truncation === 'HEAD'" class="tool-detail-meta">
      {{ translate('toolPresentation.detail.truncated') }}
    </p>
    <pre v-if="compactShowsOutput && outputText" class="mar-conversation-detail-text">{{
      outputText
    }}</pre>
    <p
      v-if="genericOutput?.truncation && genericOutput.truncation !== 'HEAD'"
      class="tool-detail-meta"
    >
      {{ translate('toolPresentation.detail.truncated') }}
    </p>
    <p v-if="typeof errorCode === 'string' && errorCode" class="mar-conversation-detail-text">
      <span class="tool-detail-meta">{{ translate('toolPresentation.detail.error') }}:</span>
      {{ errorCode }}
    </p>
    <p v-if="typeof errorMessage === 'string' && errorMessage" class="mar-conversation-detail-text">
      {{ errorMessage }}
    </p>
    <p v-if="permissionReason" class="mar-conversation-detail-text">
      <span class="tool-detail-meta">{{ translate('toolPresentation.detail.permission') }}:</span>
      {{ permissionReason }}
    </p>
  </div>
</template>

<style scoped>
.tool-content p {
  margin: 0;
}
.tool-content > .tool-detail-heading {
  margin-bottom: 0.375rem;
}
.tool-detail-meta {
  color: var(--mar-text-secondary);
  font-size: inherit;
  font-weight: 400;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
