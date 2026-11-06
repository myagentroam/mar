<script setup lang="ts">
import { computed } from 'vue';
import { translate } from '../../../service/locale-preference-service.js';
import { runStatusLabel } from '../../../util/session-presentation.js';
import { durationLabel } from '../../../util/tool-presentation.js';
import type { agentOperationDetail } from '../../../util/agent-operation-presentation.js';
const props = defineProps<{ agentDetail: NonNullable<ReturnType<typeof agentOperationDetail>> }>();
const agentTargetStatus = (status: string) =>
  status === 'IDLE' ? translate('generated.sessionPresentation.ready') : runStatusLabel(status);
const agentWaitText = computed(() => {
  const wait = props.agentDetail.wait;
  return wait
    ? [wait.waitFor, wait.mode, durationLabel(wait.waitMs)].filter(Boolean).join(' · ')
    : '';
});
</script>

<template>
  <div class="agent-detail">
    <template v-if="agentDetail.action === 'LIST'">
      <ul v-if="agentDetail.targets.length" class="conversation-detail-list">
        <li
          v-for="(target, index) in agentDetail.targets"
          :key="index"
          class="conversation-list-row"
        >
          <span
            v-if="target.status"
            class="conversation-list-marker"
            :class="{ 'agent-list-status--running': target.status === 'RUNNING' }"
            >{{ agentTargetStatus(target.status) }}</span
          >
          <span class="conversation-list-content">{{ target.title }}</span>
        </li>
      </ul>
      <p v-if="agentDetail.targets.length === 0" class="agent-detail-text">
        {{ translate('presentation.noAgentSessions') }}
      </p>
    </template>
    <template v-else-if="agentDetail.action === 'WAIT' || agentDetail.action === 'VIEW'">
      <p v-if="agentDetail.targets.length !== 1 && agentWaitText" class="agent-detail-meta">
        {{ agentWaitText }}
      </p>
      <div v-for="(target, index) in agentDetail.targets" :key="index" class="agent-detail-entry">
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
        <span
          ><span v-if="agentDetail.messageIsGoal" class="agent-detail-goal">{{
            translate('presentation.agentGoal')
          }}</span
          >{{ agentDetail.targets[0]?.title ?? agentDetail.title }}</span
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
</template>

<style scoped>
.agent-detail,
.agent-detail p {
  margin: 0;
  font-weight: 400;
}
.agent-detail-entry + .agent-detail-entry {
  margin-top: 0.5rem;
}
.agent-list-status--running {
  border-color: color-mix(in srgb, var(--el-color-success) 32%, transparent);
  background: color-mix(in srgb, var(--el-color-success) 8%, transparent);
  color: var(--el-color-success);
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
.agent-detail-goal {
  margin-inline-end: 0.5rem;
}
.agent-detail-text {
  color: var(--mar-conversation-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
