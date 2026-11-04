<script setup lang="ts">
import { translate } from '../../../service/locale-preference-service.js';
import type { ToolPresentation } from '@myagentroam/protocol';
defineProps<{
  skillDetail: Extract<ToolPresentation, { kind: 'SKILL' }>;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  permissionReason?: string | undefined;
}>();
</script>

<template>
  <div class="tool-content skill-detail">
    <p v-if="skillDetail.name" class="tool-detail-heading tool-detail-meta">
      {{ skillDetail.name }}
    </p>
    <p v-if="skillDetail.description" class="conversation-detail-text">
      {{ skillDetail.description }}
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
</style>
