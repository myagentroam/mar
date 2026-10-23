<script setup lang="ts">
import { ref } from 'vue';
import type { ConversationItem, ConversationTurn } from '../../src/model/workbench.js';
import ConversationTimeline from '../../src/view/conversation/ConversationTimeline.vue';
import ConversationWorkProcess from '../../src/view/conversation/ConversationWorkProcess.vue';
import ConversationComposer from '../../src/view/composer/ConversationComposer.vue';
import ConversationHeader from '../../src/view/conversation/ConversationHeader.vue';
import ConversationScroll from '../../src/view/conversation/ConversationScroll.vue';
import SessionPerformanceInfo from '../../src/view/conversation/SessionPerformanceInfo.vue';
import WorkbenchHeader from '../../src/view/workbench/WorkbenchHeader.vue';

const following = ref(false);
const input = ref('Review the result');
const sidebarCollapsed = ref(false);
const items: ConversationItem[] = [
  { id: 'compact', kind: 'context_compaction', status: 'COMPLETED', payload: {} },
  {
    id: 'tasks',
    kind: 'todo_list',
    status: 'COMPLETED',
    payload: { items: [{ text: 'Check the result', status: 'PENDING' }] }
  },
  {
    id: 'command',
    kind: 'command_execution',
    status: 'COMPLETED',
    payload: { command: 'echo review', output: 'Review output' }
  },
  {
    id: 'read',
    kind: 'tool_call',
    status: 'COMPLETED',
    payload: { toolName: 'read', toolPresentation: { kind: 'READ', paths: ['src/a.ts'] } }
  },
  {
    id: 'changes',
    kind: 'file_change',
    status: 'COMPLETED',
    payload: {
      changes: [
        { path: 'src/a.ts', change: 'MODIFIED' },
        { path: 'src/b.ts', change: 'ADDED' }
      ]
    }
  },
  {
    id: 'plan',
    kind: 'plan',
    status: 'COMPLETED',
    payload: {
      steps: [
        { text: 'Review behavior', status: 'pending' },
        { text: 'Run tests', status: 'pending' }
      ]
    }
  }
];
const turns: ConversationTurn[] = [
  { id: 'turn', sessionId: 'session', runId: 'run', status: 'SUCCEEDED', items }
];
</script>

<template>
  <main class="conversation-style-fixture">
    <WorkbenchHeader
      :mobile-viewport="false"
      view="nodes"
      :sidebar-collapsed="sidebarCollapsed"
      settings-section="appearance"
      management-section="users"
      :settings-items="[]"
      :management-items="[]"
      :conversation-title="undefined"
      @toggle-sidebar="sidebarCollapsed = !sidebarCollapsed"
    />
    <section aria-label="Utility controls">
      <button class="icon-button utility-control" data-testid="native-utility">Utility</button>
      <el-button class="utility-control" data-testid="element-utility">Utility</el-button>
      <el-button class="utility-control" disabled data-testid="disabled-utility"
        >Disabled utility</el-button
      >
    </section>
    <ConversationHeader
      :session="{
        id: 'session-fixture',
        workspaceId: 'workspace',
        runner: 'mar-agent',
        externalSessionId: 'native-session'
      }"
      runner="mar-agent"
      :files-ready="true"
      :terminal-ready="true"
      :content-search-ready="true"
      :runner-icon="() => ''"
      :session-title="() => 'Review session'"
      :activity="() => 'IDLE'"
      :activity-label="() => 'Idle'"
    />
    <ConversationWorkProcess
      :block="{
        id: 'process',
        groupId: 'process',
        entries: [],
        active: true,
        partial: false,
        sealed: false
      }"
      :synchronized="true"
      :now="undefined"
      >Process content</ConversationWorkProcess
    >
    <ConversationTimeline
      :turns="turns"
      :loading="false"
      :initializing="false"
      :initial-render-version="0"
      :image-attachments="() => []"
      :user-input-questions="() => []"
      :user-input-answer="() => ''"
      :user-input-submitted="() => false"
      :node-ready="false"
      :rewind-enabled="false"
      :rollback-enabled="false"
    />
    <button data-testid="toggle-following" @click="following = !following">Toggle following</button>
    <section class="scroll-sample">
      <ConversationScroll
        :has-older="false"
        :loading-initial="false"
        :initial-load-failed="false"
        :loading-older="false"
        :has-turns="true"
        :following="following"
      >
        <p>Latest message</p>
        <template #status
          ><SessionPerformanceInfo
            :performance="{ runId: 'run', latencyMs: 420, tokensPerSecond: 42 }"
        /></template>
      </ConversationScroll>
    </section>
    <ConversationComposer
      v-model:input="input"
      placeholder="Message"
      :working="true"
      working-label="Working"
      :readonly="false"
      :drop-target="false"
      :mobile-viewport="false"
      :command-states="[]"
      :loading="false"
      :skill-tokens="[]"
    />
  </main>
</template>

<style scoped>
.conversation-style-fixture {
  max-width: 850px;
  margin: auto;
  padding: 16px;
}
.scroll-sample {
  display: flex;
  height: 220px;
  position: relative;
}
</style>
