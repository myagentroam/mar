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
    <button
      v-tooltip="copyLabel"
      type="button"
      class="tool-detail-copy icon-button utility-control"
      :aria-label="copyLabel"
      @click.stop="copyRecord"
    >
      <MarIcon :name="copyState ? 'check' : 'copy'" />
    </button>
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
        <template
          v-if="
            execution.kind === 'SHELL' && typeof payload.cwd === 'string' && payload.cwd.length > 0
          "
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
      <div v-for="block in visibleOutputs" :key="block.channel" class="tool-detail-output">
        <strong>{{
          translate(
            block.channel === 'STDERR'
              ? 'toolPresentation.detail.stderr'
              : 'toolPresentation.detail.output'
          )
        }}</strong>
        <pre>{{ block.text }}</pre>
      </div>
      <span
        v-if="genericOutput?.truncated || execution.truncation || payload.truncated"
        class="tool-detail-note"
        >{{ translate('toolPresentation.detail.truncated') }}</span
      >
    </template>
    <template v-else-if="!copyOnly">
      <pre v-if="genericOutput?.text">{{ genericOutput.text }}</pre>
      <pre v-else-if="genericOutput === undefined && fallback">{{ fallback }}</pre>
      <span v-if="genericOutput?.truncated" class="tool-detail-note">{{
        translate('toolPresentation.detail.truncated')
      }}</span>
    </template>
  </section>
</template>

<style scoped>
.tool-detail {
  position: relative;
  min-width: 0;
  display: grid;
  gap: 6px;
  padding: 0.5rem calc(var(--mar-utility-control-size) + 0.5rem) 0.5rem 0;
  min-height: var(--mar-utility-control-size);
  color: var(--mar-text-secondary);
}
.tool-detail-note {
  font-size: var(--mar-font-size-meta);
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
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow: visible;
  background: transparent;
  border-radius: 0;
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
