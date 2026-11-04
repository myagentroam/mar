<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ConversationItem, ConversationTurn } from '../../src/model/workbench.js';
import ConversationToolDetail from '../../src/view/conversation/ConversationToolDetail.vue';
import ConversationDetailPreview from '../../src/view/conversation/ConversationDetailPreview.vue';

import ConversationTimeline from '../../src/view/conversation/ConversationTimeline.vue';

const integrated = new URL(location.href).searchParams.has('timeline');
const outputUpdates = new URL(location.href).searchParams.has('updates');
const performanceProbe = new URL(location.href).searchParams.has('performance');
const previewProbe = new URL(location.href).searchParams.has('preview-probe');
const probeText = ref('wrapped content '.repeat(50));
const sessionVersion = ref(0);
const webLayout = new URL(location.href).searchParams.has('web-layout');
const readAssociation = new URL(location.href).searchParams.has('read-association');
const readPath = new URL(location.href).searchParams.get('read-path') ?? '/fixture/example.ts';
const readTruncation = new URL(location.href).searchParams.get('read-truncation');
const longPreview = new URL(location.href).searchParams.has('preview');
const dropReadAssociation = ref(false);
const readText = '  first file\r\nsecond line\r\n';
const detailOutput = ref<{ blocks: { channel: 'TEXT'; text: string }[]; truncation?: 'SOURCE' }>();
if (longPreview)
  detailOutput.value = {
    blocks: [
      {
        channel: 'TEXT',
        text: Array.from({ length: 40 }, (_, index) => `Returned line ${index + 1}`).join('\n')
      }
    ]
  };
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
      inputSummary: readPath,
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
        paths: [readPath],
        ...(readAssociation
          ? {
              results: [
                {
                  path: readPath,
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
            snippet: 'A plain-text search summary. <plain summary>'
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
if (new URL(location.href).searchParams.has('detail-layout')) {
  detailSamples.push(
    {
      id: 'skill-layout',
      kind: 'tool_call',
      status: 'COMPLETED',
      payload: {
        toolName: 'skill',
        inputSummary: 'original skill request',
        output: {
          blocks: [{ channel: 'TEXT', text: 'Complete skill output is copied, not displayed.' }]
        },
        toolPresentation: {
          kind: 'SKILL',
          name: 'mar-web-spec',
          description:
            'Design <plain> interfaces.\nKeep the original description and its line breaks.'
        }
      }
    },
    {
      id: 'code-layout',
      kind: 'command_execution',
      status: 'COMPLETED',
      payload: {
        toolName: 'code_exec',
        command:
          'const result = await tools.read({ reads: [{ path: "src/fixture.ts" }] });\nobserve.result(result);',
        output: { blocks: [{ channel: 'TEXT', text: 'Observed the requested file.' }] },
        toolPresentation: { kind: 'EXECUTION', execution: { kind: 'CODE' } }
      }
    }
  );
}
if (webLayout) {
  const search = detailSamples.find((item) => item.id === 'search')!;
  search.payload = {
    toolName: 'web_search',
    inputSummary: '{"query":"documentation","options":"copy-only input"}',
    outputSummary: 'Redundant source output is preserved in the copied public record.',
    toolPresentation: {
      kind: 'WEB_SEARCH',
      query: 'Documentation and release notes',
      sources: [
        {
          title: 'Example documentation',
          url: 'https://example.com/docs',
          snippet: 'A plain-text search summary. <plain summary>'
        },
        { url: 'https://example.com/' + 'long-path-segment/'.repeat(12) },
        ...Array.from({ length: 5 }, (_, index) => ({
          title: `Release notes ${index + 1}`,
          url: `https://example.com/releases/${index + 1}`,
          snippet: 'Returned search excerpt. '.repeat(8)
        })),
        {
          title: '<unsafe title>',
          url: 'javascript:alert(1)',
          snippet: '<script>plain text only<\/script>'
        }
      ]
    }
  };
  const fetch = detailSamples.find((item) => item.id === 'fetch')!;
  fetch.payload = {
    toolName: 'web_search',
    inputSummary: '{"type":"open_page","url":"https://example.com/old"}',
    output: {
      blocks: [
        {
          channel: 'TEXT',
          text: Array.from(
            { length: 30 },
            (_, index) => `Returned page paragraph ${index + 1}.`
          ).join('\n\n')
        }
      ],
      truncation: 'SOURCE'
    },
    toolPresentation: {
      kind: 'WEB_FETCH',
      title: 'Example documentation',
      requestUrl: 'https://example.com/old',
      url: 'https://example.com/docs',
      status: 200,
      mode: 'browser',
      contentType: 'text/plain'
    }
  };
}

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
  const params = new URL(location.href).searchParams;
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
  const singleWait = new URL(location.href).searchParams.has('agent-wait-single');
  const waitMs = new URL(location.href).searchParams.has('wait-zero') ? 0 : 300000;
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
      { wait: { waitFor: 'completion', waitMs, ...(singleWait ? {} : { mode: 'any' }) } },
      singleWait
        ? [task]
        : [
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
      status: action === 'WAIT' && singleWait ? 'IN_PROGRESS' : 'COMPLETED',
      payload: {
        toolName: `agent_${action.toLowerCase()}`,
        inputSummary: 'Hidden public input',
        inputTruncated: true,
        agentOperation: {
          action,
          targets: action === 'LIST' && params.has('empty-list') ? [] : targets,
          ...(action === 'LIST' ? { scope: params.get('list-scope') ?? 'tree' } : {}),
          detail
        },
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
if (new URL(location.href).searchParams.has('external-web')) {
  for (const [toolName, presentation] of [
    ['WebSearch', { kind: 'WEB_SEARCH', query: 'Native documentation query' }],
    ['WebFetch', { kind: 'WEB_FETCH', requestUrl: 'https://example.com/native-page' }]
  ] as const) {
    detailSamples.push({
      id: `external-${toolName}`,
      kind: 'tool_call',
      status: 'COMPLETED',
      payload: {
        toolName,
        inputSummary: '{"original":"copy-only native input"}',
        outputSummary: 'Native public output',
        toolPresentation: { ...presentation, detailOnly: true }
      }
    });
  }
}
if (new URL(location.href).searchParams.has('wait-titles')) {
  const source = {
    kind: 'SHELL' as const,
    text: `pnpm test --filter fixture ${'long-argument-'.repeat(24)}`,
    truncated: false
  };
  for (const [toolName, targetId, executionSource] of [
    ['exec_wait', 'p_known', source],
    [
      'code_exec_wait',
      'c_known',
      {
        kind: 'CODE',
        text: `await tools.exec({ command: "${source.text}" });\nawait tools.agent_wait({ agentId: "peer" });`,
        truncated: false
      }
    ],
    ['exec_wait', 'p_unknown', undefined],
    ['code_exec_wait', 'c_unknown', undefined]
  ] as const) {
    detailSamples.push({
      id: `wait-title-${targetId}`,
      kind: 'command_execution',
      status: 'COMPLETED',
      payload: {
        command: '',
        toolPresentation: {
          kind: 'EXECUTION',
          execution: {
            kind: 'CONTROL',
            toolName,
            action: 'poll',
            targetId,
            ...(executionSource === undefined ? {} : { source: executionSource })
          }
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
                            paths: [readPath],
                            ...(dropReadAssociation.value
                              ? {}
                              : {
                                  results: [
                                    {
                                      path: readPath,
                                      startLine: 3,
                                      endLine: longPreview ? 42 : 4,
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
    <section v-if="previewProbe" data-testid="preview-probe" class="conversation-detail-body">
      <button data-testid="stretch-preview" @click="probeText = 'wrapped content '.repeat(800)">
        Stretch preview
      </button>
      <ConversationDetailPreview>
        <pre class="conversation-detail-text">{{ probeText }}</pre>
        <a href="#fixture-source" data-testid="preview-link">Open fixture source</a>
      </ConversationDetailPreview>
    </section>
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
    <output data-testid="copied">{{ copied }}</output>
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
