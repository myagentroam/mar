<script setup lang="ts">
import { computed } from 'vue';
import { translate } from '../../../service/locale-preference-service.js';
import type { ToolPresentation } from '@myagentroam/protocol';
import type { readToolOutput } from '../../../util/tool-presentation.js';
type Output = ReturnType<typeof readToolOutput>;
const props = defineProps<{
  compactDetail: Extract<ToolPresentation, { kind: 'COMPACT_REQUEST' }>;
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
    props.compactDetail.accepted !== true
);
</script>

<template>
  <div class="tool-content compact-detail">
    <p v-if="toolName" class="tool-detail-heading tool-detail-meta">{{ toolName }}</p>
    <p v-if="compactDetail.accepted" class="conversation-detail-text">
      {{ translate('toolPresentation.detail.compactAccepted') }}
    </p>
    <p v-if="inputTruncated === true" class="tool-detail-meta">
      {{ translate('presentation.input') }}:
      {{ translate('toolPresentation.detail.truncated') }}
    </p>
    <p v-if="genericOutput?.truncation === 'HEAD'" class="tool-detail-meta">
      {{ translate('toolPresentation.detail.truncated') }}
    </p>
    <pre v-if="compactShowsOutput && outputText" class="conversation-detail-text">{{
      outputText
    }}</pre>
    <p
      v-if="genericOutput?.truncation && genericOutput.truncation !== 'HEAD'"
      class="tool-detail-meta"
    >
      {{ translate('toolPresentation.detail.truncated') }}
    </p>
    <p v-if="typeof errorCode === 'string' && errorCode" class="conversation-detail-text">
      <span class="tool-detail-meta">{{ translate('toolPresentation.detail.error') }}:</span>
      {{ errorCode }}
    </p>
    <p v-if="typeof errorMessage === 'string' && errorMessage" class="conversation-detail-text">
      {{ errorMessage }}
    </p>
    <p v-if="permissionReason" class="conversation-detail-text">
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
