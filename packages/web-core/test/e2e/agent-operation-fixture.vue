<script setup lang="ts">
import { ref } from 'vue';
import ConversationTimeline from '../../src/view/conversation/ConversationTimeline.vue';
import type { ConversationItem, ConversationTurn } from '../../src/model/workbench.js';
const copied = ref('');

function item(
  id: string,
  payload: object,
  status: ConversationItem['status'] = 'COMPLETED',
  parentItemId?: string
): ConversationItem {
  return {
    id,
    kind: 'tool_call',
    status,
    ...(parentItemId === undefined ? {} : { parentItemId }),
    processGroup: { id: 'process', ...(id === 'mar-start' ? { isStart: true } : {}) },
    payload
  };
}
const turns: ConversationTurn[] = [
  {
    id: 'turn',
    sessionId: 'root',
    runId: 'run',
    status: 'SUCCEEDED',
    items: [
      item(
        'mar-start',
        {
          toolName: 'agent_start',
          agentOperation: {
            action: 'START',
            targets: [{ agentId: 'peer', sessionId: 'peer', title: 'Review the implementation' }]
          },
          output: { blocks: [{ channel: 'TEXT', text: 'Agent created.' }] }
        },
        'COMPLETED',
        'first-code-cell'
      ),
      item(
        'mar-send',
        {
          toolName: 'agent_send',
          agentOperation: { action: 'SEND', targets: [{ agentId: 'peer', sessionId: 'peer' }] },
          inputSummary: '{"agentId":"peer"}',
          output: { blocks: [{ channel: 'TEXT', text: 'Target is unavailable.' }] },
          errorCode: 'AGENT_UNAVAILABLE'
        },
        'FAILED',
        'second-code-cell'
      ),
      ...[
        ['codex', 'spawn_agent', 'Inspect persistence'],
        ['claude', 'Agent', 'Check browser interactions'],
        ['opencode', 'task', 'Review public contracts']
      ].map(([id, toolName, title]) =>
        item(id!, {
          toolName,
          title,
          subagentOperation: 'START',
          subagentId: `native-${id}`,
          output: { blocks: [{ channel: 'TEXT', text: 'Native operation accepted.' }] }
        })
      ),
      item(
        'wait',
        {
          toolName: 'agent_wait',
          agentOperation: {
            action: 'WAIT',
            targets: [
              { agentId: 'peer', sessionId: 'peer', title: 'Review the implementation' },
              {
                agentId: 'other',
                sessionId: 'other',
                title: `Check the final result ${'long task '.repeat(30)}END`
              }
            ]
          },
          output: {
            blocks: [{ channel: 'TEXT', text: 'Timeout. Both targets are still running.' }]
          }
        },
        'IN_PROGRESS'
      ),
      item('list', {
        toolName: 'agent_list',
        agentOperation: { action: 'LIST', scope: 'profile', targets: [] },
        output: { blocks: [{ channel: 'TEXT', text: 'Available Runner profile.' }] }
      }),
      item('unknown', {
        toolName: 'agent_send',
        inputSummary: '{"agentId":"not-a-mapping"}',
        output: { blocks: [{ channel: 'TEXT', text: 'No public Agent metadata.' }] }
      }),
      {
        id: 'answer',
        kind: 'assistant_message',
        status: 'COMPLETED',
        payload: { text: 'Review complete.', format: 'markdown' }
      }
    ]
  }
];
</script>

<template>
  <main>
    <ConversationTimeline
      :turns="turns"
      :workspace-root="undefined"
      :loading="false"
      :initializing="false"
      :initial-render-version="0"
      :capture-render-anchor="() => () => {}"
      :image-attachments="() => []"
      :user-input-questions="() => []"
      :user-input-answer="() => ''"
      :user-input-submitted="() => false"
      :plan-continuation="undefined"
      :node-ready="false"
      :rewind-enabled="false"
      :rollback-enabled="false"
      @copy="
        (text, done) => {
          copied = text;
          done();
        }
      "
    />
    <output data-testid="copied-record" hidden>{{ copied }}</output>
  </main>
</template>

<style scoped>
main {
  max-width: 56rem;
  margin: 0 auto;
  padding: 1rem;
}
</style>
