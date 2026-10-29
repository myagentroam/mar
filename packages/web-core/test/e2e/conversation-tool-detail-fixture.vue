<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ConversationItem, ConversationTurn } from '../../src/model/workbench.js';
import ConversationToolDetail from '../../src/view/conversation/ConversationToolDetail.vue';

import ConversationTimeline from '../../src/view/conversation/ConversationTimeline.vue';

const integrated = new URL(location.href).searchParams.has('timeline');
const outputUpdates = new URL(location.href).searchParams.has('updates');
const detailOutput = ref<{ text: string; truncated: boolean }>();
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
    outputPreview: 'old',
    exitCode: null,
    truncated: false,
    output: { text: 'combined should not replace streams', truncated: false },
    toolPresentation: {
      kind: 'EXECUTION',
      execution: {
        kind: 'SHELL',
        output: [
          { channel: 'STDOUT', text: 'visible stdout' },
          { channel: 'STDERR', text: 'visible stderr' }
        ]
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
        kind: 'CODE',
        output: [
          { channel: 'STDOUT', text: 'visible stdout' },
          { channel: 'STDERR', text: 'visible stderr' }
        ]
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
      output: { text: 'Partial inspection output', truncated: true },
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
      toolPresentation: { kind: 'READ', paths: ['/fixture/example.ts'] }
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
const turns = computed<ConversationTurn[]>(() => [
  {
    id: 'turn',
    sessionId: 'session',
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
                ? { ...item.payload, output: detailOutput.value }
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
    outputPreview: '',
    exitCode: 0,
    truncated: false,
    toolPresentation: {
      kind: 'EXECUTION',
      execution: {
        kind: 'SHELL',
        output: [
          { channel: 'STDOUT', text: '' },
          { channel: 'STDERR', text: '' }
        ]
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
      outputPreview: 'final',
      exitCode: 0,
      truncated: true,
      output: { text: `${'x'.repeat(10000)}TAIL`, truncated: true },
      toolPresentation: { kind: 'EXECUTION', execution: { kind: 'SHELL' } }
    }
  };
}
</script>

<template>
  <main class="fixture">
    <template v-if="integrated && outputUpdates">
      <button
        data-testid="stream-details"
        @click="detailOutput = { text: '  live output\n\n  next line\n', truncated: false }"
      >
        Stream output
      </button>
      <button
        data-testid="finish-details"
        @click="detailOutput = { text: '  authoritative tail\n', truncated: true }"
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
