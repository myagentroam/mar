<script setup lang="ts">
import { ref } from 'vue';
import MarIcon from '../../src/view/common/MarIcon.vue';
import ConversationHeader from '../../src/view/conversation/ConversationHeader.vue';
import SessionPerformanceInfo from '../../src/view/conversation/SessionPerformanceInfo.vue';
import ComposerQueue from '../../src/view/composer/ComposerQueue.vue';
import { createComposerQueueService } from '../../src/service/composer-queue-service.js';
import ComposerCommandPicker from '../../src/view/composer/ComposerCommandPicker.vue';
import ComposerReferencePicker from '../../src/view/composer/ComposerReferencePicker.vue';
import WorkspaceSessionList from '../../src/view/workspace/WorkspaceSessionList.vue';
import type {
  RunnerCommand,
  RunnerCommandState,
  Session,
  WorkspaceQueueItem
} from '../../src/model/workbench.js';

const disabled = ref(false);
const events = ref<string[]>([]);
const record = (event: string) => events.value.push(event);
const session: Session = {
  id: 'session-1234567890-long-context',
  workspaceId: 'workspace',
  runner: 'mar-agent',
  externalSessionId: 'native-session'
};
const queueItemCount = Number(new URLSearchParams(location.search).get('queue-count') ?? 1);
const items = ref<WorkspaceQueueItem[]>(
  Array.from({ length: queueItemCount }, (_, index) => ({
    queueItemId: index === 0 ? 'queue-one' : `queue-${index + 1}`,
    sessionId: session.id,
    workspaceId: 'workspace',
    runner: 'mar-agent',
    clientMessageId: `message-${index + 1}`,
    sessionTitle: 'Review',
    content: 'Review the pending change',
    createdAt: index + 1
  }))
);
const queueEditor = createComposerQueueService();
const { editingQueueItemId, editingContent } = queueEditor;
const goal = ref<RunnerCommandState | undefined>(
  new URLSearchParams(location.search).has('work-item-editing')
    ? {
        commandId: 'goal',
        active: true,
        label: 'Goal',
        detail: null,
        closable: true,
        closeInput: null,
        goal: {
          id: 'goal-one',
          objective: 'Review the pending goal',
          revision: 1,
          status: 'active',
          turns: 2
        }
      }
    : undefined
);
function editQueueItem(item: WorkspaceQueueItem) {
  record('edit');
  queueEditor.startEditing(item);
}
function saveQueueItem(id: string) {
  items.value = items.value.map((item) =>
    item.queueItemId === id ? { ...item, content: editingContent.value } : item
  );
  queueEditor.finishEditing();
}
function saveGoal(objective: string) {
  goal.value = { ...goal.value!, goal: { ...goal.value!.goal!, objective } };
}
const commands: RunnerCommand[] = ['first', 'second'].map((id) => ({
  id,
  runner: 'mar-agent',
  label: id,
  description: `${id} command description`,
  inputHint: '',
  source: 'MAR_RUNTIME',
  interaction: 'RUNNER_TEXT',
  available: true,
  reasonCode: null
}));
const candidateKind = new URLSearchParams(location.search).get('candidates') ?? 'commands';
const skills = commands.map((command) => ({
  name: command.id,
  description: command.description,
  localStatus: 'READY',
  source: 'WORKSPACE' as const,
  skillFilePath: `/workspace/.agents/skills/${command.id}/SKILL.md`
}));
const quickPrompts = commands.map((command) => ({
  id: command.id,
  phrase: command.id,
  prompt: command.description,
  updatedAt: 1
}));
const entries = [
  { name: 'first.ts', path: '/workspace/first.ts', kind: 'FILE' as const },
  { name: 'second.ts', path: '/workspace/second.ts', kind: 'FILE' as const }
];
const request = async <T,>(): Promise<T> => ({}) as T;
</script>

<template>
  <main class="utility-fixture">
    <button data-testid="disable" @click="disabled = !disabled">Toggle disabled</button>
    <output data-testid="events">{{ events.join('|') }}</output>
    <section>
      <button
        class="icon-button icon-action"
        data-testid="native"
        aria-label="Native icon action"
        :disabled="disabled"
        @click="record('native')"
      >
        <MarIcon name="copy" />
      </button>
      <el-button class="text-action" data-testid="element" link :disabled="disabled"
        >Utility</el-button
      >
      <el-button
        class="icon-action"
        data-testid="element-icon"
        text
        circle
        :disabled="disabled"
        aria-label="Element icon action"
      >
        <MarIcon name="copy" />
      </el-button>
      <button
        class="icon-button icon-action"
        data-testid="aria-disabled-icon"
        aria-disabled="true"
        aria-label="Unavailable icon action"
      >
        <MarIcon name="copy" />
      </button>
      <SessionPerformanceInfo
        data-testid="performance-icon"
        :performance="{ runId: 'run', latencyMs: 420, tokensPerSecond: 42 }"
      />
    </section>
    <WorkspaceSessionList
      :sessions="[]"
      :selected-session-id="undefined"
      :mobile-viewport="false"
      :can-load-more="false"
      :loading-more="false"
      watch-status="ready"
      :node-ready="!disabled"
      :loading="false"
      workspace-kind="DIRECTORY"
      workspace-kind-label="Workspace"
      :workspace-branch="undefined"
      :title="() => 'Session'"
      :runner-icon="() => ''"
      :activity="() => 'IDLE'"
      :activity-label="() => 'Idle'"
      :activity-date-time="() => undefined"
      :activity-title="() => undefined"
      :relative-activity="() => ''"
      node-id="node"
      workspace-id="workspace"
      :skill-supported="false"
      :mcp-supported="false"
      :cleanup-sessions-supported="true"
      :search-supported="true"
      search-query=""
      :searching="false"
      :refreshing="false"
      :workspace-manageable="true"
      :request="request"
      :has-unread="() => false"
      @refresh="record('refresh')"
    />
    <ConversationHeader
      :session="session"
      runner="mar-agent"
      :files-ready="true"
      :terminal-ready="true"
      :content-search-ready="false"
      :runner-icon="() => ''"
      :session-title="() => 'Review'"
      @open-surface="record(`surface:${$event}`)"
    />
    <ComposerQueue
      :items="items"
      :paused="false"
      :loading="disabled"
      :editing-queue-item-id="editingQueueItemId"
      :editing-content="editingContent"
      :goal="goal"
      @edit="editQueueItem"
      @cancel-edit="queueEditor.finishEditing"
      @update-content="editingContent = $event"
      @save="saveQueueItem"
      @save-goal="saveGoal"
      @execute="record('execute')"
      @delete-item="record('delete')"
    />
    <!-- Keep controlled selection stable to distinguish hover from active during parent updates. -->
    <section class="picker-host" data-testid="commands">
      <ComposerCommandPicker
        :open="true"
        :commands="candidateKind === 'commands' ? commands : []"
        :skills="candidateKind === 'skills' ? skills : []"
        :quick-prompts="candidateKind === 'quick-prompts' ? quickPrompts : []"
        :quick-prompts-loading="false"
        :quick-prompts-failed="false"
        :picker-kind="candidateKind === 'quick-prompts' ? 'quick-prompt' : 'runner'"
        :skills-enabled="candidateKind === 'skills'"
        :skills-loading="false"
        :skills-failed="false"
        :active-index="0"
        :loading="false"
        :failed="false"
        @activate="record(`command-active:${$event}`)"
        @select="record(`command:${$event.id}`)"
      />
    </section>
    <section class="picker-host" data-testid="files">
      <ComposerReferencePicker
        :open="true"
        :candidates="entries.map((entry) => ({ type: 'file', key: `file:${entry.path}`, entry }))"
        :active-index="0"
        :loading="false"
        query="file"
        @activate="record(`file-active:${$event}`)"
        @select="record(`file:${$event.type === 'file' ? $event.entry.name : ''}`)"
      />
    </section>
  </main>
</template>

<style scoped>
.utility-fixture {
  display: grid;
  gap: 16px;
  padding: 16px;
  max-width: 720px;
}
.utility-fixture > * {
  min-width: 0;
}
.picker-host {
  position: relative;
}
.picker-host :deep(.command-picker) {
  position: static;
}
</style>
