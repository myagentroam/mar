import { createTooltipApp as createApp } from '../../../packages/web-core/test/e2e/tooltip-app.js';
import { computed, ref } from 'vue';
import '../../../packages/web-core/src/styles.css';
import {
  i18n,
  localePreferenceService
} from '../../../packages/web-core/src/service/LocalePreferenceService.js';
import type {
  ConversationItem,
  ConversationTurn
} from '../../../packages/web-core/src/model/workbench.js';
import ConversationTimeline from '../../../packages/web-core/src/view/conversation/ConversationTimeline.vue';

type CompactState =
  'WAITING' | 'BLOCKING_WAITING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'UNRESOLVED';

declare global {
  interface Window {
    __compactLifecycleHarness: {
      update(state: CompactState): void;
      useToolAnchor(): void;
      itemIds(): string[];
    };
  }
}

localePreferenceService().setLocale('en-US');

function compactItem(
  status: string,
  stage: string | undefined,
  anchorItemId = 'snapshot-anchor',
  code?: string,
  mode = 'BACKGROUND'
): ConversationItem {
  return {
    id: 'mar-agent-compact:compact-1',
    kind: 'context_compaction',
    status,
    payload: {
      phase: status === 'COMPLETED' ? 'COMPLETED' : 'STARTED',
      summary: null,
      mode,
      ...(stage === undefined ? {} : { stage }),
      anchorItemId,
      ...(status === 'COMPLETED' ? { retainedContext: true } : {}),
      ...(code === undefined ? {} : { code })
    }
  };
}

function initialTurn(): ConversationTurn {
  return {
    id: 'turn-1',
    sessionId: 'session-1',
    runId: 'run-1',
    status: 'RUNNING',
    items: [
      {
        id: 'reasoning-before',
        kind: 'reasoning_summary',
        status: 'IN_PROGRESS',
        payload: { sections: [{ text: 'Reasoning before anchor' }] }
      },
      {
        id: 'snapshot-anchor',
        kind: 'assistant_message',
        status: 'COMPLETED',
        payload: { text: 'Snapshot anchor', format: 'markdown', model: 'Fixture model' }
      },
      {
        id: 'reasoning-after',
        kind: 'reasoning_summary',
        status: 'IN_PROGRESS',
        payload: { sections: [{ text: 'Continuing after anchor' }] }
      },
      compactItem('IN_PROGRESS', 'GENERATING')
    ]
  };
}

const app = createApp({
  components: { ConversationTimeline },
  setup() {
    const turn = ref(initialTurn());
    const turns = computed(() => [turn.value]);
    let activeAnchorItemId = 'snapshot-anchor';
    const useToolAnchor = () => {
      activeAnchorItemId = 'snapshot-tool';
      turn.value = {
        ...turn.value,
        items: [
          {
            id: 'reasoning-before',
            kind: 'reasoning_summary',
            status: 'IN_PROGRESS',
            payload: { sections: [{ text: 'Reasoning before anchor' }] }
          },
          {
            id: 'snapshot-tool',
            kind: 'tool_call',
            status: 'COMPLETED',
            payload: {
              namespace: 'mar-agent',
              toolName: 'read',
              input: { path: 'README.md' },
              outputSummary: 'Read the snapshot file',
              errorCode: null,
              truncated: false
            }
          },
          {
            id: 'reasoning-after',
            kind: 'reasoning_summary',
            status: 'IN_PROGRESS',
            payload: { sections: [{ text: 'Continuing after anchor' }] }
          },
          compactItem('IN_PROGRESS', 'GENERATING', activeAnchorItemId)
        ]
      };
    };
    const update = (state: CompactState) => {
      if (state === 'UNRESOLVED') {
        turn.value = {
          ...turn.value,
          items: [
            {
              id: 'reasoning-before',
              kind: 'reasoning_summary',
              status: 'IN_PROGRESS',
              payload: { sections: [{ text: 'Reasoning before anchor' }] }
            },
            compactItem('COMPLETED', undefined, 'not-on-this-page'),
            {
              id: 'reasoning-after',
              kind: 'reasoning_summary',
              status: 'IN_PROGRESS',
              payload: { sections: [{ text: 'Continuing after anchor' }] }
            }
          ]
        };
        return;
      }
      const status =
        state === 'COMPLETED'
          ? 'COMPLETED'
          : state === 'FAILED'
            ? 'FAILED'
            : state === 'CANCELLED'
              ? 'CANCELLED'
              : 'IN_PROGRESS';
      const stage = state === 'WAITING' || state === 'BLOCKING_WAITING' ? 'WAITING' : undefined;
      const mode = state === 'BLOCKING_WAITING' ? 'BLOCKING' : 'BACKGROUND';
      const code =
        state === 'FAILED'
          ? 'MAR_AGENT_COMPACT_FAILED'
          : state === 'CANCELLED'
            ? 'MAR_AGENT_COMPACT_CANCELLED'
            : undefined;
      const items = turn.value.items.map((item) =>
        item.id === 'mar-agent-compact:compact-1'
          ? compactItem(status, stage, activeAnchorItemId, code, mode)
          : item
      );
      if (state === 'COMPLETED' && !items.some((item) => item.id === 'tail-message'))
        items.push({
          id: 'tail-message',
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: { text: 'Tail after compaction', format: 'markdown', model: 'Fixture model' }
        });
      turn.value = { ...turn.value, items };
    };
    window.__compactLifecycleHarness = {
      update,
      useToolAnchor,
      itemIds: () => turn.value.items.map((item) => item.id)
    };
    return {
      turns,
      noImageAttachments: () => [],
      noQuestions: () => [],
      noAnswer: () => '',
      notSubmitted: () => false
    };
  },
  template: `
    <main>
      <ConversationTimeline
        :turns="turns"
        :workspace-root="undefined"
        :loading="false"
        :initializing="false"
        :initial-render-version="1"
        :image-attachments="noImageAttachments"
        :user-input-questions="noQuestions"
        :user-input-answer="noAnswer"
        :user-input-submitted="notSubmitted"
        :plan-continuation="undefined"
        :node-ready="false"
        :rewind-enabled="false"
        :rollback-enabled="false"
      />
    </main>
  `
});

app.use(i18n).mount('#app');
