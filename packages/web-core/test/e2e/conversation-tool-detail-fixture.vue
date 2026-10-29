<script setup lang="ts">
import { ref } from 'vue';
import type { ConversationItem } from '../../src/model/workbench.js';
import ConversationToolDetail from '../../src/view/conversation/ConversationToolDetail.vue';

const failed = ref(false);
const copyError = ref(false);
const copied = ref('');
const command = ref<ConversationItem>({
  id: 'exec-a',
  kind: 'command_execution',
  status: 'IN_PROGRESS',
  segmentId: 'segment-a',
  payload: {
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
const empty: ConversationItem = {
  id: 'empty',
  kind: 'command_execution',
  status: 'COMPLETED',
  payload: {
    command: 'true',
    cwd: null,
    outputPreview: '',
    exitCode: 0,
    truncated: false,
    toolPresentation: { kind: 'EXECUTION', execution: { kind: 'SHELL', output: [] } }
  }
};
const failure: ConversationItem = {
  id: 'wait-b',
  kind: 'command_execution',
  status: 'FAILED',
  segmentId: 'segment-b',
  payload: {
    command: 'exec_wait (poll)',
    cwd: null,
    outputPreview: '',
    exitCode: null,
    truncated: false,
    toolPresentation: {
      kind: 'EXECUTION',
      execution: { kind: 'CONTROL', error: { code: 'NOT_FOUND', message: 'Wait failed' } }
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
    <details data-testid="wait">
      <summary>Wait call</summary>
      <ConversationToolDetail :item="failure" @copy="copy" />
    </details>
    <details data-testid="declined">
      <summary>Declined call</summary>
      <ConversationToolDetail :item="declined" @copy="copy" />
    </details>
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
