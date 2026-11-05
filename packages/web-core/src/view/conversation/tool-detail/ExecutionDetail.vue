<script setup lang="ts">
import { computed } from 'vue';
import { translate } from '../../../service/locale-preference-service.js';
import type { ExecutionPresentation } from '@myagentroam/protocol';
import type { readToolOutput } from '../../../util/tool-presentation.js';
type Output = ReturnType<typeof readToolOutput>;
const props = defineProps<{
  execution: ExecutionPresentation['execution'];
  toolName?: string | undefined;
  command?: string | undefined;
  cwd?: string | undefined;
  exitCode?: number | undefined;
  outputPreview?: string | undefined;
  genericOutput: Output;
  hasPublicOutput: boolean;
  permissionReason?: string | undefined;
}>();
const executionSource = computed(() => {
  const value = props.execution;
  if (!value) return undefined;
  if (value.source) return value.source;
  if (value.kind === 'CONTROL') return undefined;
  return {
    kind: value.kind,
    text: typeof props.command === 'string' ? props.command : '',
    cwd: value.kind === 'SHELL' && typeof props.cwd === 'string' ? props.cwd : undefined,
    truncated: value.truncation?.input === true
  };
});
const executionHeading = computed(() => {
  const value = props.execution;
  if (!value) return '';
  const actions = ['poll', 'write', 'cancel', 'start'];
  return [
    value.toolName ?? props.toolName,
    value.action
      ? actions.includes(value.action)
        ? translate(`toolPresentation.executionActions.${value.action}`)
        : value.action
      : undefined,
    !executionSource.value?.text ? value.targetId : undefined
  ]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join(' · ');
});
const outputTruncation = computed(() =>
  props.hasPublicOutput ? props.genericOutput?.truncation : props.execution?.truncation?.output
);
const outputs = computed(() => {
  const value = props.execution;
  if (!value) return undefined;
  if (props.hasPublicOutput) return props.genericOutput?.blocks;
  if (value.output !== undefined) return value.output;
  if (props.genericOutput !== undefined) return props.genericOutput.blocks;
  // Codex app-server publishes incremental outputPreview on the same item.
  if (
    value.kind === 'SHELL' &&
    typeof props.outputPreview === 'string' &&
    props.outputPreview.length
  )
    return [{ channel: 'COMBINED' as const, text: props.outputPreview }];
  return undefined;
});
const visibleOutputs = computed(
  () => outputs.value?.filter((block) => block.text.length > 0) ?? []
);
</script>

<template>
  <div class="tool-content execution-detail">
    <p v-if="executionHeading" class="tool-detail-heading tool-detail-meta">
      {{ executionHeading }}
    </p>
    <pre
      v-if="executionSource?.text"
      class="conversation-detail-text tool-source-text"
    ><span class="tool-detail-meta">{{ executionSource.kind === 'CODE' ? translate('toolPresentation.detail.code') : translate('toolPresentation.detail.command') }}:</span> {{ executionSource.text }}</pre>
    <p v-if="executionSource?.truncated || execution.truncation?.input" class="tool-detail-meta">
      {{ translate('toolPresentation.detail.truncated') }}
    </p>
    <p v-if="executionSource?.cwd" class="tool-detail-meta">
      {{ translate('toolPresentation.detail.cwd') }}:
      <span class="tool-cwd-value">{{ executionSource.cwd }}</span>
    </p>
    <p v-if="execution.error" class="conversation-detail-text tool-content-section">
      {{ translate('toolPresentation.detail.error') }}:
      {{ [execution.error.code, execution.error.message].filter(Boolean).join(': ') }}
    </p>
    <p v-if="permissionReason" class="conversation-detail-text tool-content-section">
      {{ translate('toolPresentation.detail.permission') }}: {{ permissionReason }}
    </p>
    <div
      v-for="(block, index) in visibleOutputs"
      :key="block.channel"
      class="tool-content-section execution-output"
    >
      <p class="tool-detail-meta">
        {{
          block.channel === 'STDERR'
            ? translate('toolPresentation.detail.stderr')
            : translate('toolPresentation.detail.output')
        }}:
      </p>
      <pre class="conversation-detail-text tool-output-text">{{
        (index === 0 && outputTruncation === 'HEAD'
          ? translate('toolPresentation.detail.truncated') + '\n'
          : '') + block.text
      }}</pre>
    </div>
    <p
      v-if="outputTruncation && (outputTruncation !== 'HEAD' || visibleOutputs.length === 0)"
      class="tool-detail-meta"
    >
      {{ translate('toolPresentation.detail.truncated') }}
    </p>
    <p v-if="typeof exitCode === 'number'" class="tool-detail-meta tool-content-section tool-exit">
      {{ translate('toolPresentation.detail.exit') }} {{ exitCode }}
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
.tool-cwd-value {
  color: var(--mar-conversation-text);
}
</style>
