<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { executionPresentationSchema } from '@myagentroam/protocol';
import type { ConversationItem } from '../../model/workbench.js';
import { translate } from '../../service/locale-preference-service.js';
import { conversationUiEnUS } from '../../i18n/conversation-ui.en-US.js';
import MarIcon from '../common/MarIcon.vue';
import ConversationDetailPreview from './ConversationDetailPreview.vue';
import { conversationItemDetail } from '../../util/conversation-presentation.js';
import { agentOperationDetail } from '../../util/agent-operation-presentation.js';
import { runStatusLabel } from '../../util/session-presentation.js';
import {
  detailOnlyToolText,
  readFileDetail,
  readToolOutput,
  toolPresentation,
  toolPresentationReadRange
} from '../../util/tool-presentation.js';

const props = defineProps<{
  item: ConversationItem;
  copyOnly?: boolean;
  readPath?: string | undefined;
}>();
const agentTargetStatus = (status: string) =>
  status === 'IDLE' ? translate('generated.sessionPresentation.ready') : runStatusLabel(status);
const emit = defineEmits<{ copy: [text: string, onSuccess: () => void] }>();
const copyState = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;
const payload = computed(() =>
  props.item.payload && typeof props.item.payload === 'object'
    ? (props.item.payload as Record<string, unknown>)
    : {}
);
const execution = computed(() => {
  const parsed = executionPresentationSchema.safeParse(payload.value.toolPresentation);
  return parsed.success ? parsed.data.execution : undefined;
});
const genericOutput = computed(() => readToolOutput(payload.value));
const labels = conversationUiEnUS.toolPresentation.detail;
const readDetail = computed(() => {
  if (props.readPath === undefined) return undefined;
  const text = readFileDetail(payload.value, props.readPath);
  if (text === undefined) return undefined;
  const range = toolPresentationReadRange(payload.value, props.readPath);
  return { heading: [props.readPath, range].filter(Boolean).join(' · '), text };
});
const skillDetail = computed(() => {
  const value = toolPresentation(payload.value);
  return value?.kind === 'SKILL' ? value : undefined;
});
const executionSource = computed(() => {
  const value = execution.value;
  if (!value) return undefined;
  if (value.source) return value.source;
  if (value.kind === 'CONTROL') return undefined;
  return {
    kind: value.kind,
    text: typeof payload.value.command === 'string' ? payload.value.command : '',
    cwd:
      value.kind === 'SHELL' && typeof payload.value.cwd === 'string'
        ? payload.value.cwd
        : undefined,
    truncated: value.truncation?.input === true
  };
});
const executionHeading = computed(() => {
  const value = execution.value;
  if (!value) return '';
  const actions: Record<string, string> = conversationUiEnUS.toolPresentation.executionActions;
  return [
    value.toolName ?? payload.value.toolName,
    value.action
      ? Object.hasOwn(actions, value.action)
        ? actions[value.action]
        : value.action
      : undefined,
    !executionSource.value?.text ? value.targetId : undefined
  ]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join(' · ');
});
const outputTruncation = computed(() =>
  payload.value.output !== undefined
    ? genericOutput.value?.truncation
    : execution.value?.truncation?.output
);
const detailOnlyText = computed(() => detailOnlyToolText(payload.value));
const agentDetail = computed(() =>
  props.item.permissionStop ? undefined : agentOperationDetail(payload.value, props.item.status)
);
const outputs = computed(() => {
  const value = execution.value;
  if (!value) return undefined;
  if (payload.value.output !== undefined) return genericOutput.value?.blocks;
  if (value.output !== undefined) return value.output;
  if (genericOutput.value !== undefined) return genericOutput.value.blocks;
  // Codex app-server publishes incremental outputPreview on the same item.
  if (
    value.kind === 'SHELL' &&
    typeof payload.value.outputPreview === 'string' &&
    payload.value.outputPreview.length
  )
    return [{ channel: 'COMBINED' as const, text: payload.value.outputPreview }];
  return undefined;
});
const visibleOutputs = computed(
  () => outputs.value?.filter((block) => block.text.length > 0) ?? []
);
const copyLabel = computed(() =>
  translate(copyState.value ? 'toolPresentation.detail.copied' : 'toolPresentation.detail.copy')
);
const detailText = computed(() => {
  if (props.item.kind === 'tool_call')
    return conversationItemDetail(props.item.kind, props.item.payload);
  const text =
    genericOutput.value === undefined
      ? conversationItemDetail(props.item.kind, props.item.payload)
      : genericOutput.value.blocks
          .map((block) => block.text)
          .filter(Boolean)
          .join('\n');
  return [
    genericOutput.value?.truncation === 'HEAD'
      ? translate('toolPresentation.detail.truncated')
      : '',
    text,
    genericOutput.value?.truncation === 'SOURCE'
      ? translate('toolPresentation.detail.truncated')
      : ''
  ]
    .filter(Boolean)
    .join('\n');
});

function copyRecord() {
  // Capture the public item before awaiting clipboard access; subsequent snapshots cannot change it.
  const text = JSON.stringify(props.item, null, 2);
  emit('copy', text, () => {
    if (copyTimer !== undefined) clearTimeout(copyTimer);
    copyState.value = true;
    copyTimer = setTimeout(() => {
      copyState.value = false;
      copyTimer = undefined;
    }, 500);
  });
}
onBeforeUnmount(() => {
  if (copyTimer !== undefined) clearTimeout(copyTimer);
});
</script>

<template>
  <section
    class="tool-detail"
    :class="{
      'conversation-detail-body':
        !copyOnly &&
        (agentDetail !== undefined ||
          readDetail !== undefined ||
          skillDetail !== undefined ||
          execution !== undefined ||
          detailOnlyText !== undefined ||
          detailText ||
          $slots.default)
    }"
    :aria-label="translate('toolPresentation.detail.output')"
  >
    <button
      v-tooltip="copyLabel"
      type="button"
      class="tool-detail-copy icon-button utility-control"
      :aria-label="copyLabel"
      @click.stop="copyRecord"
    >
      <MarIcon :name="copyState ? 'check' : 'copy'" />
    </button>
    <ConversationDetailPreview v-if="!copyOnly">
      <div v-if="agentDetail" class="agent-detail">
        <template v-if="agentDetail.action === 'LIST'">
          <div v-for="(target, index) in agentDetail.targets" :key="index" class="agent-detail-row">
            <span>{{ target.title }}</span
            ><span v-if="target.status" class="agent-detail-meta">{{
              agentTargetStatus(target.status)
            }}</span>
          </div>
          <p v-if="agentDetail.targets.length === 0" class="agent-detail-text">
            {{ translate('presentation.noAgentSessions') }}
          </p>
        </template>
        <template v-else-if="agentDetail.action === 'WAIT' || agentDetail.action === 'VIEW'">
          <div
            v-for="(target, index) in agentDetail.targets"
            :key="index"
            class="agent-detail-entry"
          >
            <div class="agent-detail-row agent-detail-meta">
              <span>{{ target.title }}</span
              ><span v-if="target.status">{{ agentTargetStatus(target.status) }}</span>
            </div>
            <p v-if="target.message" class="agent-detail-text">{{ target.message }}</p>
            <p v-if="target.messageTruncated" class="agent-detail-meta">
              {{ translate('toolPresentation.detail.truncated') }}
            </p>
          </div>
        </template>
        <template v-else>
          <div class="agent-detail-row agent-detail-meta">
            <span>{{ agentDetail.targets[0]?.title ?? agentDetail.title }}</span
            ><span v-if="agentDetail.delivery">{{ agentDetail.delivery.toLowerCase() }}</span>
          </div>
          <p v-if="agentDetail.outputTruncation === 'HEAD'" class="agent-detail-meta">
            {{ translate('toolPresentation.detail.truncated') }}
          </p>
          <p
            v-if="agentDetail.action === 'STOP' && agentDetail.output !== undefined"
            class="agent-detail-text"
          >
            {{ agentDetail.output }}
          </p>
          <p v-else-if="agentDetail.message" class="agent-detail-text">{{ agentDetail.message }}</p>
          <p v-if="agentDetail.error" class="agent-detail-text">{{ agentDetail.error }}</p>
          <p
            v-if="agentDetail.messageTruncated || agentDetail.outputTruncation === 'SOURCE'"
            class="agent-detail-meta"
          >
            {{ translate('toolPresentation.detail.truncated') }}
          </p>
        </template>
        <p v-if="agentDetail.targetsTruncated" class="agent-detail-meta">
          {{ translate('toolPresentation.detail.truncated') }}
        </p>
      </div>
      <div v-else-if="readDetail" class="tool-content read-detail">
        <p class="tool-detail-heading tool-detail-meta">{{ readDetail.heading }}</p>
        <pre class="conversation-detail-text">{{ readDetail.text }}</pre>
      </div>
      <div v-else-if="skillDetail" class="tool-content skill-detail">
        <p v-if="skillDetail.name" class="tool-detail-heading tool-detail-meta">
          {{ skillDetail.name }}
        </p>
        <p v-if="skillDetail.description" class="conversation-detail-text">
          {{ skillDetail.description }}
        </p>
        <p
          v-if="typeof payload.errorCode === 'string' && payload.errorCode"
          class="conversation-detail-text tool-content-section"
        >
          {{ labels.error }}: {{ payload.errorCode }}
        </p>
        <p
          v-if="typeof payload.errorMessage === 'string' && payload.errorMessage"
          class="conversation-detail-text"
        >
          {{ payload.errorMessage }}
        </p>
        <p v-if="item.permissionStop?.reason" class="conversation-detail-text tool-content-section">
          {{ labels.permission }}: {{ item.permissionStop.reason }}
        </p>
      </div>
      <div v-else-if="execution" class="tool-content execution-detail">
        <p v-if="executionHeading" class="tool-detail-heading tool-detail-meta">
          {{ executionHeading }}
        </p>
        <pre
          v-if="executionSource?.text"
          class="conversation-detail-text tool-source-text"
        ><span class="tool-detail-meta">{{ executionSource.kind === 'CODE' ? labels.code : labels.command }}:</span> {{ executionSource.text }}</pre>
        <p
          v-if="executionSource?.truncated || execution.truncation?.input"
          class="tool-detail-meta"
        >
          {{ translate('toolPresentation.detail.truncated') }}
        </p>
        <p v-if="executionSource?.cwd" class="tool-detail-meta">
          {{ labels.cwd }}: {{ executionSource.cwd }}
        </p>
        <p v-if="execution.error" class="conversation-detail-text tool-content-section">
          {{ labels.error }}:
          {{ [execution.error.code, execution.error.message].filter(Boolean).join(': ') }}
        </p>
        <p v-if="item.permissionStop?.reason" class="conversation-detail-text tool-content-section">
          {{ labels.permission }}: {{ item.permissionStop.reason }}
        </p>
        <div
          v-for="(block, index) in visibleOutputs"
          :key="block.channel"
          class="tool-content-section execution-output"
        >
          <p class="tool-detail-meta">
            {{ block.channel === 'STDERR' ? labels.stderr : labels.output }}:
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
        <p
          v-if="typeof payload.exitCode === 'number'"
          class="tool-detail-meta tool-content-section tool-exit"
        >
          {{ labels.exit }} {{ payload.exitCode }}
        </p>
      </div>
      <pre v-else-if="detailOnlyText !== undefined" class="conversation-detail-text">{{
        detailOnlyText
      }}</pre>
      <slot v-else>
        <pre v-if="detailText" class="conversation-detail-text">{{ detailText }}</pre>
      </slot>
    </ConversationDetailPreview>
  </section>
</template>

<style scoped>
.tool-detail {
  position: relative;
  min-width: 0;
  min-height: var(--mar-utility-control-size);
}
.tool-detail:not(.conversation-detail-body) {
  padding: 0.5rem calc(var(--mar-utility-control-size) + 0.5rem) 0.5rem 0;
}
.tool-detail.conversation-detail-body {
  --conversation-detail-end: calc(var(--mar-utility-control-size) + 1rem);
}
.conversation-detail-body .tool-detail-copy {
  right: 0.5rem;
}
.tool-detail-copy {
  position: absolute;
  top: 0.5rem;
  right: 0;
  display: inline-flex;
  width: var(--mar-utility-control-size);
  height: var(--mar-utility-control-size);
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  padding: 0;
}
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
.agent-detail,
.agent-detail p {
  margin: 0;
  font-weight: 400;
}
.agent-detail-entry + .agent-detail-entry {
  margin-top: 0.5rem;
}
.agent-detail-row {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
}
.agent-detail-row > :first-child {
  min-width: 0;
  overflow-wrap: anywhere;
}
.agent-detail-row > :nth-child(2) {
  flex-shrink: 0;
}
.agent-detail-meta {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  font-weight: 400;
}
.agent-detail-text {
  color: var(--mar-conversation-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
