<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { executionPresentationSchema } from '@myagentroam/protocol';
import type { ConversationItem } from '../../model/workbench.js';
import { translate } from '../../service/locale-preference-service.js';
import MarIcon from '../common/MarIcon.vue';
import { conversationItemDetail } from '../../util/conversation-presentation.js';

const props = defineProps<{ item: ConversationItem; copyOnly?: boolean }>();
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
const genericOutput = computed(() => {
  const value = payload.value.output;
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.text === 'string' && typeof record.truncated === 'boolean'
    ? { text: record.text, truncated: record.truncated }
    : undefined;
});
const outputs = computed(() => {
  const value = execution.value;
  if (!value) return undefined;
  if (value.output?.some((block) => block.channel === 'STDOUT' || block.channel === 'STDERR'))
    return value.output;
  if (genericOutput.value !== undefined)
    return [{ channel: 'COMBINED' as const, text: genericOutput.value.text }];
  if (value.output !== undefined) return value.output;
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
  const value = execution.value;
  if (!value) {
    const text =
      genericOutput.value === undefined
        ? conversationItemDetail(props.item.kind, props.item.payload)
        : genericOutput.value.text;
    return [
      text,
      genericOutput.value?.truncated ? translate('toolPresentation.detail.truncated') : ''
    ]
      .filter(Boolean)
      .join('\n');
  }
  const lines: string[] = [];
  const field = (key: string, text: unknown) => {
    if ((typeof text === 'string' && text.length > 0) || typeof text === 'number')
      lines.push(`${translate(`toolPresentation.detail.${key}`)}: ${text}`);
  };
  field(value.kind === 'CODE' ? 'code' : 'command', payload.value.command);
  if (value.kind === 'SHELL') field('cwd', payload.value.cwd);
  field('status', translate(`toolPresentation.detail.${props.item.status}`));
  if (value.error)
    field('error', [value.error.code, value.error.message].filter(Boolean).join(': '));
  field('permission', props.item.permissionStop?.reason);
  for (const block of visibleOutputs.value)
    field(block.channel === 'STDERR' ? 'stderr' : 'output', block.text);
  if (genericOutput.value?.truncated || value.truncation || payload.value.truncated)
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
  <section class="tool-detail" :aria-label="translate('toolPresentation.detail.output')">
    <button
      v-tooltip="copyLabel"
      type="button"
      class="tool-detail-copy icon-button utility-control"
      :aria-label="copyLabel"
      @click.stop="copyRecord"
    >
      <MarIcon :name="copyState ? 'check' : 'copy'" />
    </button>
    <pre v-if="!copyOnly && detailText">{{ detailText }}</pre>
  </section>
</template>

<style scoped>
.tool-detail {
  position: relative;
  min-width: 0;
  padding: 0.5rem calc(var(--mar-utility-control-size) + 0.5rem) 0.5rem 0;
  min-height: var(--mar-utility-control-size);
  color: var(--mar-text-secondary);
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
.tool-detail pre {
  margin: 0;
  padding: 0;
  border: 0;
  color: inherit;
  font-family: var(--mar-font-mono);
  font-size: var(--mar-font-size-meta);
  font-weight: 400;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow: visible;
  background: transparent;
  border-radius: 0;
}
</style>
