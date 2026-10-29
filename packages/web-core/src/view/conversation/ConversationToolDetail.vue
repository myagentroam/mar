<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { executionPresentationSchema } from '@myagentroam/protocol';
import type { ConversationItem } from '../../model/workbench.js';
import { translate } from '../../service/locale-preference-service.js';
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
const source = computed(() =>
  typeof payload.value.command === 'string' ? payload.value.command : ''
);
const fallback = computed(() => conversationItemDetail(props.item.kind, props.item.payload));
const detailStatus = (value: string) => translate(`toolPresentation.detail.${value}`);

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
    <div class="tool-detail-actions">
      <span>{{ translate('toolPresentation.detail.copyNote') }}</span>
      <button type="button" class="tool-detail-copy" @click.stop="copyRecord">
        {{ translate('toolPresentation.detail.copy') }}
      </button>
    </div>
    <span v-if="copyState" role="status" class="tool-detail-feedback">{{
      translate('toolPresentation.detail.copied')
    }}</span>
    <template v-if="!copyOnly && execution">
      <template v-if="source">
        <strong>{{
          translate(
            execution.kind === 'CODE'
              ? 'toolPresentation.detail.code'
              : 'toolPresentation.detail.command'
          )
        }}</strong>
        <pre>{{ source }}</pre>
      </template>
      <dl>
        <template v-if="execution.kind === 'SHELL' && typeof payload.cwd === 'string'"
          ><dt>{{ translate('toolPresentation.detail.cwd') }}</dt>
          <dd>{{ payload.cwd }}</dd></template
        >
        <template v-if="typeof payload.exitCode === 'number'"
          ><dt>{{ translate('toolPresentation.detail.exitCode') }}</dt>
          <dd>{{ payload.exitCode }}</dd></template
        >
        <dt>{{ translate('toolPresentation.detail.status') }}</dt>
        <dd>{{ detailStatus(item.status) }}</dd>
        <template v-if="execution.error"
          ><dt>{{ translate('toolPresentation.detail.error') }}</dt>
          <dd>{{ execution.error.code }} · {{ execution.error.message }}</dd></template
        >
        <template v-if="item.permissionStop"
          ><dt>{{ translate('toolPresentation.detail.permission') }}</dt>
          <dd>{{ item.permissionStop.reason }}</dd></template
        >
      </dl>
      <strong>{{ translate('toolPresentation.detail.output') }}</strong>
      <span v-if="outputs === undefined">{{
        translate(
          item.status === 'IN_PROGRESS'
            ? 'toolPresentation.detail.waiting'
            : 'toolPresentation.detail.unavailable'
        )
      }}</span>
      <span v-else-if="outputs.length === 0 || outputs.every((block) => block.text === '')">{{
        translate('toolPresentation.detail.empty')
      }}</span>
      <div v-for="block in outputs" v-else :key="block.channel" class="tool-detail-output">
        <span>{{ block.channel }}</span>
        <pre>{{ block.text }}</pre>
      </div>
      <span
        v-if="genericOutput?.truncated || execution.truncation || payload.truncated"
        class="tool-detail-note"
        >{{ translate('toolPresentation.detail.truncated') }}</span
      >
    </template>
    <template v-else-if="!copyOnly">
      <pre v-if="genericOutput !== undefined">{{ genericOutput.text }}</pre>
      <pre v-else-if="fallback">{{ fallback }}</pre>
      <span v-if="genericOutput?.truncated" class="tool-detail-note">{{
        translate('toolPresentation.detail.truncated')
      }}</span>
    </template>
  </section>
</template>

<style scoped>
.tool-detail {
  min-width: 0;
  display: grid;
  gap: 6px;
  padding: 8px 0;
  color: var(--mar-text-secondary);
}
.tool-detail-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.tool-detail-actions span,
.tool-detail-note,
.tool-detail-feedback {
  font-size: 0.85em;
}
.tool-detail-copy {
  flex: none;
  color: inherit;
  background: transparent;
  border: 1px solid var(--mar-border-medium);
  border-radius: var(--mar-radius-control);
  padding: 4px 8px;
  cursor: pointer;
}
.tool-detail-copy:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: 2px;
}
.tool-detail pre {
  margin: 0;
  padding: 8px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 20rem;
  overflow: auto;
  background: var(--mar-conversation-code);
  border-radius: var(--mar-radius-control);
}
.tool-detail dl {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 12px;
  margin: 0;
}
.tool-detail dt {
  font-weight: 600;
}
.tool-detail dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.tool-detail-output {
  min-width: 0;
  display: grid;
  gap: 4px;
}
</style>
