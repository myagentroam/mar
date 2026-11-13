<script setup lang="ts">
import '../conversation-detail.css';
import { computed } from 'vue';
import { translate } from '../../../service/locale-preference-service.js';
import type { readToolOutput } from '../../../util/tool-presentation.js';
type Output = ReturnType<typeof readToolOutput>;
const props = defineProps<{
  title?: string | undefined;
  toolName?: string | undefined;
  inputSummary?: string | undefined;
  inputTruncated?: boolean;
  genericOutput: Output;
  progressLabel?: string | undefined;
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
</script>

<template>
  <div class="tool-content generic-detail">
    <p v-if="title && title !== toolName" class="mar-conversation-detail-text">
      <span class="tool-detail-meta">{{ translate('presentation.detail') }}:</span>
      {{ title }}
    </p>
    <div
      v-if="typeof inputSummary === 'string' && inputSummary.length"
      class="tool-content-section"
    >
      <p class="tool-detail-meta">{{ translate('presentation.input') }}:</p>
      <pre class="mar-conversation-detail-text">{{ inputSummary }}</pre>
    </div>
    <p v-if="inputTruncated === true" class="tool-detail-meta">
      <template v-if="typeof inputSummary !== 'string' || !inputSummary.length"
        >{{ translate('presentation.input') }}:
      </template>
      {{ translate('toolPresentation.detail.truncated') }}
    </p>
    <div v-if="outputText || genericOutput?.truncation" class="tool-content-section">
      <p class="tool-detail-meta">{{ translate('presentation.output') }}:</p>
      <p v-if="genericOutput?.truncation === 'HEAD'" class="tool-detail-meta">
        {{ translate('toolPresentation.detail.truncated') }}
      </p>
      <pre v-if="outputText" class="mar-conversation-detail-text">{{ outputText }}</pre>
      <p
        v-if="genericOutput?.truncation && genericOutput.truncation !== 'HEAD'"
        class="tool-detail-meta"
      >
        {{ translate('toolPresentation.detail.truncated') }}
      </p>
    </div>
    <p v-if="progressLabel" class="mar-conversation-detail-text">
      <span class="tool-detail-meta">{{ translate('presentation.progress') }}:</span>
      {{ progressLabel }}
    </p>
    <p v-if="errorCode" class="mar-conversation-detail-text">
      <span class="tool-detail-meta">{{ translate('toolPresentation.detail.error') }}:</span>
      {{ errorCode }}
    </p>
    <p v-if="errorMessage" class="mar-conversation-detail-text">
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
.tool-content > .tool-content-section:not(:first-child) {
  margin-top: 0.5rem;
}
.tool-detail-meta {
  color: var(--mar-text-secondary);
  font-size: inherit;
  font-weight: 400;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
