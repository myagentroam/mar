<script setup lang="ts">
import { ref } from 'vue';
import { serializeComposerTag } from '@myagentroam/protocol';
import ConversationTimeline from '../../src/view/conversation/ConversationTimeline.vue';
import type { ConversationItem, ConversationTurn } from '../../src/model/workbench.js';
const copied = ref('');
const collaboration = new URLSearchParams(location.search).has('collaboration');

function fromSession(id: string, name: string, text: string): ConversationItem {
  return {
    id,
    kind: 'user_message',
    processGroup:
      id === 'reviewer'
        ? { id: 'process' }
        : { id: 'second-process', ...(id === 'build' ? { isStart: true } : {}) },
    status: 'COMPLETED',
    startedAt: 1795495200000,
    payload: {
      text: `${text}\n${serializeComposerTag('mar_session_origin', {
        sessionId: id,
        name,
        relation: id === 'reviewer' ? 'child' : 'other'
      })}`
    }
  };
}

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
const turns = ref<ConversationTurn[]>([
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
      ...(collaboration ? [fromSession('reviewer', 'Review session', 'The review is ready.')] : []),
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
  },
  ...(collaboration
    ? [
        {
          id: 'segment-2',
          sessionId: 'root',
          runId: 'run',
          turnId: 'turn',
          segmentIndex: 1,
          status: 'SUCCEEDED' as const,
          items: [
            {
              id: 'visitor',
              kind: 'user_message',
              status: 'COMPLETED',
              payload: {
                text: `${serializeComposerTag('mar_channel', {
                  source: 'WEB_SHARE',
                  channelId: 'share',
                  senderId: 'visitor',
                  name: 'Alice'
                })}\nThanks for the review.`
              }
            },
            fromSession('build', 'Build session', 'The isolated build passed.')
          ] as ConversationItem[]
        }
      ]
    : [])
]);

function addCollaborationMessage() {
  const last = turns.value.at(-1)!;
  turns.value = [
    ...turns.value.slice(0, -1),
    {
      ...last,
      items: [...last.items, fromSession('test', 'Test session', 'Browser checks passed.')]
    }
  ];
}
</script>

<template>
  <main>
    <button v-if="collaboration" type="button" @click="addCollaborationMessage">Add update</button>
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
