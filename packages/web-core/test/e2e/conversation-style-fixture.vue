<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import MarIcon from '../../../mar-ui/icons/MarIcon.vue';
import { unicodeLongFilePath } from '../support/unicode-layout-fixtures.js';
import type { ConversationItem, ConversationTurn } from '../../src/model/workbench.js';
import ConversationTimeline from '../../src/view/conversation/ConversationTimeline.vue';
import ConversationWorkProcess from '../../src/view/conversation/ConversationWorkProcess.vue';
import ConversationComposer from '../../src/view/composer/ConversationComposer.vue';
import ConversationHeader from '../../src/view/conversation/ConversationHeader.vue';
import ConversationScroll from '../../src/view/conversation/ConversationScroll.vue';
import SessionPerformanceInfo from '../../src/view/conversation/SessionPerformanceInfo.vue';
import WorkbenchHeader from '../../src/view/workbench/WorkbenchHeader.vue';
import WorkbenchActivityCenter from '../../src/view/workbench/WorkbenchActivityCenter.vue';
import ThemePreview from '../../src/view/settings/ThemePreview.vue';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';
import { createWorkbenchNotificationService } from '../../src/service/workbench-notification-service.js';
import { localePreferenceService } from '../../src/service/locale-preference-service.js';
import { createConversationScrollService } from '../../src/service/conversation-scroll-service.js';

const captureRenderAnchor = createConversationScrollService().captureRenderAnchor;
const following = ref(false);
const input = ref('Review the result');
const sidebarCollapsed = ref(false);
const reconnecting = new URL(location.href).searchParams.has('reconnecting');
const processStopping = new URL(location.href).searchParams.has('process-stopping');
const themes = themePreferenceService();
const previewColors = themes.resolveColors(
  themes.builtinSource(themes.baseTheme.value, 'Fixture preview')
);
const notificationLoads = ref(0);
const notifications = createWorkbenchNotificationService(ref('fixture'), {
  request: async <T,>() => {
    notificationLoads.value++;
    return { notifications: [], recentRuns: [] } as T;
  }
});
const touchDetails = new URL(location.href).searchParams.has('touch-details');
const detailSurfaceFixture = new URL(location.href).searchParams.has('detail-surfaces');
const previewFixture = new URL(location.href).searchParams.has('reasoning-preview');
const performanceFixture = new URL(location.href).searchParams.has('live-performance');
const clockIsolationFixture = new URL(location.href).searchParams.has('clock-isolation');
let clockPayloadReads = 0;
if (clockIsolationFixture)
  Object.defineProperty(window, '__conversationClockPayloadReads', {
    get: () => clockPayloadReads,
    configurable: true
  });
const livePerformance = ref<{ runId: string; latencyMs: number; tokensPerSecond?: number }>();
const spacingFixture = new URL(location.href).searchParams.has('group-spacing');
const readFilesFixture = new URL(location.href).searchParams.has('read-files');
const historyActionsFixture = new URL(location.href).searchParams.has('history-actions');
const markdownBlocksFixture = new URL(location.href).searchParams.has('markdown-blocks');
const fileChangeResultFixture = new URL(location.href).searchParams.has('file-change-result');
const resultOpenedFile = ref('');
const previewRunStatus = ref<'RUNNING' | 'SUCCEEDED'>('RUNNING');
const stressFixture = new URL(location.href).searchParams.has('reasoning-stress');
const loadingFixture = new URL(location.href).searchParams.has('loading-lifecycle');
const synchronized = ref(previewFixture || fileChangeResultFixture);
const renderedVersion = ref(0);
const timelineVisible = ref(true);
const initializing = ref(false);
const renderVersion = ref(0);
const previewText = `Inspecting ../workspace ${'workspace '.repeat(20)}https://example.com/search?q=one,two&next=2 changes`;
const items: ConversationItem[] = [
  {
    id: 'user',
    kind: 'user_message',
    status: 'COMPLETED',
    payload: { text: 'Fixture user message' }
  },
  {
    id: 'failure',
    kind: 'error',
    status: 'FAILED',
    payload: { code: 'FIXTURE_FAILURE', message: 'Fixture diagnostic' }
  },
  { id: 'compact', kind: 'context_compaction', status: 'COMPLETED', payload: {} },
  {
    id: 'tasks',
    kind: 'todo_list',
    status: 'COMPLETED',
    payload: {
      items: [
        { text: 'Check the result', status: 'PENDING' },
        { text: 'Implement the change', status: 'IN_PROGRESS' },
        { text: 'Inspect the result', status: 'COMPLETED' }
      ]
    }
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
        {
          path: 'src/a.ts',
          change: 'MODIFIED',
          ...(touchDetails ? { diff: { status: 'unavailable', reason: 'binary' } } : {})
        },
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
  },
  {
    id: 'child',
    kind: 'tool_call',
    status: 'COMPLETED',
    payload: { subagentOperation: 'START', subagentId: 'child', prompt: 'Review the change' }
  }
];
if (detailSurfaceFixture) {
  items.push(
    {
      id: 'generated-detail',
      kind: 'tool_call',
      status: 'COMPLETED',
      payload: {
        toolCategory: 'IMAGE_GENERATION',
        toolName: 'generate',
        inputSummary: 'Preserve the image prompt'
      }
    },
    {
      id: 'fallback-detail',
      kind: 'turn_summary',
      status: 'COMPLETED',
      payload: { text: 'Fallback heading', reason: 'Preserve the fallback detail' }
    }
  );
}
const turns = ref<ConversationTurn[]>([
  {
    id: 'turn',
    sessionId: 'session',
    runId: 'run',
    status: previewFixture ? 'RUNNING' : 'SUCCEEDED',
    items: previewFixture
      ? [
          {
            id: 'progress-reply',
            kind: 'assistant_message',
            status: 'COMPLETED',
            payload: { text: 'I identified the files to review.' }
          },
          {
            id: 'thinking',
            kind: 'reasoning',
            status: 'COMPLETED',
            startedAt: Date.now() - 258_000,
            processGroup: { id: 'preview-process', isStart: true },
            payload: {
              representation: 'visible_thinking',
              sections: [
                {
                  get text() {
                    if (clockIsolationFixture) clockPayloadReads++;
                    return `## ${previewText}: Full thinking detail\nSecond thinking line`;
                  }
                }
              ]
            }
          }
        ]
      : spacingFixture
        ? ['command', 'read', 'tool', 'subagent'].flatMap((kind) =>
            Array.from({ length: 3 }, (_, index): ConversationItem => ({
              id: `${kind}-${index}`,
              kind: kind === 'command' ? 'command_execution' : 'tool_call',
              status: kind === 'command' && index === 0 ? 'FAILED' : 'COMPLETED',
              processGroup: { id: 'spacing-process', isStart: kind === 'command' && index === 0 },
              payload:
                kind === 'command'
                  ? {
                      command:
                        index === 0
                          ? `const command = "${'long-command-with-original-content-'.repeat(10)}";\nobserve.result(await tools.exec({ command }));\n// Full command tail`
                          : `echo review-${index}`,
                      ...(index === 0 ? { durationMs: 3_000 } : {}),
                      ...(index === 1 ? {} : { outputPreview: 'Review output' })
                    }
                  : {
                      toolName: kind === 'read' ? 'read' : 'review',
                      outputSummary: 'Review output',
                      ...(kind === 'read'
                        ? { toolPresentation: { kind: 'READ', paths: [`src/file-${index}.ts`] } }
                        : kind === 'subagent'
                          ? { subagentOperation: 'MESSAGE', subagentId: 'reviewer' }
                          : {})
                    }
            }))
          )
        : items
  }
]);
if (markdownBlocksFixture) {
  localePreferenceService().setLocale(
    new URL(location.href).searchParams.get('language') === 'zh-CN' ? 'zh-CN' : 'en-US'
  );
  turns.value = [
    {
      ...turns.value[0]!,
      items: [
        { ...items[0]!, payload: { text: '把待办任务的标题提取出来，并给出验证命令。' } },
        {
          id: 'markdown-reply',
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: {
            text: [
              '下面的函数保留尚未完成的任务，返回它们的标题。行内代码 `task.title` 保持原来的样式。',
              '```typescript',
              '// Preserve original whitespace when copying.',
              'type Task = { title: string; completed: boolean };',
              'const docs = "https://example.invalid/documentation/a-very-long-unbroken-path-that-stays-on-one-source-line-without-changing-the-original-copied-code";',
              '',
              'export function pendingTitles(tasks: Task[]): string[] {',
              '  return tasks.filter((task) => !task.completed).map((task) => task.title);',
              '}',
              '```',
              '',
              '未声明语言的代码块使用通用标签，仍可完整复制：',
              '```',
              'pnpm --dir packages/web-core exec vitest run test/unit/agent-markdown.test.ts',
              '```'
            ].join('\n')
          }
        }
      ]
    }
  ];
}
function replaceMarkdownReply() {
  turns.value = turns.value.map((turn) => ({
    ...turn,
    items: turn.items.map((item) =>
      item.id === 'markdown-reply'
        ? {
            ...item,
            payload: {
              text: '```<img onerror=alert(1)>\n<script>window.markdownExecuted = true<\/script>\n```\n\n```ts\nconst next = "updated";\n```'
            }
          }
        : item
    )
  }));
}
if (fileChangeResultFixture) {
  const base = { ...turns.value[0]!, turnId: 'file-result-round', status: 'RUNNING' as const };
  turns.value = [
    {
      ...base,
      id: 'file-result-segment',
      segmentIndex: 2,
      items: [
        {
          id: 'result-command',
          kind: 'command_execution',
          status: 'COMPLETED',
          processGroup: { id: 'result-process' },
          payload: { command: 'verify changes', outputPreview: 'Verified' }
        },
        {
          id: 'result-change',
          kind: 'file_change',
          status: 'COMPLETED',
          processGroup: { id: 'result-process' },
          payload: {
            changes: [{ path: 'src/current.ts', change: 'MODIFIED', additions: 2, deletions: 1 }]
          }
        }
      ]
    },
    {
      ...base,
      id: 'file-result-reply',
      segmentIndex: 3,
      items: [
        {
          id: 'result-reply',
          kind: 'assistant_message',
          status: 'IN_PROGRESS',
          payload: { text: 'Working reply' }
        }
      ]
    }
  ];
}
function finishFileChangeResult() {
  previewRunStatus.value = 'SUCCEEDED';
  turns.value = turns.value.map((turn) => ({
    ...turn,
    status: 'SUCCEEDED',
    items: turn.items.map((item) =>
      item.id === 'result-reply'
        ? { ...item, status: 'COMPLETED', payload: { text: 'File-change result final reply' } }
        : item
    )
  }));
}
function backfillFileChangeResult() {
  turns.value = [
    {
      ...turns.value[0]!,
      id: 'file-result-prefix',
      segmentIndex: 1,
      items: [
        {
          id: 'older-result-change',
          kind: 'file_change',
          status: 'COMPLETED',
          processGroup: { id: 'result-process', isStart: true },
          payload: {
            changes: [{ path: 'src/older.ts', change: 'ADDED', additions: 3, deletions: 0 }]
          }
        }
      ]
    },
    ...turns.value
  ];
}
function startFileChangeNextRound() {
  previewRunStatus.value = 'RUNNING';
  turns.value = [
    ...turns.value,
    {
      ...turns.value.at(-1)!,
      id: 'file-result-next-round',
      turnId: 'file-result-next-round',
      runId: 'next-run',
      segmentIndex: 0,
      status: 'RUNNING',
      items: [
        {
          id: 'result-next-user',
          kind: 'user_message',
          status: 'COMPLETED',
          payload: { text: 'Next round request' }
        }
      ]
    }
  ];
}
if (historyActionsFixture) {
  localePreferenceService().setLocale(
    new URL(location.href).searchParams.get('language') === 'zh-CN' ? 'zh-CN' : 'en-US'
  );
  turns.value = [
    {
      ...turns.value[0]!,
      rewind: { before: null, after: 'turn' },
      items: [
        items[0]!,
        {
          id: 'reply',
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: { text: 'Fixture reply' }
        }
      ]
    }
  ];
}
if (new URL(location.href).searchParams.has('disclosure-reset')) {
  turns.value[0]!.items = ['first', 'second'].flatMap((groupId) =>
    [
      {
        id: 'reasoning',
        kind: 'reasoning',
        status: 'COMPLETED',
        payload: { sections: [{ text: 'Inspect the relevant files.' }] }
      } as ConversationItem,
      ...items.filter((item) => ['command', 'read', 'changes', 'child'].includes(item.id)),
      {
        id: 'tool',
        kind: 'tool_call',
        status: 'COMPLETED',
        payload: { toolName: 'inspect', outputSummary: 'Inspection result' }
      } as ConversationItem
    ].map((item, index) => ({
      ...item,
      id: `${groupId}-${item.id}`,
      processGroup: { id: groupId, ...(index === 0 ? { isStart: true as const } : {}) }
    }))
  );
}
if (readFilesFixture) {
  turns.value = [
    {
      ...turns.value[0]!,
      items: [
        {
          id: 'read-batch',
          kind: 'tool_call',
          status: 'COMPLETED',
          processGroup: { id: 'read-files-process', isStart: true },
          payload: {
            toolName: 'read',
            toolPresentation: {
              kind: 'READ',
              paths: ['src/a.ts', 'src/a.ts', 'test/a.ts', 'C:\\src\\b.ts', unicodeLongFilePath]
            },
            inputSummary: 'Original batch ranges: offset 2, limit 8',
            outputSummary: 'Original batch output'
          }
        },
        {
          id: 'read-repeated',
          kind: 'tool_call',
          status: 'FAILED',
          processGroup: { id: 'read-files-process' },
          payload: {
            toolName: 'Read',
            toolPresentation: { kind: 'READ', paths: ['src/a.ts'] },
            outputSummary: 'Original repeated read failure',
            errorCode: 'READ_FAILED'
          }
        },
        {
          id: 'read-pathless',
          kind: 'tool_call',
          status: 'FAILED',
          processGroup: { id: 'read-files-process' },
          payload: {
            toolName: 'read',
            toolPresentation: { kind: 'READ' },
            outputSummary: 'Original pathless read failure',
            errorCode: 'READ_FAILED'
          }
        }
      ]
    }
  ];
}

function appendReadFile() {
  turns.value = turns.value.map((turn) => ({
    ...turn,
    items: [
      ...turn.items,
      {
        id: 'read-appended',
        kind: 'tool_call',
        status: 'COMPLETED',
        processGroup: { id: 'read-files-process' },
        payload: {
          toolName: 'read',
          toolPresentation: { kind: 'READ', paths: ['src/appended.ts'] },
          outputSummary: 'Appended read output'
        }
      }
    ]
  }));
}

async function loadStressHistory() {
  initializing.value = true;
  renderVersion.value++;
  turns.value = [
    {
      id: 'stress-turn',
      sessionId: 'session',
      runId: 'finished-run',
      status: 'SUCCEEDED',
      items: Array.from({ length: 80 }, (_, index): ConversationItem => ({
        id: `stress-${index}`,
        kind: 'reasoning',
        status: 'COMPLETED',
        processGroup: { id: `stress-process-${index}`, isStart: true },
        payload: {
          representation: 'visible_thinking',
          sections: [
            { text: index % 20 === 0 ? `${'.'.repeat(64 * 1024)}x` : `Inspect file ${index}, next` }
          ]
        }
      }))
    }
  ];
  await nextTick();
  initializing.value = false;
}

function loadLifecycleHistory(sessionId = 'initial-session') {
  initializing.value = sessionId === 'initial-session';
  synchronized.value = false;
  if (initializing.value) renderVersion.value++;
  const groupId = `loading-process-${sessionId}`;
  const startedAt = Date.now() - 65_000;
  turns.value = [
    {
      id: `turn-${sessionId}`,
      sessionId,
      runId: 'run',
      status: 'RUNNING',
      items: [
        {
          id: `reasoning-${sessionId}`,
          kind: 'reasoning',
          status: 'COMPLETED',
          startedAt,
          processGroup: { id: groupId, isStart: true },
          payload: { representation: 'summary', sections: [{ text: 'Current public progress' }] }
        },
        ...Array.from({ length: 64 }, (_, index): ConversationItem => ({
          id: `command-${sessionId}-${index}`,
          kind: 'command_execution',
          status: 'COMPLETED',
          startedAt: startedAt + (index + 1) * 1_000,
          completedAt: startedAt + (index + 2) * 1_000,
          processGroup: { id: groupId },
          payload: {
            command: `echo ${sessionId}-${index}`,
            outputPreview: 'bounded output '.repeat(2_000)
          }
        }))
      ]
    }
  ];
}

function synchronizeLifecycleHistory() {
  synchronized.value = true;
  turns.value = turns.value.map((turn) => ({ ...turn, items: [...turn.items] }));
}

async function toggleTimeline() {
  if (timelineVisible.value) {
    timelineVisible.value = false;
    return;
  }
  initializing.value = true;
  timelineVisible.value = true;
  await nextTick();
  initializing.value = false;
}

function publishSummary() {
  const turn = turns.value[0]!;
  turns.value = [
    {
      ...turn,
      items: [
        ...turn.items,
        {
          id: 'summary',
          kind: 'reasoning',
          status: 'COMPLETED',
          processGroup: { id: 'preview-process' },
          payload: {
            representation: 'summary',
            sections: [{ text: '**Public summary: inspect files**\nFull summary detail' }]
          }
        }
      ]
    }
  ];
}

function finishPreview() {
  previewRunStatus.value = 'SUCCEEDED';
  turns.value = turns.value.map((turn) => ({
    ...turn,
    status: 'SUCCEEDED',
    items: [
      ...turn.items,
      {
        id: 'reply',
        kind: 'assistant_message',
        status: 'COMPLETED',
        payload: { text: 'Finished reviewing files.' }
      }
    ]
  }));
}

function announceFixtureUpdate() {
  notifications.notify({
    // Each viewport represents a separate update; real updates deduplicate across reloads.
    id: `preview-${window.innerWidth}`,
    kind: 'web-update',
    title: 'New version',
    message: 'Update available',
    version: '0.10.2',
    action: 'RELOAD_PAGE'
  });
}
</script>

<template>
  <main class="conversation-style-fixture">
    <button
      v-if="performanceFixture"
      data-testid="update-performance"
      @click="livePerformance = { runId: 'run', latencyMs: 420, tokensPerSecond: 42 }"
    >
      Update performance
    </button>
    <section
      v-if="!historyActionsFixture && !markdownBlocksFixture"
      aria-label="Notifications fixture"
    >
      <WorkbenchActivityCenter :service="notifications" :uploads="[]" :status-label="String" />
      <ThemePreview name="Fixture preview" :colors="previewColors" />
      <output data-testid="notification-loads">{{ notificationLoads }}</output>
      <button @click="announceFixtureUpdate">Preview notification</button>
    </section>
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
      <button
        class="mar-icon-button mar-icon-action"
        data-testid="native-utility"
        aria-label="Native icon action"
      >
        <MarIcon name="copy" />
      </button>
      <MarButton
        class="mar-icon-action"
        data-testid="mar-utility"
        text
        aria-label="MAR icon action"
        icon="copy"
      />
      <MarButton class="mar-icon-action" disabled text data-testid="disabled-utility"
        >Disabled utility</MarButton
      >
    </section>
    <ConversationHeader
      v-if="!markdownBlocksFixture"
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
    />
    <ConversationWorkProcess
      v-if="!markdownBlocksFixture"
      :block="{
        id: 'process',
        groupId: 'process',
        entries: [],
        active: true,
        status: processStopping ? 'stopping' : 'running',
        partial: false,
        sealed: false
      }"
      :synchronized="true"
      >Process content</ConversationWorkProcess
    >
    <ConversationTimeline
      v-if="timelineVisible"
      :turns="turns"
      @open-file="(path) => (resultOpenedFile = path)"
      :performance="livePerformance"
      :runs="
        fileChangeResultFixture
          ? [{ id: turns.at(-1)!.runId!, status: previewRunStatus }]
          : previewFixture || loadingFixture
            ? [{ id: 'run', status: previewRunStatus }]
            : []
      "
      :synchronized="synchronized"
      :loading="false"
      :initializing="initializing"
      :initial-render-version="renderVersion"
      :capture-render-anchor="captureRenderAnchor"
      :image-attachments="
        (_runId, payload) =>
          detailSurfaceFixture &&
          (payload as { toolCategory?: string }).toolCategory === 'IMAGE_GENERATION'
            ? [
                {
                  name: 'generated.svg',
                  previewUrl:
                    'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2216%22 height=%2216%22%3E%3Crect width=%2216%22 height=%2216%22 fill=%22green%22/%3E%3C/svg%3E'
                }
              ]
            : []
      "
      :user-input-questions="() => []"
      :user-input-answer="() => ''"
      :user-input-submitted="() => false"
      :node-ready="false"
      :rewind-enabled="historyActionsFixture"
      :rollback-enabled="historyActionsFixture"
      @initial-rendered="renderedVersion = $event"
    />
    <template v-if="loadingFixture">
      <button data-testid="load-lifecycle-history" @click="loadLifecycleHistory()">
        Load history
      </button>
      <button data-testid="finish-lifecycle-initial" @click="initializing = false">
        Reveal initial history
      </button>
      <button data-testid="switch-cached-history" @click="loadLifecycleHistory('cached-session')">
        Restore cached history
      </button>
      <button data-testid="synchronize-history" @click="synchronizeLifecycleHistory">
        Synchronize history
      </button>
      <button
        data-testid="omit-process-start"
        @click="turns = turns.map((turn) => ({ ...turn, items: turn.items.slice(1) }))"
      >
        Show incomplete history
      </button>
      <output data-testid="rendered-version">{{ renderedVersion }}</output>
    </template>
    <template v-if="readFilesFixture">
      <button data-testid="append-read-file" @click="appendReadFile">Append read</button>
      <button
        data-testid="read-files-chinese"
        @click="localePreferenceService().setLocale('zh-CN')"
      >
        Chinese
      </button>
    </template>
    <template v-if="stressFixture">
      <button data-testid="load-stress-history" @click="loadStressHistory">Load history</button>
      <button data-testid="toggle-stress-timeline" @click="toggleTimeline">Toggle timeline</button>
      <button
        data-testid="toggle-cached-stress-timeline"
        @click="timelineVisible = !timelineVisible"
      >
        Toggle cached timeline
      </button>
      <button
        data-testid="switch-stress-session"
        @click="turns = turns.map((turn) => ({ ...turn, sessionId: 'another-stress-session' }))"
      >
        Switch cached session
      </button>
    </template>
    <button v-if="previewFixture" data-testid="publish-reasoning-summary" @click="publishSummary">
      Publish summary
    </button>
    <button v-if="previewFixture" data-testid="finish-reasoning-process" @click="finishPreview">
      Finish process
    </button>
    <button
      v-if="!markdownBlocksFixture"
      data-testid="toggle-following"
      @click="following = !following"
    >
      Toggle following
    </button>
    <template v-if="markdownBlocksFixture">
      <button data-testid="markdown-chinese" @click="localePreferenceService().setLocale('zh-CN')">
        Chinese
      </button>
      <button data-testid="markdown-english" @click="localePreferenceService().setLocale('en-US')">
        English
      </button>
      <button data-testid="markdown-replace" @click="replaceMarkdownReply">Replace reply</button>
    </template>
    <template v-if="fileChangeResultFixture">
      <output data-testid="result-opened-file">{{ resultOpenedFile }}</output>
      <button data-testid="finish-file-result" @click="finishFileChangeResult">Finish round</button>
      <button data-testid="backfill-file-result" @click="backfillFileChangeResult">
        Load older segment
      </button>
      <button data-testid="next-file-result-round" @click="startFileChangeNextRound">
        Start next round
      </button>
    </template>
    <section v-if="!markdownBlocksFixture" class="scroll-sample">
      <ConversationScroll
        :has-older="false"
        :loading-initial="false"
        :initial-load-failed="false"
        :loading-older="false"
        :has-turns="true"
        :following="following"
      >
        <p class="scroll-sample-message">Latest message</p>
        <template #status
          ><SessionPerformanceInfo
            :performance="{ runId: 'run', latencyMs: 420, tokensPerSecond: 42 }"
        /></template>
      </ConversationScroll>
    </section>
    <ConversationComposer
      v-if="!readFilesFixture && !detailSurfaceFixture && !markdownBlocksFixture"
      v-model:input="input"
      placeholder="Message"
      :working="true"
      working-label="Working"
      :connection-label="reconnecting ? 'Reconnecting' : undefined"
      :connection-busy="reconnecting"
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
.scroll-sample-message {
  min-height: 260px;
}
</style>
