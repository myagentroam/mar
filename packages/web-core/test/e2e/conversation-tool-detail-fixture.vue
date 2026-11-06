<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ConversationItem, ConversationTurn } from '../../src/model/workbench.js';
import ConversationToolDetail from '../../src/view/conversation/tool-detail/ConversationToolDetail.vue';
import ConversationDetailPreview from '../../src/view/conversation/ConversationDetailPreview.vue';
import { localePreferenceService } from '../../src/service/locale-preference-service.js';
import { goalMessage } from './support/localized-fixture-data.js';

import ConversationTimeline from '../../src/view/conversation/ConversationTimeline.vue';

const integrated = new URL(location.href).searchParams.has('timeline');
const listLayout = new URL(location.href).searchParams.has('list-layout');
const listDesign = new URL(location.href).searchParams.has('list-design');
const designTasks = [
  'Review the list layout and status hierarchy',
  'Verify clipboard and collapsed-state behavior',
  'Check desktop and mobile presentation'
];
const listSamples: ConversationItem[] = [
  {
    id: 'list-tasks',
    kind: 'todo_list',
    status: 'COMPLETED',
    processGroup: { id: 'process' },
    payload: {
      items: ['PENDING', 'IN_PROGRESS', 'COMPLETED'].map((status, index) => ({
        text: listDesign
          ? designTasks[index]
          : `Verify ${status}: ${'Long task content wraps naturally. '.repeat(4)}`,
        status
      }))
    }
  },
  {
    id: 'list-files',
    kind: 'file_change',
    status: 'COMPLETED',
    processGroup: { id: 'process' },
    payload: {
      changes: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'TYPE_CHANGED'].map(
        (change) => ({
          path: listDesign
            ? `src/conversation/${change.toLowerCase()}.ts`
            : `src/nested/long-path-for-layout-check/${change.toLowerCase()}.ts`,
          change,
          additions: 12,
          deletions: 3
        })
      )
    }
  },
  {
    id: 'list-agents',
    kind: 'tool_call',
    status: 'COMPLETED',
    processGroup: { id: 'process' },
    payload: {
      toolName: 'agent_list',
      agentOperation: {
        action: 'LIST',
        scope: 'tree',
        detail: {},
        targets: [
          { agentId: 'review', title: 'Review native tool details', status: 'RUNNING' },
          { agentId: 'tests', title: 'Check regression coverage', status: 'IDLE' },
          { agentId: 'docs', title: 'Verify documentation links', status: 'SUCCEEDED' }
        ]
      }
    }
  }
];
const taskSnapshotProbe = new URL(location.href).searchParams.has('task-snapshots');
function taskSnapshot(id: string, groupId: string, text: string): ConversationItem {
  return {
    id,
    kind: 'todo_list',
    status: 'COMPLETED',
    processGroup: { id: groupId },
    payload: { items: [{ text, status: 'COMPLETED' }] }
  };
}
const taskSnapshots = ref([taskSnapshot('tasks-initial', 'process', 'Initial task snapshot')]);
const otherProcessTasks = taskSnapshot('tasks-other', 'other-process', 'Separate process task');
const spacingProbe = new URL(location.href).searchParams.has('spacing-probe');
const spacingCases: [string, Record<string, unknown>][] = [
  ['generic-input', { inputSummary: 'Only input' }],
  ['generic-output', { output: { blocks: [{ channel: 'TEXT', text: 'Only output' }] } }],
  [
    'generic-sections',
    { inputSummary: 'Input', output: { blocks: [{ channel: 'TEXT', text: 'Output' }] } }
  ],
  [
    'execution-output',
    {
      toolPresentation: {
        kind: 'EXECUTION',
        execution: { kind: 'CONTROL', output: [{ channel: 'STDOUT', text: 'Only output' }] }
      }
    }
  ],
  [
    'execution-error',
    {
      toolPresentation: {
        kind: 'EXECUTION',
        execution: { kind: 'CONTROL', error: { code: 'EXEC_FAILED', message: 'Only error' } }
      }
    }
  ],
  [
    'execution-heading',
    {
      toolPresentation: { kind: 'EXECUTION', execution: { kind: 'CONTROL', toolName: 'exec_wait' } }
    }
  ],
  ['skill-error', { toolPresentation: { kind: 'SKILL' }, errorCode: 'SKILL_FAILED' }],
  ['skill-heading', { toolPresentation: { kind: 'SKILL', name: 'Only skill' } }],
  ['search-heading', { toolPresentation: { kind: 'WEB_SEARCH' } }],
  ['fetch-heading', { toolPresentation: { kind: 'WEB_FETCH' } }],
  ['tool-search-query', { toolPresentation: { kind: 'TOOL_SEARCH', query: 'Only query' } }],
  ['tool-search-heading', { toolName: 'tool_search', toolPresentation: { kind: 'TOOL_SEARCH' } }]
];
const spacingSamples: ConversationItem[] = spacingCases.map(([id, payload]) => ({
  id,
  kind: 'tool_call',
  status: 'COMPLETED',
  payload
}));
const outputUpdates = new URL(location.href).searchParams.has('updates');
const performanceProbe = new URL(location.href).searchParams.has('performance');
const previewProbe = new URL(location.href).searchParams.has('preview-probe');
const lifecycleProbe = new URL(location.href).searchParams.has('lifecycle-probe');
const lifecycleMounted = ref(true);
const showLifecycleSlot = ref(false);
const pendingCopy = ref<() => void>();
const copyCompleted = ref(false);
const lifecycleItem: ConversationItem = {
  id: 'lifecycle',
  kind: 'reasoning',
  status: 'COMPLETED',
  payload: {}
};
const localeItem: ConversationItem = {
  id: 'locale',
  kind: 'tool_call',
  status: 'COMPLETED',
  payload: {
    toolName: 'custom',
    inputSummary: '  input stays\n  unchanged\n',
    output: {
      blocks: [
        { channel: 'TEXT', text: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') }
      ]
    }
  }
};
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
if (spacingProbe) {
  detailSamples.push(
    {
      id: 'spacing-file',
      kind: 'file_change',
      status: 'COMPLETED',
      payload: {
        changes: [{ path: '/fixture/spacing.ts', change: 'ADDED', additions: 1, deletions: 0 }]
      }
    },
    {
      id: 'spacing-plan-steps',
      kind: 'plan',
      status: 'COMPLETED',
      payload: { steps: [{ text: 'Only step' }] }
    },
    {
      id: 'spacing-plan-intro',
      kind: 'plan',
      status: 'COMPLETED',
      payload: { explanation: 'Plan introduction', steps: [{ text: 'Following step' }] }
    },
    {
      id: 'spacing-image',
      kind: 'tool_call',
      status: 'COMPLETED',
      payload: {
        toolName: 'generate_image',
        toolCategory: 'IMAGE_GENERATION',
        outputSummary: 'Image generation detail'
      }
    }
  );
}
if (new URL(location.href).searchParams.has('reasoning-pair')) {
  detailSamples.splice(detailSamples.findIndex((item) => item.kind === 'reasoning') + 1, 0, {
    id: 'thinking-next',
    kind: 'reasoning',
    status: 'COMPLETED',
    payload: {
      sections: [{ text: 'Check the shared reading start.' }],
      representation: 'visible_thinking'
    }
  });
}
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
    [
      'SEND',
      params.has('agent-goal')
        ? { message: goalMessage, messageIsGoal: true }
        : { message: 'Please check the patch.', delivery: 'QUEUE' },
      [task],
      'send receipt'
    ],
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
if (new URL(location.href).searchParams.has('compact-tools')) {
  for (const [id, toolName, presentation] of [
    [
      'compact-search',
      'tool_search',
      {
        kind: 'TOOL_SEARCH',
        query: 'tools <query>',
        tools: Array.from({ length: 20 }, (_, index) => `tool_result_${index + 1}`)
      }
    ],
    [
      'compact-sleep',
      'sleep',
      { kind: 'SLEEP', durationMs: 1200, elapsedMs: 800, wakeReason: 'steer' }
    ],
    [
      'compact-image',
      'view_image',
      {
        kind: 'IMAGE_VIEW',
        path: '/fixture/example.png',
        mimeType: 'image/png',
        width: 800,
        height: 600,
        sourceWidth: 1600,
        sourceHeight: 1200
      }
    ],
    ['compact-compact', 'smart_compact', { kind: 'COMPACT_REQUEST', accepted: true }]
  ] as const) {
    detailSamples.push({
      id,
      kind: 'tool_call',
      status: 'COMPLETED',
      payload: {
        toolName,
        title: toolName,
        inputSummary: 'raw input for copying',
        toolPresentation: presentation
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
      ...(listLayout ? listSamples : []),
      ...(taskSnapshotProbe ? [...taskSnapshots.value, otherProcessTasks] : []),
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
    <button
      v-if="taskSnapshotProbe"
      data-testid="append-task-snapshot"
      @click="taskSnapshots.push(taskSnapshot('tasks-latest', 'process', 'Latest task snapshot'))"
    >
      Append task snapshot
    </button>
    <section v-if="spacingProbe" data-testid="spacing-probe">
      <ConversationToolDetail
        v-for="item in spacingSamples"
        :key="item.id"
        :data-testid="`spacing-${item.id}`"
        :item="item"
        @copy="copy"
      />
    </section>
    <section v-if="lifecycleProbe" data-testid="lifecycle-probe">
      <button data-testid="toggle-slot" @click="showLifecycleSlot = !showLifecycleSlot">
        Toggle slot
      </button>
      <button data-testid="unmount-detail" @click="lifecycleMounted = false">Unmount detail</button>
      <button
        data-testid="resolve-copy"
        @click="
          copyCompleted = true;
          pendingCopy?.();
        "
      >
        Resolve copy
      </button>
      <output data-testid="copy-pending">{{ Boolean(pendingCopy) }}</output>
      <output data-testid="copy-completed">{{ copyCompleted }}</output>
      <div data-testid="lifecycle-detail">
        <ConversationToolDetail
          v-if="lifecycleMounted"
          :item="lifecycleItem"
          @copy="(_text, done) => (pendingCopy = done)"
        >
          <template v-if="showLifecycleSlot" #default>
            <span data-testid="lifecycle-slot">Slot content</span>
          </template>
        </ConversationToolDetail>
      </div>
      <button data-testid="switch-locale" @click="localePreferenceService().setLocale('zh-CN')">
        Switch locale
      </button>
      <div data-testid="locale-detail">
        <ConversationToolDetail :item="localeItem" @copy="copy" />
      </div>
    </section>
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
