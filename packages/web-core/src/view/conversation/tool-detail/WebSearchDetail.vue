<script setup lang="ts">
import { computed } from 'vue';
import { translate } from '../../../service/locale-preference-service.js';
import type { ToolPresentation } from '@myagentroam/protocol';
import { toolPresentationSources } from '../../../util/tool-presentation.js';
const props = defineProps<{
  webDetail: Extract<ToolPresentation, { kind: 'WEB_SEARCH' }>;
  toolName?: string | undefined;
  outputTruncation?: 'HEAD' | 'SOURCE' | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  permissionReason?: string | undefined;
}>();
const webSources = computed(() => toolPresentationSources(props.webDetail));
const webHeading = computed(() =>
  [props.toolName, translate('toolPresentation.detail.search')].filter(Boolean).join(' · ')
);
</script>

<template>
  <div class="tool-content web-detail">
    <p class="tool-detail-heading tool-detail-meta">{{ webHeading }}</p>
    <div v-if="webDetail.query" class="tool-content-section">
      <p class="tool-detail-meta">{{ translate('toolPresentation.detail.query') }}:</p>
      <p class="conversation-detail-text web-query">{{ webDetail.query }}</p>
    </div>
    <div v-if="webSources.length" class="tool-content-section">
      <p class="tool-detail-meta">{{ translate('toolPresentation.detail.sources') }}:</p>
      <ul class="conversation-tool-sources">
        <li v-for="(source, index) in webSources" :key="index">
          <a v-if="source.href" :href="source.href" target="_blank" rel="noopener noreferrer">{{
            source.title || source.url
          }}</a>
          <span v-else>{{ source.title || source.url }}</span>
          <p v-if="source.title" class="conversation-tool-source-host tool-detail-meta">
            {{ source.url }}
          </p>
          <p v-if="source.snippet" class="conversation-detail-text">{{ source.snippet }}</p>
        </li>
      </ul>
    </div>
    <p
      v-else-if="webDetail.sourcesOnly && webDetail.sources?.length === 0"
      class="conversation-detail-text tool-content-section"
    >
      {{ translate('toolPresentation.noResults') }}
    </p>
    <p v-if="outputTruncation" class="tool-detail-meta">
      {{ translate('toolPresentation.detail.truncated') }}
    </p>
    <p
      v-if="typeof errorCode === 'string' && errorCode"
      class="conversation-detail-text tool-content-section"
    >
      {{ translate('toolPresentation.detail.error') }}: {{ errorCode }}
    </p>
    <p v-if="typeof errorMessage === 'string' && errorMessage" class="conversation-detail-text">
      {{ errorMessage }}
    </p>
    <p v-if="permissionReason" class="conversation-detail-text tool-content-section">
      {{ translate('toolPresentation.detail.permission') }}: {{ permissionReason }}
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
.tool-content .tool-content-section {
  margin-top: 0.5rem;
}
.tool-detail-meta {
  color: var(--mar-text-secondary);
  font-size: inherit;
  font-weight: 400;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.conversation-tool-sources {
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-wrap: anywhere;
}
.conversation-tool-sources > li + li {
  margin-top: 0.625rem;
}
.web-detail a {
  color: var(--mar-color-brand-text);
  text-decoration: underline;
  text-underline-offset: 0.125em;
  overflow-wrap: anywhere;
}
.web-detail a:focus-visible {
  outline: 1px solid var(--mar-color-brand);
  outline-offset: 2px;
}
</style>
