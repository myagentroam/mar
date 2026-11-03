<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { executionPresentationSchema } from '@myagentroam/protocol';
import type { ConversationItem } from '../../model/workbench.js';
import { translate } from '../../service/locale-preference-service.js';
import { conversationUiEnUS } from '../../i18n/conversation-ui.en-US.js';
import MarIcon from '../common/MarIcon.vue';
import { conversationItemDetail } from '../../util/conversation-presentation.js';
import {
  detailOnlyToolText,
  readFileDetail,
  readToolOutput
} from '../../util/tool-presentation.js';

const props = defineProps<{
  item: ConversationItem;
  copyOnly?: boolean;
  readPath?: string | undefined;
}>();
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
const detailOnlyText = computed(() => detailOnlyToolText(payload.value));
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
  if (props.readPath !== undefined) {
    const detail = readFileDetail(payload.value, props.readPath);
    if (detail !== undefined) return detail;
  }
  const value = execution.value;
  if (!value) {
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
  }
  const lines: string[] = [];
  const field = (key: keyof typeof conversationUiEnUS.toolPresentation.detail, text: unknown) => {
    if ((typeof text === 'string' && text.length > 0) || typeof text === 'number')
      lines.push(`${conversationUiEnUS.toolPresentation.detail[key]}: ${text}`);
  };
  field('tool', value.toolName ?? payload.value.toolName);
  if (value.source) {
    field(value.source.kind === 'CODE' ? 'code' : 'command', value.source.text);
    if (value.source.truncated || value.truncation?.input)
      lines.push(translate('toolPresentation.detail.truncated'));
    field('cwd', value.source.cwd);
  } else if (value.kind !== 'CONTROL') {
    field(value.kind === 'CODE' ? 'code' : 'command', payload.value.command);
    if (value.truncation?.input) lines.push(translate('toolPresentation.detail.truncated'));
    if (value.kind === 'SHELL') field('cwd', payload.value.cwd);
  }
  field('action', value.action);
  field('target', value.targetId);
  if (value.error)
    field('error', [value.error.code, value.error.message].filter(Boolean).join(': '));
  field('permission', props.item.permissionStop?.reason);
  const outputTruncation =
    payload.value.output !== undefined ? genericOutput.value?.truncation : value.truncation?.output;
  for (const [index, block] of visibleOutputs.value.entries()) {
    const label = block.channel === 'STDERR' ? 'stderr' : 'output';
    const marker =
      index === 0 && outputTruncation === 'HEAD'
        ? `${translate('toolPresentation.detail.truncated')}\n`
        : '';
    lines.push(`${conversationUiEnUS.toolPresentation.detail[label]}:\n${marker}${block.text}`);
  }
  if (outputTruncation && (outputTruncation !== 'HEAD' || visibleOutputs.value.length === 0))
    lines.push(translate('toolPresentation.detail.truncated'));
  field('exitCode', payload.value.exitCode);
  return lines.join('\n');
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
        !copyOnly && (detailOnlyText !== undefined || detailText || $slots.default)
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
    <pre v-if="!copyOnly && detailOnlyText !== undefined" class="conversation-detail-text">{{
      detailOnlyText
    }}</pre>
    <slot v-else-if="!copyOnly">
      <pre v-if="detailText" class="conversation-detail-text">{{ detailText }}</pre>
    </slot>
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
