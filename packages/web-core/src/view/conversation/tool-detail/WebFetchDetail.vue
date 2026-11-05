<script setup lang="ts">
import { computed } from 'vue';
import { translate } from '../../../service/locale-preference-service.js';
import type { ToolPresentation } from '@myagentroam/protocol';
import type { readToolOutput } from '../../../util/tool-presentation.js';
type Output = ReturnType<typeof readToolOutput>;
import { toolPresentationLink } from '../../../util/tool-presentation.js';
const props = defineProps<{
  webDetail: Extract<ToolPresentation, { kind: 'WEB_FETCH' }>;
  toolName?: string | undefined;
  genericOutput: Output;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  permissionReason?: string | undefined;
}>();
const webHeading = computed(() =>
  [props.toolName, translate('toolPresentation.detail.webContent')].filter(Boolean).join(' · ')
);
const webPage = computed(() => {
  const url = props.webDetail.url || props.webDetail.requestUrl;
  return url ? toolPresentationLink(url) : undefined;
});
const webOrigin = computed(() => {
  const { requestUrl, url } = props.webDetail;
  if (!requestUrl || !url) return undefined;
  const origin = toolPresentationLink(requestUrl);
  const page = webPage.value!;
  return (origin.href ?? origin.url) === (page.href ?? page.url) ? undefined : origin;
});
const webMetadata = computed(() =>
  [
    props.webDetail.mode,
    props.webDetail.status === undefined
      ? undefined
      : `${translate('toolPresentation.httpStatus')}: ${props.webDetail.status}`,
    props.webDetail.contentType
  ]
    .filter(Boolean)
    .join(' · ')
);
const webOutput = computed(
  () => props.genericOutput?.blocks.filter((block) => block.text.length > 0) ?? []
);
</script>

<template>
  <div class="tool-content web-detail">
    <p class="tool-detail-heading tool-detail-meta">{{ webHeading }}</p>
    <p v-if="webDetail.title" class="conversation-detail-text web-page-title">
      {{ webDetail.title }}
    </p>
    <p v-if="webPage" class="web-page-url tool-detail-meta">
      <a v-if="webPage.href" :href="webPage.href" target="_blank" rel="noopener noreferrer">{{
        webPage.url
      }}</a>
      <span v-else>{{ webPage.url }}</span>
    </p>
    <p v-if="webOrigin" class="tool-detail-meta web-page-origin">
      {{ translate('toolPresentation.detail.from') }}:
      <a v-if="webOrigin.href" :href="webOrigin.href" target="_blank" rel="noopener noreferrer">{{
        webOrigin.url
      }}</a>
      <span v-else>{{ webOrigin.url }}</span>
    </p>
    <p v-if="webMetadata" class="tool-detail-meta">{{ webMetadata }}</p>
    <div v-if="webOutput.length" class="tool-content-section web-output">
      <p class="tool-detail-meta">{{ translate('toolPresentation.detail.content') }}:</p>
      <p v-if="genericOutput?.truncation === 'HEAD'" class="tool-detail-meta">
        {{ translate('toolPresentation.detail.truncated') }}
      </p>
      <p v-for="(block, index) in webOutput" :key="index" class="conversation-detail-text">
        {{ block.text }}
      </p>
    </div>
    <p
      v-if="
        genericOutput?.truncation && (genericOutput.truncation !== 'HEAD' || webOutput.length === 0)
      "
      class="tool-detail-meta"
    >
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
.tool-content > .tool-detail-heading:not(:last-child) {
  margin-bottom: 0.375rem;
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
