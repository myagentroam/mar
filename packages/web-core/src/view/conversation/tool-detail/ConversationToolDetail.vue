<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { executionPresentationSchema, type ToolPresentation } from '@myagentroam/protocol';
import type { ConversationItem } from '../../../model/workbench.js';
import { translate } from '../../../service/locale-preference-service.js';
import MarIcon from '../../common/MarIcon.vue';
import ConversationDetailPreview from '../ConversationDetailPreview.vue';
import {
  conversationItemDetail,
  isSubagentToolCall,
  stringField
} from '../../../util/conversation-presentation.js';
import { agentOperationDetail } from '../../../util/agent-operation-presentation.js';
import {
  detailOnlyToolText,
  readFileDetail,
  readToolOutput,
  toolPresentation,
  toolPresentationReadRange,
  webToolPresentation
} from '../../../util/tool-presentation.js';
import AgentOperationDetail from './AgentOperationDetail.vue';
import ReadFileDetail from './ReadFileDetail.vue';
import SkillDetail from './SkillDetail.vue';
import WebSearchDetail from './WebSearchDetail.vue';
import WebFetchDetail from './WebFetchDetail.vue';
import ExecutionDetail from './ExecutionDetail.vue';
import ToolSearchDetail from './ToolSearchDetail.vue';
import SleepDetail from './SleepDetail.vue';
import ImageViewDetail from './ImageViewDetail.vue';
import CompactRequestDetail from './CompactRequestDetail.vue';
import GenericToolDetail from './GenericToolDetail.vue';
const props = defineProps<{
  item: ConversationItem;
  copyOnly?: boolean;
  readPath?: string | undefined;
}>();
const emit = defineEmits<{ copy: [text: string, onSuccess: () => void] }>();
const copyState = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
const payload = computed(() =>
  props.item.payload && typeof props.item.payload === 'object'
    ? (props.item.payload as Record<string, unknown>)
    : {}
);
const output = computed(() => readToolOutput(payload.value));
const selection = computed(() => {
  const p = payload.value;
  const agent = props.item.permissionStop ? undefined : agentOperationDetail(p, props.item.status);
  if (agent) return { kind: 'agent' as const, value: agent };
  if (props.readPath !== undefined) {
    const text = readFileDetail(p, props.readPath);
    if (text !== undefined)
      return {
        kind: 'read' as const,
        path: props.readPath,
        range: toolPresentationReadRange(p, props.readPath),
        text
      };
  }
  const presentation = toolPresentation(p);
  if (presentation?.kind === 'SKILL') return { kind: 'skill' as const, value: presentation };
  const web = webToolPresentation(p);
  if (web?.kind === 'WEB_SEARCH') return { kind: 'search' as const, value: web };
  if (web?.kind === 'WEB_FETCH') return { kind: 'fetch' as const, value: web };
  const execution = executionPresentationSchema.safeParse(p.toolPresentation);
  if (execution.success) return { kind: 'execution' as const, value: execution.data.execution };
  const compact = p.toolPresentation as ToolPresentation | undefined;
  if (compact?.kind === 'TOOL_SEARCH') return { kind: 'toolSearch' as const, value: compact };
  if (compact?.kind === 'SLEEP') return { kind: 'sleep' as const, value: compact };
  if (compact?.kind === 'IMAGE_VIEW') return { kind: 'image' as const, value: compact };
  if (compact?.kind === 'COMPACT_REQUEST') return { kind: 'compact' as const, value: compact };
  const detailOnly = detailOnlyToolText(p);
  if (
    props.item.kind === 'tool_call' &&
    !isSubagentToolCall(p) &&
    p.toolCategory !== 'IMAGE_GENERATION' &&
    presentation === undefined &&
    detailOnly === undefined
  )
    return { kind: 'generic' as const };
  if (detailOnly !== undefined) return { kind: 'text' as const, value: detailOnly };
  return { kind: 'fallback' as const };
});
const detailText = computed(() => {
  if (props.item.kind === 'tool_call')
    return conversationItemDetail(props.item.kind, props.item.payload);
  const text =
    output.value === undefined
      ? conversationItemDetail(props.item.kind, props.item.payload)
      : output.value.blocks
          .map((block) => block.text)
          .filter(Boolean)
          .join('\n');
  return [
    output.value?.truncation === 'HEAD' ? translate('toolPresentation.detail.truncated') : '',
    text,
    output.value?.truncation === 'SOURCE' ? translate('toolPresentation.detail.truncated') : ''
  ]
    .filter(Boolean)
    .join('\n');
});
const copyLabel = computed(() =>
  translate(copyState.value ? 'toolPresentation.detail.copied' : 'toolPresentation.detail.copy')
);
function copyRecord() {
  const text = JSON.stringify(props.item, null, 2);
  emit('copy', text, () => {
    if (disposed) return;
    if (copyTimer !== undefined) clearTimeout(copyTimer);
    copyState.value = true;
    copyTimer = setTimeout(() => {
      copyState.value = false;
      copyTimer = undefined;
    }, 500);
  });
}
onBeforeUnmount(() => {
  disposed = true;
  if (copyTimer !== undefined) clearTimeout(copyTimer);
});
</script>

<template>
  <section
    class="tool-detail"
    :class="{
      'conversation-detail-body':
        !copyOnly && (selection.kind !== 'fallback' || detailText || $slots.default)
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
      <AgentOperationDetail v-if="selection.kind === 'agent'" :agent-detail="selection.value" />
      <ReadFileDetail
        v-else-if="selection.kind === 'read'"
        :path="selection.path"
        :range="selection.range"
        :text="selection.text"
      />
      <SkillDetail
        v-else-if="selection.kind === 'skill'"
        :skill-detail="selection.value"
        :error-code="typeof payload.errorCode === 'string' ? payload.errorCode : undefined"
        :error-message="typeof payload.errorMessage === 'string' ? payload.errorMessage : undefined"
        :permission-reason="item.permissionStop?.reason"
      />
      <WebSearchDetail
        v-else-if="selection.kind === 'search'"
        :web-detail="selection.value"
        :tool-name="typeof payload.toolName === 'string' ? payload.toolName : undefined"
        :output-truncation="output?.truncation"
        :error-code="typeof payload.errorCode === 'string' ? payload.errorCode : undefined"
        :error-message="typeof payload.errorMessage === 'string' ? payload.errorMessage : undefined"
        :permission-reason="item.permissionStop?.reason"
      />
      <WebFetchDetail
        v-else-if="selection.kind === 'fetch'"
        :web-detail="selection.value"
        :tool-name="typeof payload.toolName === 'string' ? payload.toolName : undefined"
        :generic-output="output"
        :error-code="typeof payload.errorCode === 'string' ? payload.errorCode : undefined"
        :error-message="typeof payload.errorMessage === 'string' ? payload.errorMessage : undefined"
        :permission-reason="item.permissionStop?.reason"
      />
      <ExecutionDetail
        v-else-if="selection.kind === 'execution'"
        :execution="selection.value"
        :tool-name="typeof payload.toolName === 'string' ? payload.toolName : undefined"
        :command="typeof payload.command === 'string' ? payload.command : undefined"
        :cwd="typeof payload.cwd === 'string' ? payload.cwd : undefined"
        :exit-code="typeof payload.exitCode === 'number' ? payload.exitCode : undefined"
        :output-preview="
          typeof payload.outputPreview === 'string' ? payload.outputPreview : undefined
        "
        :generic-output="output"
        :has-public-output="payload.output !== undefined"
        :permission-reason="item.permissionStop?.reason"
      />
      <ToolSearchDetail
        v-else-if="selection.kind === 'toolSearch'"
        :compact-detail="selection.value"
        :tool-name="typeof payload.toolName === 'string' ? payload.toolName : undefined"
        :status="item.status"
        :generic-output="output"
        :input-truncated="payload.inputTruncated === true"
        :error-code="typeof payload.errorCode === 'string' ? payload.errorCode : undefined"
        :error-message="typeof payload.errorMessage === 'string' ? payload.errorMessage : undefined"
        :permission-reason="item.permissionStop?.reason"
      />
      <SleepDetail
        v-else-if="selection.kind === 'sleep'"
        :compact-detail="selection.value"
        :tool-name="typeof payload.toolName === 'string' ? payload.toolName : undefined"
        :status="item.status"
        :generic-output="output"
        :input-truncated="payload.inputTruncated === true"
        :error-code="typeof payload.errorCode === 'string' ? payload.errorCode : undefined"
        :error-message="typeof payload.errorMessage === 'string' ? payload.errorMessage : undefined"
        :permission-reason="item.permissionStop?.reason"
      />
      <ImageViewDetail
        v-else-if="selection.kind === 'image'"
        :compact-detail="selection.value"
        :tool-name="typeof payload.toolName === 'string' ? payload.toolName : undefined"
        :status="item.status"
        :generic-output="output"
        :input-truncated="payload.inputTruncated === true"
        :error-code="typeof payload.errorCode === 'string' ? payload.errorCode : undefined"
        :error-message="typeof payload.errorMessage === 'string' ? payload.errorMessage : undefined"
        :permission-reason="item.permissionStop?.reason"
      />
      <CompactRequestDetail
        v-else-if="selection.kind === 'compact'"
        :compact-detail="selection.value"
        :tool-name="typeof payload.toolName === 'string' ? payload.toolName : undefined"
        :status="item.status"
        :generic-output="output"
        :input-truncated="payload.inputTruncated === true"
        :error-code="typeof payload.errorCode === 'string' ? payload.errorCode : undefined"
        :error-message="typeof payload.errorMessage === 'string' ? payload.errorMessage : undefined"
        :permission-reason="item.permissionStop?.reason"
      />
      <GenericToolDetail
        v-else-if="selection.kind === 'generic'"
        :title="stringField(payload, 'title')"
        :tool-name="stringField(payload, 'toolName')"
        :input-summary="typeof payload.inputSummary === 'string' ? payload.inputSummary : undefined"
        :input-truncated="payload.inputTruncated === true"
        :generic-output="output"
        :progress-label="stringField(payload, 'progressLabel')"
        :error-code="stringField(payload, 'errorCode')"
        :error-message="stringField(payload, 'errorMessage')"
        :permission-reason="item.permissionStop?.reason"
      />
      <pre v-else-if="selection.kind === 'text'" class="conversation-detail-text">{{
        selection.value
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
</style>
