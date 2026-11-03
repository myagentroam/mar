<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ConversationItem, ConversationTurn } from '../../src/model/workbench.js';
import ConversationToolDetail from '../../src/view/conversation/ConversationToolDetail.vue';

import ConversationTimeline from '../../src/view/conversation/ConversationTimeline.vue';

const integrated = new URL(location.href).searchParams.has('timeline');
const outputUpdates = new URL(location.href).searchParams.has('updates');
const performanceProbe = new URL(location.href).searchParams.has('performance');
const sessionVersion = ref(0);
const readAssociation = new URL(location.href).searchParams.has('read-association');
const readTruncation = new URL(location.href).searchParams.get('read-truncation');
const dropReadAssociation = ref(false);
const readText = '  first file\r\nsecond line\r\n';
const detailOutput = ref<{ blocks: { channel: 'TEXT'; text: string }[]; truncation?: 'SOURCE' }>();
const failed = ref(false);
const copyError = ref(false);
const copied = ref('');
const command = ref<ConversationItem>({
  id: 'exec-a',
  kind: 'command_execution',
  status: 'IN_PROGRESS',
  segmentId: 'segment-a',
  payload: {
    toolName: 'exec',
    command: 'printf test',
    cwd: '/fixture',
    exitCode: null,
    output: {
      blocks: [
        { channel: 'STDOUT', text: 'visible stdout' },
        { channel: 'STDERR', text: 'visible stderr' }
      ]
    },
    toolPresentation: {
      kind: 'EXECUTION',
      execution: {
        kind: 'SHELL'
      }
    }
  }
});
if (new URL(location.href).searchParams.has('long')) {
  command.value.payload = {
    ...command.value.payload,
    command:
      'observe.result(await tools.exec({command: "pnpm --filter @myagentroam/web-core test && pnpm --filter @myagentroam/web-console typecheck", cwd: "/workspace/project", yieldMs: 1000}));',
    cwd: null,
    toolPresentation: {
      kind: 'EXECUTION',
      execution: {
        kind: 'CODE'
      }
    }
  };
}
const detailSamples: ConversationItem[] = [
  {
    id: 'generic',
    kind: 'tool_call',
    status: 'FAILED',
    payload: {
      toolName: 'inspect',
      title: 'Inspect fixture',
      inputSummary: 'Preserved input',
      output: {
        blocks: [{ channel: 'TEXT', text: 'Partial inspection output' }],
        truncation: 'SOURCE'
      },
      progressLabel: 'Stopped at the last file',
      errorCode: 'INSPECTION_FAILED'
    }
  },
  {
    id: 'thinking',
    kind: 'reasoning',
    status: 'COMPLETED',
    payload: {
      sections: [
        { text: 'Inspect the output, then verify the relevant files.\nKeep the changes focused.' }
      ],
      representation: 'visible_thinking'
    }
  },
  {
    id: 'read',
    kind: 'tool_call',
    status: 'COMPLETED',
    payload: {
      toolName: 'read',
      inputSummary: '/fixture/example.ts',
      outputSummary: '1: export const result = true;',
      ...(readAssociation
        ? {
            output: {
              blocks: [{ channel: 'TEXT', text: readText }],
              ...(readTruncation === 'HEAD' || readTruncation === 'SOURCE'
                ? { truncation: readTruncation }
                : {})
            }
          }
        : {}),
      toolPresentation: {
        kind: 'READ',
        paths: ['/fixture/example.ts'],
        ...(readAssociation
          ? {
              results: [
                {
                  path: '/fixture/example.ts',
                  startLine: 3,
                  endLine: 4,
                  contentRange: { channel: 'TEXT', start: 0, end: readText.length }
                }
              ]
            }
          : {})
      }
    }
  },
  {
    id: 'search',
    kind: 'tool_call',
    status: 'COMPLETED',
    payload: {
      toolName: 'web_search',
      inputSummary: 'documentation',
      outputSummary: 'Relevant documentation found.',
      toolPresentation: {
        kind: 'WEB_SEARCH',
        query: 'documentation',
        sources: [
          {
            title: 'Example documentation',
            url: 'https://example.com/docs',
            snippet: 'A plain-text search summary.'
          }
        ]
      }
    }
  },
  {
    id: 'fetch',
    kind: 'tool_call',
    status: 'COMPLETED',
    payload: {
      toolName: 'web_fetch',
      inputSummary: 'https://example.com/docs',
      outputSummary:
        'The requested page content.\nThe next paragraph remains in the same reading surface.',
      toolPresentation: {
        kind: 'WEB_FETCH',
        url: 'https://example.com/docs',
        title: 'Example documentation'
      }
    }
  },
  {
    id: 'child',
    kind: 'tool_call',
    status: 'COMPLETED',
    payload: {
      toolName: 'agent_send',
      subagentOperation: 'MESSAGE',
      subagentId: 'child-session',
      title: 'Review the change',
      inputSummary: 'Review the relevant files.',
      outputSummary: 'Message delivered.'
    }
  }
];
if (new URL(location.href).searchParams.has('specialized')) {
  detailSamples.push(
    {
      id: 'image',
      kind: 'tool_call',
      status: 'COMPLETED',
      payload: {
        toolName: 'view_image',
        toolPresentation: {
          kind: 'IMAGE_VIEW',
          path: '/fixture/image.png',
          mimeType: 'image/png',
          width: 30,
          height: 20
        }
      }
    },
    {
      id: 'tool-search',
      kind: 'tool_call',
      status: 'COMPLETED',
      payload: {
        toolName: 'tool_search',
        toolPresentation: { kind: 'TOOL_SEARCH', query: 'find tool', tools: ['mcp__example'] }
      }
    },
    {
      id: 'compact-request',
      kind: 'tool_call',
      status: 'COMPLETED',
      payload: {
        toolName: 'smart_compact',
        toolPresentation: { kind: 'COMPACT_REQUEST', accepted: true }
      }
    }
  );
}
if (new URL(location.href).searchParams.has('agent-cards')) {
  detailSamples.push({
    id: 'native-agent-card',
    kind: 'tool_call',
    status: 'COMPLETED',
    payload: {
      namespace: 'codex',
      toolName: 'spawn_agent',
      title: 'Native review',
      subagentOperation: 'START',
      subagentCallDetail: { message: 'Inspect the native change.' },
      inputSummary: '{"message":"Inspect the native change."}'
    }
  });
  const stopTruncation = new URL(location.href).searchParams.get('stop-truncation');
  const task = {
    agentId: 'peer',
    sessionId: 'peer',
    title: new URL(location.href).searchParams.has('long-title')
      ? 'UnbrokenTitle'.repeat(35)
      : 'Review the boundary'
  };
  for (const [action, detail, targets, output] of [
    [
      'START',
      { title: task.title, message: 'Initial task\nwith a second line.' },
      [task],
      'start receipt'
    ],
    ['SEND', { message: 'Please check the patch.', delivery: 'QUEUE' }, [task], 'send receipt'],
    [
      'WAIT',
      {},
      [
        { ...task, status: 'SUCCEEDED', message: 'Finished review.' },
        { agentId: 'other', title: 'Other task', status: 'RUNNING', message: 'Still working.' }
      ],
      'wait receipt'
    ],
    [
      'LIST',
      {},
      [
        { ...task, status: 'SUCCEEDED' },
        { agentId: 'other', title: 'Other task', status: 'IDLE' }
      ],
      'list receipt'
    ],
    [
      'VIEW',
      {},
      [{ ...task, status: 'SUCCEEDED', message: 'Public view result.' }],
      'view receipt'
    ],
    ['STOP', {}, [task], '{"status":"accepted"}\n']
  ] as const) {
    detailSamples.push({
      id: `card-${action}`,
      kind: 'tool_call',
      status: 'COMPLETED',
      payload: {
        toolName: `agent_${action.toLowerCase()}`,
        inputSummary: 'Hidden public input',
        inputTruncated: true,
        agentOperation: { action, targets, detail },
        output: {
          blocks: [{ channel: 'TEXT', text: output }],
          ...(action === 'STOP' && (stopTruncation === 'HEAD' || stopTruncation === 'SOURCE')
            ? { truncation: stopTruncation }
            : {})
        }
      }
    });
  }
}
const turns = computed<ConversationTurn[]>(() => [
  {
    id: 'turn',
    sessionId: `session-${sessionVersion.value}`,
    runId: 'run',
    status: 'SUCCEEDED',
    items: [
      {
        id: 'user',
        kind: 'user_message',
        status: 'COMPLETED',
        payload: { text: 'Check the command output' }
      },
      { ...command.value, status: 'COMPLETED', processGroup: { id: 'process', isStart: true } },
      ...(new URL(location.href).searchParams.has('unified')
        ? detailSamples.map((item) => ({
            ...item,
            payload:
              item.kind === 'tool_call' && detailOutput.value
                ? {
                    ...item.payload,
                    output: detailOutput.value,
                    ...(item.id === 'read' && readAssociation
                      ? {
                          toolPresentation: {
                            kind: 'READ',
                            paths: ['/fixture/example.ts'],
                            ...(dropReadAssociation.value
                              ? {}
                              : {
                                  results: [
                                    {
                                      path: '/fixture/example.ts',
                                      startLine: 3,
                                      endLine: 4,
                                      contentRange: {
                                        channel: 'TEXT',
                                        start: 0,
                                        end: detailOutput.value.blocks[0]?.text.length ?? 0
                                      }
                                    }
                                  ]
                                })
                          }
                        }
                      : {})
                  }
                : item.payload,
            processGroup: { id: 'process' }
          }))
        : []),
      {
        id: 'reply',
        kind: 'assistant_message',
        status: 'COMPLETED',
        payload: { text: 'The command finished.', format: 'markdown' }
      }
    ]
  }
]);
const empty: ConversationItem = {
  id: 'empty',
  kind: 'command_execution',
  status: 'COMPLETED',
  payload: {
    command: 'true',
    cwd: '',
    exitCode: 0,
    output: { blocks: [] },
    toolPresentation: {
      kind: 'EXECUTION',
      execution: {
        kind: 'SHELL'
      }
    }
  }
};
const failure: ConversationItem = {
  id: 'wait-b',
  kind: 'command_execution',
  status: 'FAILED',
  segmentId: 'segment-b',
  payload: {
    command: 'exec_wait',
    cwd: null,
    outputPreview: '',
    exitCode: null,
    truncated: false,
    toolPresentation: {
      kind: 'EXECUTION',
      execution: {
        kind: 'CONTROL',
        toolName: 'exec_wait',
        action: 'poll',
        targetId: 'p_fixture',
        source: { kind: 'SHELL', text: 'pnpm test --filter fixture', truncated: false },
        error: { code: 'NOT_FOUND', message: 'Wait failed' }
      }
    }
  }
};
const declined: ConversationItem = { ...empty, id: 'declined', status: 'DECLINED' };
async function copy(text: string, done: () => void) {
  copyError.value = false;
  try {
    if (failed.value) throw new Error('clipboard failed');
    await navigator.clipboard.writeText(text);
    copied.value = text;
    done();
  } catch {
    copyError.value = true;
  }
}
function finish() {
  command.value = {
    ...command.value,
    status: 'COMPLETED',
    payload: {
      command: 'printf test',
      cwd: '/fixture',
      exitCode: 0,
      output: {
        blocks: [{ channel: 'STDOUT', text: `${'x'.repeat(9996)}TAIL` }],
        truncation: new URL(location.href).searchParams.has('head') ? 'HEAD' : 'SOURCE'
      },
      toolPresentation: {
        kind: 'EXECUTION',
        execution: { kind: 'SHELL' }
      }
    }
  };
}
</script>

<template>
  <main class="fixture">
    <button v-if="performanceProbe" data-testid="switch-session" @click="sessionVersion++">
      Switch fixture session
    </button>
    <template v-if="integrated && outputUpdates">
      <button
        data-testid="stream-details"
        @click="
          detailOutput = { blocks: [{ channel: 'TEXT', text: '  live output\n\n  next line\n' }] }
        "
      >
        Stream output
      </button>
      <button
        data-testid="clear-read-association"
        @click="
          dropReadAssociation = true;
          detailOutput = { blocks: [{ channel: 'TEXT', text: 'unassociated replacement' }] };
        "
      >
        Replace without association
      </button>
      <button
        data-testid="finish-details"
        @click="
          detailOutput = {
            blocks: [{ channel: 'TEXT', text: '  authoritative tail\n' }],
            truncation: 'SOURCE'
          }
        "
      >
        Finish output
      </button>
    </template>
    <ConversationTimeline
      v-if="integrated"
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
      @copy="copy"
    />
    <template v-else>
      <button data-testid="finish" @click="finish">Finish</button>
      <button data-testid="fail-copy" @click="failed = true">Fail copy</button>
      <output data-testid="copy-error">{{ copyError }}</output>
      <output data-testid="copied">{{ copied }}</output>
      <details data-testid="exec">
        <summary>Execution</summary>
        <ConversationToolDetail :item="command" @copy="copy" />
      </details>
      <details data-testid="empty">
        <summary>Empty execution</summary>
        <ConversationToolDetail :item="empty" @copy="copy" />
      </details>
      <details data-testid="generic">
        <summary>Generic tool</summary>
        <ConversationToolDetail :item="detailSamples[0]!" @copy="copy" />
      </details>
      <details data-testid="wait">
        <summary>Wait call</summary>
        <ConversationToolDetail :item="failure" @copy="copy" />
      </details>
      <details data-testid="declined">
        <summary>Declined call</summary>
        <ConversationToolDetail :item="declined" @copy="copy" />
      </details>
    </template>
  </main>
</template>

<style scoped>
.fixture {
  max-width: 720px;
  margin: auto;
}
.fixture > details {
  margin: 1rem 0;
}
output[data-testid='copied'] {
  display: none;
}
</style>
