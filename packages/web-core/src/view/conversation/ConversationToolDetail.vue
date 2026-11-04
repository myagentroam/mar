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
  toolPresentationLink,
  toolPresentationSources,
  toolPresentationReadRange,
  webToolPresentation
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
const webDetail = computed(() => webToolPresentation(payload.value));
const webHeading = computed(() =>
  [
    payload.value.toolName,
    webDetail.value?.kind === 'WEB_SEARCH' ? labels.search : labels.webContent
  ]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join(' · ')
);
const webSources = computed(() => toolPresentationSources(payload.value));
const webPage = computed(() => {
  const value = webDetail.value;
  const url = value?.kind === 'WEB_FETCH' ? value.url || value.requestUrl : undefined;
  return url ? toolPresentationLink(url) : undefined;
});
const webOrigin = computed(() => {
  const value = webDetail.value;
  if (value?.kind !== 'WEB_FETCH' || !value.requestUrl || !value.url) return undefined;
  const origin = toolPresentationLink(value.requestUrl);
  const page = webPage.value!;
  return (origin.href ?? origin.url) === (page.href ?? page.url) ? undefined : origin;
});
const webMetadata = computed(() => {
  const value = webDetail.value;
  if (value?.kind !== 'WEB_FETCH') return '';
  return [
    value.mode,
    value.status === undefined
      ? undefined
      : `${conversationUiEnUS.toolPresentation.httpStatus}: ${value.status}`,
    value.contentType
  ]
    .filter(Boolean)
    .join(' · ');
});
const webOutput = computed(() => {
  if (webDetail.value?.kind === 'WEB_SEARCH') return [];
  return genericOutput.value?.blocks.filter((block) => block.text.length > 0) ?? [];
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
const agentWaitText = computed(() => {
  const wait = agentDetail.value?.wait;
  return wait ? [wait.waitFor, wait.mode, `${wait.waitMs}ms`].filter(Boolean).join(' · ') : '';
});
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
          webDetail !== undefined ||
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
          <p v-if="agentDetail.targets.length !== 1 && agentWaitText" class="agent-detail-meta">
            {{ agentWaitText }}
          </p>
          <div
            v-for="(target, index) in agentDetail.targets"
            :key="index"
            class="agent-detail-entry"
          >
            <div class="agent-detail-row agent-detail-meta">
              <span
                >{{ target.title
                }}<template v-if="agentDetail.targets.length === 1 && agentWaitText">
                  · {{ agentWaitText }}</template
                ></span
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
      <div v-else-if="webDetail" class="tool-content web-detail">
        <p class="tool-detail-heading tool-detail-meta">{{ webHeading }}</p>
        <template v-if="webDetail.kind === 'WEB_SEARCH'">
          <div v-if="webDetail.query" class="tool-content-section">
            <p class="tool-detail-meta">{{ labels.query }}:</p>
            <p class="conversation-detail-text web-query">{{ webDetail.query }}</p>
          </div>
          <div v-if="webSources.length" class="tool-content-section">
            <p class="tool-detail-meta">{{ labels.sources }}:</p>
            <ul class="conversation-tool-sources">
              <li v-for="(source, index) in webSources" :key="index">
                <a
                  v-if="source.href"
                  :href="source.href"
                  target="_blank"
                  rel="noopener noreferrer"
                  >{{ source.title || source.url }}</a
                >
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
        </template>
        <template v-else>
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
            {{ labels.from }}:
            <a
              v-if="webOrigin.href"
              :href="webOrigin.href"
              target="_blank"
              rel="noopener noreferrer"
              >{{ webOrigin.url }}</a
            >
            <span v-else>{{ webOrigin.url }}</span>
          </p>
          <p v-if="webMetadata" class="tool-detail-meta">{{ webMetadata }}</p>
        </template>
        <div v-if="webOutput.length" class="tool-content-section web-output">
          <p class="tool-detail-meta">
            {{ webDetail.kind === 'WEB_FETCH' ? labels.content : labels.output }}:
          </p>
          <p v-if="genericOutput?.truncation === 'HEAD'" class="tool-detail-meta">
            {{ translate('toolPresentation.detail.truncated') }}
          </p>
          <p v-for="(block, index) in webOutput" :key="index" class="conversation-detail-text">
            {{ block.text }}
          </p>
        </div>
        <p
          v-if="
            genericOutput?.truncation &&
            (genericOutput.truncation !== 'HEAD' || webOutput.length === 0)
          "
          class="tool-detail-meta"
        >
          {{ translate('toolPresentation.detail.truncated') }}
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
  font-size: var(--mar-font-size-detail);
  font-weight: 400;
}
.agent-detail-text {
  color: var(--mar-conversation-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
