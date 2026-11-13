<script setup lang="ts">
import '../conversation-detail.css';
import { computed } from 'vue';
import { translate } from '../../../service/locale-preference-service.js';
import type { ToolPresentation } from '@myagentroam/protocol';
import type { readToolOutput } from '../../../util/tool-presentation.js';
type Output = ReturnType<typeof readToolOutput>;
const props = defineProps<{
  compactDetail: Extract<ToolPresentation, { kind: 'IMAGE_VIEW' }>;
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
  () => ['FAILED', 'DECLINED', 'CANCELLED', 'INTERRUPTED'].includes(props.status) || false
);
</script>

<template>
  <div class="tool-content compact-detail">
    <p v-if="toolName" class="tool-detail-heading tool-detail-meta">{{ toolName }}</p>
    <p v-if="compactDetail.path || compactDetail.resourceId" class="tool-detail-meta">
      {{ compactDetail.path || compactDetail.resourceId }}
    </p>
    <p
      v-if="compactDetail.mimeType || (compactDetail.width && compactDetail.height)"
      class="mar-conversation-detail-text"
    >
      {{
        [
          compactDetail.mimeType,
          compactDetail.width && compactDetail.height
            ? `${compactDetail.width} × ${compactDetail.height}`
            : ''
        ]
          .filter(Boolean)
          .join(' · ')
      }}
    </p>
    <p
      v-if="
        compactDetail.sourceWidth &&
        compactDetail.sourceHeight &&
        (compactDetail.sourceWidth !== compactDetail.width ||
          compactDetail.sourceHeight !== compactDetail.height)
      "
      class="mar-conversation-detail-text"
    >
      <span class="tool-detail-meta">{{ translate('toolPresentation.detail.sourceSize') }}:</span>
      {{ compactDetail.sourceWidth }} × {{ compactDetail.sourceHeight }}
    </p>
    <p v-if="compactDetail.region" class="mar-conversation-detail-text">
      <span class="tool-detail-meta">{{ translate('toolPresentation.detail.region') }}:</span>
      {{ compactDetail.region.x }}, {{ compactDetail.region.y }} ·
      {{ compactDetail.region.width }} ×
      {{ compactDetail.region.height }}
    </p>
    <p
      v-if="
        compactDetail.resize?.maxWidth !== undefined ||
        compactDetail.resize?.maxHeight !== undefined
      "
      class="mar-conversation-detail-text"
    >
      <span class="tool-detail-meta">{{ translate('toolPresentation.detail.resize') }}:</span>
      <template v-if="compactDetail.resize?.maxWidth !== undefined">
        {{ translate('toolPresentation.detail.maxWidth') }}: {{ compactDetail.resize.maxWidth }}
      </template>
      <template v-if="compactDetail.resize?.maxHeight !== undefined">
        <template v-if="compactDetail.resize.maxWidth !== undefined"> · </template>
        {{ translate('toolPresentation.detail.maxHeight') }}: {{ compactDetail.resize.maxHeight }}
      </template>
    </p>
    <p class="tool-detail-meta">
      {{ translate('toolPresentation.detail.imageUnavailable') }}
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
