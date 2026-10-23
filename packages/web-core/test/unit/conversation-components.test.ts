import { readFileSync } from 'node:fs';
import {
  createRenderer,
  createSSRApp,
  defineComponent,
  h,
  nextTick,
  shallowRef,
  ssrContextKey,
  type Component
} from 'vue';
import { renderToString } from 'vue/server-renderer';
import { serializeComposerTag } from '@myagentroam/protocol';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n, localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import type { ConversationItem, ConversationTurn, Session } from '../../src/model/workbench.js';
import ConversationHeader from '../../src/view/conversation/ConversationHeader.vue';
import ConversationScroll from '../../src/view/conversation/ConversationScroll.vue';
import ConversationTimeline from '../../src/view/conversation/ConversationTimeline.vue';
import ConversationWorkProcess from '../../src/view/conversation/ConversationWorkProcess.vue';
import SessionPerformanceInfo from '../../src/view/conversation/SessionPerformanceInfo.vue';
import ImagePreviewDialogs from '../../src/view/conversation/ImagePreviewDialogs.vue';
import MessageAttachmentFiles from '../../src/view/composer/MessageAttachmentFiles.vue';
import { conversationWorkProcessBlocks } from '../../src/util/conversation-work-process.js';

// Node SSR cannot execute DOMPurify; this isolates Timeline branching from Markdown rendering.
vi.mock('../../src/view/common/AgentMarkdown.vue', () => ({
  default: {
    name: 'AgentMarkdownStub',
    props: { content: { type: String, required: true } },
    template: '<div class="agent-markdown-stub">{{ content }}</div>'
  }
}));

const originalLocale = localePreferenceService().locale.value;

describe('Message image attachment cards', () => {
  const image = {
    name: '原图 with spaces.png',
    mime: 'image/png',
    path: 'mar-attachment://00000000-0000-4000-8000-000000000001/原图 with spaces.png'
  };
  const text = {
    name: 'notes.txt',
    mime: 'text/plain',
    path: 'mar-attachment://00000000-0000-4000-8000-000000000002/notes.txt'
  };
  it('renders image thumbnails through the supplied resource URL and keeps other files as chips', async () => {
    const resource = vi.fn((path: string) => `/preview?${new URLSearchParams({ path })}`);
    const html = await render(MessageAttachmentFiles, {
      files: [image, text],
      imageResourceUrl: resource
    });
    expect(html).toContain('conversation-user-image');
    expect(html).toContain(
      `alt="${i18n.global.t('generated.conversationTimeline.imageAttachment')}"`
    );
    expect(html).not.toContain(image.name);
    expect(html).toContain('/preview?path=mar-attachment');
    expect(html).toContain('conversation-file-chip');
    expect(html).toContain('notes.txt');
    expect(resource).toHaveBeenCalledTimes(1);
    expect(resource).toHaveBeenCalledWith(image.path);
  });
  it('keeps a filename-free image placeholder when no resource resolver is available', async () => {
    const html = await render(MessageAttachmentFiles, { files: [image] });
    expect(html).not.toContain('<img');
    expect(html).not.toContain(image.name);
    expect(html).not.toContain('title=');
    expect(html).toContain('conversation-image-fallback');
    expect(html).toContain('conversation-file-attachment');
  });
});

const DialogStub = defineComponent({
  name: 'ElDialog',
  props: {
    modelValue: Boolean,
    title: String
  },
  setup(props, { slots }) {
    return () =>
      props.modelValue
        ? h('section', { 'data-dialog-title': props.title ?? '' }, slots.default?.())
        : null;
  }
});

async function render(
  component: Component,
  props: Record<string, unknown>,
  slots?: Record<string, () => ReturnType<typeof h>>
): Promise<string> {
  const app = createSSRApp({ render: () => h(component, props, slots) });
  app.use(i18n);
  if (component === ImagePreviewDialogs) app.component('ElDialog', DialogStub);
  else app.use(ElementPlus);
  app.provide(ID_INJECTION_KEY, { prefix: 600, current: 0 });
  app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
  return renderToString(app);
}

function conversationItem(
  id: string,
  kind: string,
  payload: unknown,
  status = 'COMPLETED'
): ConversationItem {
  const itemPayload =
    kind === 'reasoning' &&
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload)
      ? { representation: 'unspecified', ...payload }
      : payload;
  return { id, kind, payload: itemPayload, status };
}

function conversationTurn(
  items: readonly ConversationItem[],
  overrides: Partial<ConversationTurn> = {}
): ConversationTurn {
  return {
    id: 'turn-1',
    sessionId: 'session-1',
    runId: 'run-1',
    status: 'SUCCEEDED',
    items,
    ...overrides
  };
}

const timelineProps = {
  turns: [] as readonly ConversationTurn[],
  workspaceRoot: undefined,
  loading: false,
  initializing: false,
  initialRenderVersion: 0,
  imageAttachments: () => [],
  userInputQuestions: () => [],
  userInputAnswer: () => '',
  userInputSubmitted: () => false,
  planContinuation: undefined,
  nodeReady: false,
  rewindEnabled: false,
  rollbackEnabled: false
};

it.each(['zh-CN', 'en-US'] as const)(
  'renders four independent tool presentations with collapsed details in %s',
  async (locale) => {
    localePreferenceService().setLocale(locale);
    const facts = [
      {
        kind: 'WEB_SEARCH',
        query: 'Original query',
        sourceCount: 1,
        sources: [
          { title: 'Original title', url: 'https://example.com/page', snippet: '<plain summary>' }
        ]
      },
      {
        kind: 'WEB_FETCH',
        requestUrl: 'https://request.example/',
        url: 'https://final.example/',
        title: 'Original page',
        mode: 'http'
      },
      { kind: 'SKILL', name: 'original-skill' },
      { kind: 'SLEEP', durationMs: 1800000, elapsedMs: 192000, wakeReason: 'subagent_message' }
    ];
    const items = facts.map((toolPresentation, index) =>
      conversationItem(`tool-${index}`, 'tool_call', {
        toolName: `native-${index}`,
        toolPresentation,
        inputSummary: 'Original input',
        outputSummary: 'Original output'
      })
    );
    items.push(
      conversationItem(
        'sleep-waiting',
        'tool_call',
        {
          toolName: 'sleep',
          toolPresentation: {
            kind: 'SLEEP',
            durationMs: 1800000,
            startedAt: new Date(2026, 9, 20, 14, 5).toISOString()
          }
        },
        'IN_PROGRESS'
      )
    );
    const html = await render(ConversationTimeline, {
      ...timelineProps,
      turns: [conversationTurn(items)]
    });
    expect(html.match(/data-tool-presentation=/g)).toHaveLength(5);
    expect(html).toMatch(
      new RegExp(
        '<span[^>]*>' +
          (locale === 'zh-CN' ? '30 分钟 · 预计至 14:35' : '30 min · until about 14:35') +
          '</span>'
      )
    );
    expect(html).not.toContain('data-group-type="tool_group"');
    expect(html).toContain(locale === 'zh-CN' ? '网页搜索' : 'Web search');
    expect(html).toContain(locale === 'zh-CN' ? '已等待 3 分钟 12 秒' : 'Waited 3 min 12 sec');
    expect(html).toContain('href="https://example.com/page"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('example.com');
    expect(html).toContain('&lt;plain summary&gt;');
    expect(html).not.toContain('<plain summary>');
    expect(html).not.toMatch(/<details[^>]*class="conversation-tool-presentation"[^>]*open/);
  }
);

it('renders ask and deny stops as unexecuted without vendor approval actions', async () => {
  localePreferenceService().setLocale('en-US');
  for (const action of ['ask', 'deny'] as const) {
    const blocked = {
      ...conversationItem(`stop-${action}`, 'tool_call', {}),
      permissionStop: {
        action,
        reason: 'The shared target needs a decision.',
        source: {
          sessionId: 'session',
          executionId: 'execution',
          callId: 'call',
          toolName: 'effect'
        }
      }
    };
    const html = await render(ConversationTimeline, {
      ...timelineProps,
      turns: [conversationTurn([blocked])]
    });
    expect(html).toContain('Not executed');
    expect(html).toContain(blocked.permissionStop.reason);
    expect(html.includes('No live approval channel')).toBe(action === 'ask');
    expect(html).not.toContain('approval.respond');
  }
});

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal('document', {
    documentElement: {
      lang: '',
      classList: { add: vi.fn(), remove: vi.fn() },
      setAttribute: vi.fn(),
      removeAttribute: vi.fn()
    }
  });
});

afterEach(() => {
  localePreferenceService().setLocale(originalLocale);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe.each(['zh-CN', 'en-US'] as const)('public Conversation components (%s)', (locale) => {
  beforeEach(() => localePreferenceService().setLocale(locale));

  it.each([true, false])('renders channel attribution for share view: %s', async (shared) => {
    const channel = serializeComposerTag('mar_channel', {
      source: 'WEB_SHARE',
      channelId: 'share-one',
      senderId: 'visitor-one',
      name: 'Alice'
    });
    const html = await render(ConversationTimeline, {
      ...timelineProps,
      ...(shared ? { sharerName: 'Owner' } : {}),
      turns: [
        conversationTurn([
          conversationItem('visitor-message', 'user_message', { text: channel + 'Hello' })
        ])
      ]
    });
    const title = i18n.global.t('generated.conversationPresentation.messageFromSource', {
      name: 'Alice'
    });
    expect(html).toMatch(new RegExp('<strong[^>]*>' + title + '</strong>'));
    expect(html).toContain('Hello');
    expect(html).not.toContain('mar_channel');
    expect(html).toContain(
      'title="' + i18n.global.t('generated.conversationPresentation.webShareSourceDetails') + '"'
    );
    expect(html).not.toContain('channel-origin');
    expect(html).not.toContain('Owner');
    expect(html).not.toContain('share-one');
    expect(html).not.toContain('visitor-one');
  });

  it.each([true, false])(
    'renders stored session-origin snapshots without interpreting names or exposing tags (shared: %s)',
    async (shared) => {
      const sessionId = 'source-session-42';
      const historicalName = 'Reviewer <img src=x onerror=alert(1)>';
      const renamedSession = 'Reviewer after rename';
      const sessionOrigin = serializeComposerTag('mar_session_origin', {
        sessionId,
        name: historicalName
      });
      const steeredOrigin = serializeComposerTag('mar_session_origin', {
        sessionId: 'steer-session-7',
        name: 'Steering Agent'
      });
      const steer = serializeComposerTag('mar_steer', { message: 'Focus on the resume path.' });
      const attachments = serializeComposerTag('mar_attachments', {
        files: [
          {
            name: 'review-notes.txt',
            path: '.mar/temp-files/input/review-notes.txt',
            mime: 'text/plain'
          }
        ]
      });
      const html = await render(ConversationTimeline, {
        ...timelineProps,
        ...(shared ? { sharerName: 'Owner' } : {}),
        turns: [
          conversationTurn([
            conversationItem('normal-origin', 'user_message', {
              text: `Review the patch.\n${sessionOrigin}\n${attachments}`
            }),
            conversationItem('steer-origin', 'user_message', {
              text: `${steer}\n${steeredOrigin}`
            }),
            conversationItem('marctl-origin', 'user_message', {
              text: `Terminal input\n${serializeComposerTag('mar_session_origin', {})}`
            }),
            conversationItem('plain-input', 'user_message', { text: 'Unmarked input' })
          ])
        ]
      });

      const historicalLabel = i18n.global.t(
        'generated.conversationPresentation.messageFromSource',
        {
          name: historicalName
        }
      );
      expect(html).toContain(historicalLabel.replace('<', '&lt;').replace('>', '&gt;'));
      expect(html).not.toContain('<img src=x onerror=alert(1)>');
      expect(html).not.toContain(renamedSession);
      expect(html).toContain(
        `title="${i18n.global.t('generated.conversationPresentation.sessionSourceDetails', {
          sessionId
        })}"`
      );
      expect(html).toContain(
        i18n.global.t('generated.conversationPresentation.messageFromSource', {
          name: 'Steering Agent'
        })
      );
      expect(html).toContain(i18n.global.t('generated.conversationPresentation.messageFromMarctl'));
      expect(html).toContain('Review the patch.');
      expect(html).toContain('Focus on the resume path.');
      expect(html).toContain('review-notes.txt');
      expect(html).toContain('Terminal input');
      expect(html).toContain('Unmarked input');
      expect(html).not.toContain('mar_session_origin');
      expect(html).not.toContain('mar_steer');
      expect(html).not.toContain('channel-origin');
      const terminalHeading = Array.from(
        html.matchAll(new RegExp('<strong([^>]*)>([^<]*)</strong>', 'gu'))
      ).find(
        (heading) =>
          heading[2] === i18n.global.t('generated.conversationPresentation.messageFromMarctl')
      );
      expect(terminalHeading).toBeDefined();
      expect(terminalHeading?.[1]).not.toContain('title=');
    }
  );

  it('uses the sharer name for original messages in a shared conversation', async () => {
    const html = await render(ConversationTimeline, {
      ...timelineProps,
      sharerName: 'Owner',
      turns: [
        conversationTurn([
          conversationItem('owner-message', 'user_message', { text: 'Original input' })
        ])
      ]
    });
    expect(html).toMatch(new RegExp('<strong[^>]*>Owner</strong>'));
    expect(html).not.toContain('channel-origin');
  });

  it('renders individual subagent operations with persistent call errors and no running badge', async () => {
    const control = (id: string, operation: string, status = 'COMPLETED') => ({
      ...conversationItem(
        id,
        'tool_call',
        {
          subagentId: 'child',
          subagentOperation: operation,
          title: 'Review integration',
          toolName: `control-${id}`,
          inputSummary: id
        },
        status
      ),
      processGroup: { id: 'process-child', ...(id === 'start' ? { isStart: true as const } : {}) }
    });
    const html = await render(ConversationTimeline, {
      ...timelineProps,
      turns: [
        conversationTurn([
          control('start', 'START', 'IN_PROGRESS'),
          control('failed', 'STATUS', 'FAILED'),
          control('message', 'MESSAGE')
        ])
      ]
    });
    expect(html.match(/class="[^"]*subagent-group/gu)).toHaveLength(3);
    for (const operation of ['START', 'STATUS', 'MESSAGE'])
      expect(html).toContain(
        `Review integration · ${i18n.global.t(`presentation.subagentOperation.${operation}`)}`
      );
    expect(html).toContain(i18n.global.t('presentation.subagentOperationCount', { count: 1 }));
    expect(html).not.toContain(i18n.global.t('presentation.subagentOperationCount', { count: 3 }));
    expect(html).toContain(i18n.global.t('presentation.subagentCallFailed'));
    expect(html).not.toContain(i18n.global.t('generated.conversationPresentation.running'));
    expect(html).not.toContain('conversation-tool-detail');
    const separate = await render(ConversationTimeline, {
      ...timelineProps,
      turns: [
        conversationTurn([control('start', 'START')], { id: 'segment-1' }),
        conversationTurn([control('message', 'MESSAGE')], { id: 'segment-2' })
      ]
    });
    expect(separate.match(/class="[^"]*subagent-group/gu)).toHaveLength(2);
  });

  it('resolves every fixed view message from the public bilingual catalog', () => {
    const sources = [
      'ConversationHeader.vue',
      'ConversationScroll.vue',
      'ConversationTimeline.vue',
      'ConversationWorkProcess.vue',
      'ImagePreviewDialogs.vue'
    ].map((name) =>
      readFileSync(new URL(`../../src/view/conversation/${name}`, import.meta.url), 'utf8')
    );
    const keys = [
      ...new Set(
        sources.flatMap((source) =>
          [
            ...source.matchAll(
              /'((?:generated|presentation|nodeMessages|conversationProcess|conversationActivity)\.[\w.-]+)'/gu
            )
          ].map((match) => match[1]!)
        )
      )
    ];

    expect(keys.length).toBeGreaterThan(30);
    for (const key of keys) expect(i18n.global.te(key, locale), key).toBe(true);
  });

  it('keeps compacted-context and task-list heading details as muted as collapsible summaries', async () => {
    const html = await render(ConversationTimeline, {
      ...timelineProps,
      turns: [
        conversationTurn([
          conversationItem('compaction-1', 'context_compaction', {}, 'COMPLETED'),
          conversationItem('task-list-1', 'todo_list', {
            items: [{ text: 'Check the result', status: 'PENDING' }]
          })
        ])
      ]
    });
    const source = readFileSync(
      new URL('../../src/view/conversation/ConversationTimeline.vue', import.meta.url),
      'utf8'
    );
    expect(html).toMatch(
      /class="conversation-item-heading"[^>]*><strong[^>]*>[^<]+<\/strong><span[^>]*>/u
    );
    expect(html).toContain('class="task-list-heading"');
    expect(source).toMatch(
      /\.conversation-item > details > summary > span,\s*\.conversation-reasoning-status > span,\s*\.conversation-item-heading > span,\s*\.task-list-heading > span\s*\{\s*color:\s*var\(--mar-conversation-muted\);/u
    );
  });

  it('renders background, waiting, and completed compaction states without exposing a summary', async () => {
    const html = await render(ConversationTimeline, {
      ...timelineProps,
      turns: [
        conversationTurn([
          conversationItem(
            'compact-background',
            'context_compaction',
            { phase: 'STARTED', summary: null, mode: 'BACKGROUND', stage: 'GENERATING' },
            'IN_PROGRESS'
          ),
          conversationItem(
            'compact-waiting',
            'context_compaction',
            { phase: 'STARTED', summary: null, mode: 'BACKGROUND', stage: 'WAITING' },
            'IN_PROGRESS'
          ),
          conversationItem(
            'compact-completed',
            'context_compaction',
            { phase: 'COMPLETED', summary: null, mode: 'BACKGROUND', retainedContext: true },
            'COMPLETED'
          )
        ])
      ]
    });
    expect(html).toContain(
      i18n.global.t('generated.conversationPresentation.contextCompactionBackground')
    );
    expect(html).toContain(
      i18n.global.t('generated.conversationPresentation.contextCompactionWaiting')
    );
    expect(html).toContain(i18n.global.t('nodeMessages.contextCompacted'));
    expect(html).not.toContain('private handoff summary');
  });

  it('renders a draft header with the selected runner and every available mobile capability', async () => {
    const draft: Session = {
      id: 'draft:session-1',
      workspaceId: 'workspace-1',
      runner: 'mar-agent'
    };
    const html = await render(ConversationHeader, {
      session: draft,
      runner: 'codex',
      filesReady: true,
      terminalReady: true,
      contentSearchReady: false,
      runnerIcon: (runner: string) => `/icons/${runner}.svg`,
      sessionTitle: () => 'must not render for draft',
      activity: () => 'IDLE',
      activityLabel: () => 'Ready'
    });

    expect(html).toContain('conversation-header-draft');
    expect(html).toContain('data-runner="mar-agent"');
    expect(html).toContain(i18n.global.t('generated.conversationHeader.newSession'));
    expect(html).toContain(i18n.global.t('generated.conversationHeader.sessions'));
    expect(html).toContain(i18n.global.t('generated.conversationHeader.files'));
    expect(html).toContain(i18n.global.t('generated.conversationHeader.terminal'));
    expect(html).not.toContain('must not render for draft');
    expect(html).not.toContain('conversation-session-id');
  });

  it('renders a native session title and only the capability buttons supplied by its host', async () => {
    const session: Session = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex',
      externalSessionId: 'native-session-1'
    };
    const html = await render(ConversationHeader, {
      session,
      runner: 'mar-agent',
      filesReady: false,
      terminalReady: false,
      contentSearchReady: true,
      runnerIcon: (runner: string) => `/icons/${runner}.svg`,
      sessionTitle: () => 'Original session title',
      activity: () => 'MANAGED_ACTIVE',
      activityLabel: () => 'Original activity'
    });

    expect(html).toContain('Original session title');
    expect(html).toMatch(/<code(?:\s[^>]*)?>session-1<\/code>/u);
    expect(html).toContain('aria-label="Original activity"');
    expect(html).toContain('title="Original activity"');
    expect(html).toContain(
      `aria-label="${i18n.global.t('generated.conversationHeader.copySessionId', {
        sessionId: 'session-1'
      })}"`
    );
    expect(html).toContain(i18n.global.t('generated.conversationHeader.sessions'));
    expect(html).not.toContain(i18n.global.t('generated.conversationHeader.files'));
    expect(html).not.toContain(i18n.global.t('generated.conversationHeader.terminal'));
  });

  it('only renders an activity indicator for a managed active session', async () => {
    const session: Session = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex',
      externalSessionId: 'native-session-1'
    };
    const props = {
      session,
      runner: 'mar-agent',
      filesReady: false,
      terminalReady: false,
      contentSearchReady: false,
      runnerIcon: (runner: string) => `/icons/${runner}.svg`,
      sessionTitle: () => 'Session title',
      activityLabel: () => 'Session activity'
    };

    const managed = await render(ConversationHeader, {
      ...props,
      activity: () => 'MANAGED_ACTIVE'
    });
    const idle = await render(ConversationHeader, {
      ...props,
      activity: () => 'IDLE'
    });

    expect(managed).toContain('session-activity managed_active');
    expect(managed).toContain('title="Session activity"');
    expect(idle).not.toContain('session-activity');
  });

  it('uses a pointer cursor while retaining copy affordance for the session ID', () => {
    const source = readFileSync(
      new URL('../../src/view/conversation/ConversationHeader.vue', import.meta.url),
      'utf8'
    );
    expect(source).toContain('.conversation-session-id button {\n  display: inline-flex;');
    expect(source).toContain('cursor: pointer;');
    expect(source).not.toContain('cursor: copy;');
    expect(source).toContain('.conversation-session-id button:hover code');
    expect(source).toContain('color: var(--mar-color-brand-text);');
  });

  it('renders initial history loading and retry states without exposing older-history controls', async () => {
    const loading = await render(ConversationScroll, {
      hasOlder: true,
      loadingInitial: true,
      initialLoadFailed: true,
      loadingOlder: false,
      hasTurns: true,
      following: true
    });
    const failed = await render(ConversationScroll, {
      hasOlder: true,
      loadingInitial: false,
      initialLoadFailed: true,
      loadingOlder: false,
      hasTurns: true,
      following: true
    });

    expect(loading).toContain(
      i18n.global.t('generated.conversationScroll.loadingConversationHistory')
    );
    expect(loading).not.toContain(
      i18n.global.t('generated.conversationScroll.loadEarlierMessages')
    );
    expect(failed).toContain(
      i18n.global.t('generated.conversationScroll.reloadConversationHistory')
    );
    expect(failed).not.toContain(i18n.global.t('generated.conversationScroll.loadEarlierMessages'));
  });

  it('keeps earlier-history loading and latest-follow controls independently gated', async () => {
    const loadingOlder = await render(ConversationScroll, {
      hasOlder: true,
      loadingInitial: false,
      initialLoadFailed: false,
      loadingOlder: true,
      hasTurns: true,
      following: false
    });
    const following = await render(ConversationScroll, {
      hasOlder: false,
      loadingInitial: false,
      initialLoadFailed: false,
      loadingOlder: false,
      hasTurns: true,
      following: true
    });

    expect(loadingOlder).toContain(
      i18n.global.t('generated.conversationScroll.loadingEarlierMessages')
    );
    expect(loadingOlder).toContain('busy-indicator');
    expect(loadingOlder).not.toMatch(
      /<button(?=[^>]*class="[^"]*\bconversation-load-older\b)[^>]*>/u
    );
    expect(loadingOlder).toContain(i18n.global.t('generated.conversationScroll.jumpToLatest'));
    expect(loadingOlder).toMatch(
      /<button(?=[^>]*class="[^"]*\bel-button\b)(?=[^>]*class="[^"]*\bis-round\b)(?=[^>]*class="[^"]*\bconversation-latest\b)[^>]*>/u
    );
    expect(following).not.toContain(i18n.global.t('generated.conversationScroll.jumpToLatest'));
    expect(following).toContain(i18n.global.t('conversationActivity.historyStart'));
  });

  it('renders older-page retry inline without confusing it with initial loading', async () => {
    const html = await render(ConversationScroll, {
      hasOlder: true,
      loadingInitial: false,
      initialLoadFailed: false,
      loadingOlder: false,
      hasTurns: true,
      following: false,
      olderError: 'PAGE_FAILED <details>'
    });
    expect(html).toContain('PAGE_FAILED &lt;details&gt;');
    expect(html).toContain(i18n.global.t('conversationActivity.retry'));
    expect(html).not.toContain(
      i18n.global.t('generated.conversationScroll.reloadConversationHistory')
    );
    expect(html).not.toContain(i18n.global.t('conversationActivity.historyStart'));
  });

  it('renders the completed Run duration once at its last segment and never guesses historical time', async () => {
    const turns = ['first', 'last'].map((id) =>
      conversationTurn([conversationItem(id, 'assistant_message', { text: id })], {
        id,
        runId: 'run',
        status: 'SUCCEEDED'
      })
    );
    const html = await render(ConversationTimeline, {
      ...timelineProps,
      turns,
      runs: [{ id: 'run', status: 'SUCCEEDED', startedAt: 1_000, completedAt: 21_000 }]
    });
    expect(html.match(/class="conversation-run-duration"/gu)).toHaveLength(1);
    expect(html).toContain(i18n.global.t('conversationActivity.total', { value: '20s' }));
    const historical = await render(ConversationTimeline, { ...timelineProps, turns });
    expect(historical).not.toContain('class="conversation-run-duration"');
  });

  it('leaves the jump-to-latest highlight to Element Plus', () => {
    const source = readFileSync(
      new URL('../../src/view/conversation/ConversationScroll.vue', import.meta.url),
      'utf8'
    );
    expect(source).not.toContain('.conversation-latest:hover');
    expect(source).not.toContain('background: var(--mar-fill-hover);');
  });

  it('uses a standard link button only when earlier history and displayed turns exist', async () => {
    const props = {
      hasOlder: true,
      loadingInitial: false,
      initialLoadFailed: false,
      loadingOlder: false,
      hasTurns: true,
      following: true
    };
    const html = await render(ConversationScroll, props);
    expect(html).toMatch(
      /<button(?=[^>]*class="[^"]*\bel-button\b)(?=[^>]*class="[^"]*\bis-link\b)(?=[^>]*class="[^"]*\bconversation-load-older\b)[^>]*>/u
    );
    for (const state of [{ hasOlder: false }, { hasTurns: false }]) {
      const hidden = await render(ConversationScroll, { ...props, ...state });
      expect(hidden).not.toContain(
        i18n.global.t('generated.conversationScroll.loadEarlierMessages')
      );
    }
  });

  it('moves session status above the jump-to-latest control when both are visible', async () => {
    const props = {
      hasOlder: false,
      loadingInitial: false,
      initialLoadFailed: false,
      loadingOlder: false,
      hasTurns: true
    };
    const statusSlot = { status: () => h('span', 'status') };
    const withLatest = await render(ConversationScroll, { ...props, following: false }, statusSlot);
    const following = await render(ConversationScroll, { ...props, following: true }, statusSlot);
    const scrollSource = readFileSync(
      new URL('../../src/view/conversation/ConversationScroll.vue', import.meta.url),
      'utf8'
    );
    const statusSource = readFileSync(
      new URL('../../src/view/conversation/SessionPerformanceInfo.vue', import.meta.url),
      'utf8'
    );
    expect(withLatest).toMatch(
      /class="(?=[^"]*\bconversation-status\b)(?=[^"]*\bhas-latest\b)[^"]*"/u
    );
    expect(following).toContain('class="conversation-status"');
    expect(following).not.toContain('conversation-status has-latest');
    expect(scrollSource).toContain(
      'bottom: calc(0.75rem + var(--mar-utility-control-size) + 0.5rem);'
    );
    expect(scrollSource).not.toContain('.conversation-latest.has-status');
    expect(statusSource).not.toContain('position: absolute;');
  });

  it('renders an error card with the Node error code, HTTP status and safe message', async () => {
    const html = await render(ConversationTimeline, {
      ...timelineProps,
      turns: [
        conversationTurn([
          conversationItem(
            'error-1',
            'error',
            {
              code: 'RUNNER_FAILED',
              httpStatus: 502,
              message: 'The upstream runner rejected the request.'
            },
            'FAILED'
          )
        ])
      ]
    });

    expect(html).toContain(i18n.global.t('generated.conversationPresentation.error'));
    expect(html).toContain(
      i18n.global.t('generated.conversationPresentation.httpStatus', { value0: 502 })
    );
    expect(html).toContain('RUNNER_FAILED');
    expect(html).toContain('The upstream runner rejected the request.');
  });

  it('shows plain-text ChatGPT usage guidance only for the precise limit code', async () => {
    for (const code of [
      'subscription_sharing_usage_limit_exceeded',
      'rate_limit_error',
      'subscription_sharing_user_not_eligible',
      ''
    ]) {
      const html = await render(ConversationTimeline, {
        ...timelineProps,
        turns: [
          conversationTurn([
            conversationItem(
              'usage-error',
              'error',
              {
                code,
                httpStatus: 429,
                message: 'subscription_sharing_usage_limit_exceeded: upstream diagnostic'
              },
              'FAILED'
            )
          ])
        ]
      });
      expect(html).toContain('upstream diagnostic');
      expect(html).not.toContain('href="https://chatgpt.com/settings/usage"');
      expect(html).not.toContain('el-button--primary');
      if (code === 'subscription_sharing_usage_limit_exceeded') {
        expect(html).toContain('https://chatgpt.com/settings/usage');
        expect(html).toContain(
          locale === 'zh-CN' ? '请打开' : 'Open https://chatgpt.com/settings/usage'
        );
        expect(html).toContain(code);
      } else {
        expect(html).not.toContain('https://chatgpt.com/settings/usage');
      }
    }
  });

  it('aligns user and assistant copy controls with the standard icon buttons', async () => {
    const html = await render(ConversationTimeline, {
      ...timelineProps,
      turns: [
        conversationTurn([
          conversationItem('user-1', 'user_message', { text: 'User text' }),
          conversationItem('assistant-1', 'assistant_message', { text: 'Assistant text' })
        ])
      ]
    });

    expect(
      html.match(/class="conversation-message-action icon-button utility-control"/gu)
    ).toHaveLength(2);
    expect(html).toContain(
      `title="${i18n.global.t('generated.conversationTimeline.copyMessage2')}"`
    );
  });

  it('removes legacy performance from assistant cards and exposes independent session metrics', async () => {
    const messages = await render(ConversationTimeline, {
      ...timelineProps,
      turns: [
        conversationTurn([
          conversationItem('assistant', 'assistant_message', {
            text: 'Assistant text',
            performance: { latencyMs: 420, tokensPerSecond: 42 }
          })
        ])
      ]
    });
    expect(messages).not.toContain('conversation-message-performance');
    expect(messages).not.toContain('420 ms');
    expect(messages).not.toContain('42.0 token/s');
    const info = await render(SessionPerformanceInfo, {
      performance: { runId: 'run', latencyMs: 420, tokensPerSecond: 42 }
    });
    const infoSource = readFileSync(
      new URL('../../src/view/conversation/SessionPerformanceInfo.vue', import.meta.url),
      'utf8'
    );
    expect(info).toContain('session-performance-info');
    expect(info).toContain('420 ms');
    expect(info).toContain('42.0 token/s');
    expect(info).toContain(
      i18n.global.t('generated.conversationTimeline.providerOutputTps', { value: '42.0' })
    );
    expect(info).not.toContain('Output tokens');
    expect(infoSource).toContain('border: 0;');
    expect(infoSource).toContain('background: transparent;');
    expect(infoSource).not.toContain('background: var(--mar-bg-panel);');
    expect(infoSource).toContain('font-size: 16px;');
    expect(infoSource).not.toContain('ttftMs');
    for (const performance of [
      { runId: 'run', latencyMs: 0 },
      { runId: 'run', tokensPerSecond: 0 }
    ])
      expect(await render(SessionPerformanceInfo, { performance })).toContain(
        'session-performance-info'
      );
    expect(await render(SessionPerformanceInfo, { performance: undefined })).not.toContain(
      'session-performance-info'
    );
  });

  it('cancels the previous workspace render batch before restoring a cached conversation', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    class HostNode {
      constructor(readonly type: string) {}
      closest() {
        return null;
      }
    }
    const renderer = createRenderer<HostNode, HostNode>({
      patchProp() {},
      insert() {},
      remove() {},
      createElement: (type) => new HostNode(type),
      createText: () => new HostNode('#text'),
      createComment: () => new HostNode('#comment'),
      setText() {},
      setElementText() {},
      parentNode: () => null,
      nextSibling: () => null
    });
    const turns = (sessionId: string) => [
      conversationTurn(
        Array.from({ length: 100 }, (_, index) =>
          conversationItem(`${sessionId}-${index}`, 'assistant_message', {
            text: 'x'.repeat(32 * 1024)
          })
        ),
        { id: sessionId, sessionId }
      )
    ];
    const props = shallowRef({ ...timelineProps, initializing: true, turns: turns('first') });
    let setupState: Record<string, unknown> | undefined;
    const app = renderer.createApp({
      render: () =>
        h(ConversationTimeline, {
          ...props.value,
          onVnodeMounted: (vnode) => {
            setupState = (vnode.component as unknown as { setupState: Record<string, unknown> })
              .setupState;
          }
        })
    });
    app.use(i18n);
    app.provide(ssrContextKey, { modules: new Set<string>() });
    app.component('ElIcon', { template: '<span><slot /></span>' });
    app.config.warnHandler = () => {};
    app.mount(new HostNode('container'));
    try {
      expect(setupState?.['renderedItemCount']).toBe(1);
      props.value = { ...props.value, initializing: false };
      await nextTick();
      expect(frames.size).toBe(1);
      const [firstFrameId, firstFrame] = [...frames.entries()][0]!;
      frames.delete(firstFrameId);
      const rendering = firstFrame(0);
      // A live snapshot can arrive while the batch is waiting for Vue's DOM flush.
      props.value = { ...props.value, turns: turns('first') };
      await rendering;
      await nextTick();
      expect(setupState?.['renderedItemCount']).toBe(9);
      const staleFrame = [...frames.values()][0]!;
      props.value = { ...props.value, initializing: true, turns: turns('second') };
      await nextTick();
      expect(setupState?.['renderedItemCount']).toBe(1);
      // Even an already-dispatched callback must not expand the new workspace's window.
      await staleFrame(0);
      await nextTick();
      expect(setupState?.['renderedItemCount']).toBe(1);
      expect(frames.size).toBe(0);
      props.value = { ...props.value, initializing: false };
      await nextTick();
      for (let batch = 0; batch < 20 && frames.size > 0; batch += 1) {
        const [id, callback] = [...frames.entries()][0]!;
        frames.delete(id);
        await callback(0);
        await nextTick();
      }
      expect(setupState?.['renderedItemCount']).toBe(100);
      expect(frames.size).toBe(0);
    } finally {
      app.unmount();
    }
  });

  it('shows a check only after copying succeeds and resets it after 500ms', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    class HostNode {
      constructor(readonly type: string) {}
    }
    const renderer = createRenderer<HostNode, HostNode>({
      patchProp() {},
      insert() {},
      remove() {},
      createElement: (type) => new HostNode(type),
      createText: () => new HostNode('#text'),
      createComment: () => new HostNode('#comment'),
      setText() {},
      setElementText() {},
      parentNode: () => null,
      nextSibling: () => null
    });
    const item = conversationItem('user-1', 'user_message', { text: 'Copied text' });
    let setupState: Record<string, unknown> | undefined;
    let copied: (() => void) | undefined;
    const app = renderer.createApp({
      render: () =>
        h(ConversationTimeline, {
          ...timelineProps,
          turns: [conversationTurn([item])],
          onCopy: (text: string, onSuccess: () => void) => {
            expect(text).toBe('Copied text');
            copied = onSuccess;
          },
          onVnodeMounted: (vnode) => {
            setupState = (
              vnode.component as unknown as { readonly setupState: Record<string, unknown> } | null
            )?.setupState;
          }
        })
    });
    app.use(i18n);
    app.provide(ssrContextKey, { modules: new Set<string>() });
    app.component('ElIcon', { template: '<span><slot /></span>' });
    app.config.warnHandler = () => {};
    app.mount(new HostNode('container'));
    try {
      const copyItem = setupState?.['copyItem'] as (
        turn: ConversationTurn,
        item: ConversationItem
      ) => void;
      const copiedMessage = () => setupState?.['copiedMessage'];
      copyItem(conversationTurn([item]), item);
      expect(copiedMessage()).toBeUndefined();
      copied?.();
      await nextTick();
      expect(copiedMessage()).toBe('turn-1:user-1');
      vi.advanceTimersByTime(499);
      expect(copiedMessage()).toBe('turn-1:user-1');
      vi.advanceTimersByTime(1);
      expect(copiedMessage()).toBeUndefined();
    } finally {
      app.unmount();
      vi.useRealTimers();
    }
  });

  it('renders authoritative process groups without collecting items by kind', async () => {
    const firstGroup = 'process-one';
    const secondGroup = 'process-two';
    const items = [
      {
        ...conversationItem('reasoning-1', 'reasoning', {
          representation: 'summary',
          sections: [{ text: 'First process reasoning marker' }]
        }),
        processGroup: { id: firstGroup, isStart: true as const }
      },
      {
        ...conversationItem('tool-1', 'tool_call', { toolName: 'First process tool marker' }),
        processGroup: { id: firstGroup }
      },
      {
        ...conversationItem('command-1', 'command_execution', {
          command: 'First process command marker'
        }),
        processGroup: { id: firstGroup }
      }
    ];
    const html = await render(ConversationTimeline, {
      ...timelineProps,
      synchronized: true,
      runs: [{ id: 'run-1', status: 'RUNNING' }],
      turns: [
        conversationTurn(items, {
          id: 'segment-1',
          turnId: 'turn-1',
          segmentIndex: 0,
          status: 'RUNNING'
        }),
        conversationTurn(
          [
            {
              ...conversationItem('reasoning-2', 'reasoning', {
                representation: 'visible_thinking',
                sections: [{ text: 'Second process marker' }]
              }),
              processGroup: { id: secondGroup, isStart: true as const }
            }
          ],
          { id: 'segment-2', turnId: 'turn-1', segmentIndex: 1, status: 'RUNNING' }
        )
      ]
    });

    expect(html.match(/class="process-heading"/gu)).toHaveLength(2);
    expect(html).toContain('data-process-id="process-one"');
    expect(html).toContain('data-process-id="process-two"');
    const markers = [
      'First process reasoning marker',
      'First process tool marker',
      'First process command marker',
      'Second process marker'
    ];
    const positions = markers.map((marker) => html.indexOf(marker));
    expect(markers.filter((_, index) => positions[index]! < 0)).toEqual([]);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('uses authoritative Run activity for process disclosure without warning aggregation', async () => {
    const groupId = 'process-live';
    const segment = conversationTurn(
      [
        {
          ...conversationItem(
            'tool-running',
            'tool_call',
            { toolName: 'Still running' },
            'IN_PROGRESS'
          ),
          processGroup: { id: groupId, isStart: true as const }
        },
        {
          ...conversationItem('warning-1', 'warning', { message: 'A visible warning' }),
          processGroup: { id: groupId }
        },
        conversationItem('assistant-reply', 'assistant_message', { text: 'The reply arrived.' })
      ],
      { status: 'SUCCEEDED' }
    );
    const active = conversationWorkProcessBlocks(
      [segment],
      [{ id: 'run-1', status: 'RUNNING' }]
    )[0]!;
    expect(active).toMatchObject({ sealed: true, active: true, status: 'executing' });
    const activeHtml = await render(
      ConversationWorkProcess,
      { block: active, synchronized: true, now: undefined },
      { default: () => h('span', 'Process details') }
    );
    expect(activeHtml).toMatch(/class="process-heading"[^>]*aria-expanded="true"/u);
    expect(activeHtml).toContain(
      i18n.global.t('conversationProcess.namedActivity', {
        activity: i18n.global.t('conversationProcess.activity.tool'),
        name: 'Still running'
      })
    );
    expect(activeHtml).toContain('process-activity-indicator');
    expect(activeHtml).toContain('busy-indicator');
    expect(activeHtml).not.toContain(i18n.global.t('conversationProcess.warning'));

    const disconnectedHtml = await render(ConversationWorkProcess, {
      block: active,
      synchronized: false,
      now: undefined
    });
    expect(disconnectedHtml).not.toContain('process-activity-indicator');

    const ended = conversationWorkProcessBlocks(
      [segment],
      [{ id: 'run-1', status: 'SUCCEEDED' }]
    )[0]!;
    expect(ended).toMatchObject({ sealed: true, active: false, status: 'completed' });
    const endedHtml = await render(
      ConversationWorkProcess,
      { block: ended, synchronized: true, now: undefined },
      { default: () => h('span', 'Process details') }
    );
    expect(endedHtml).toMatch(/class="process-heading"[^>]*aria-expanded="false"/u);
    expect(endedHtml).toContain('aria-hidden="true"');
    expect(endedHtml).not.toContain(i18n.global.t('conversationActivity.running'));
    expect(endedHtml).not.toContain('process-activity-indicator');

    const partial = conversationWorkProcessBlocks([
      conversationTurn(
        [
          {
            ...conversationItem('tool-partial', 'tool_call', { toolName: 'Loaded suffix' }),
            processGroup: { id: 'process-partial' }
          }
        ],
        { runId: null }
      )
    ])[0]!;
    const partialHtml = await render(
      ConversationWorkProcess,
      { block: partial, synchronized: false, now: undefined },
      { default: () => h('span', 'Partial details') }
    );
    expect(partial.partial).toBe(true);
    expect(partialHtml).toContain(i18n.global.t('conversationProcess.partial'));
    expect(partialHtml).not.toContain('process-activity-indicator');
  });

  it.each([
    ['command_execution', { command: 'echo test' }],
    ['tool_call', { toolName: 'lookup' }],
    ['tool_call', { toolName: 'read', toolPresentation: { kind: 'READ', paths: ['a.ts'] } }]
  ])('keeps a single %s record inside a persistent collapsed group (%j)', async (kind, payload) => {
    const html = await render(ConversationTimeline, {
      ...timelineProps,
      turns: [conversationTurn([conversationItem('single', kind as string, payload)])]
    });
    expect(html).toMatch(/<details class="conversation-record-group"[^>]*>/u);
    expect(html).not.toMatch(/<details class="conversation-record-group"[^>]*\bopen\b/u);
    expect(html).not.toContain('<div class="conversation-record-group"');
    expect(html).toContain(i18n.global.t('toolPresentation.calls', { count: 1 }));
  });

  it.each(['IN_PROGRESS', 'COMPLETED', 'FAILED'])(
    'keeps Node-assigned process IDs around a %s compaction item',
    async (status) => {
      const before = {
        ...conversationItem('reasoning-before', 'reasoning', {
          representation: 'summary',
          sections: [{ text: 'Before compact' }]
        }),
        processGroup: { id: 'process-before', isStart: true as const }
      };
      const compact = conversationItem(
        'compact',
        'context_compaction',
        { phase: status === 'COMPLETED' ? 'COMPLETED' : 'STARTED' },
        status
      );
      const after = {
        ...conversationItem('reasoning-after', 'reasoning', {
          representation: 'visible_thinking',
          sections: [{ text: 'After compact' }]
        }),
        processGroup: { id: 'process-after', isStart: true as const }
      };
      const html = await render(ConversationTimeline, {
        ...timelineProps,
        synchronized: true,
        runs: [{ id: 'run-1', status: 'RUNNING' }],
        turns: [conversationTurn([before, compact, after], { status: 'RUNNING' })]
      });

      expect(html).toContain('data-process-id="process-before"');
      expect(html).toContain('data-process-id="process-after"');
      expect(html).toContain('Before compact');
      expect(html).toContain('After compact');
      expect(html.indexOf('Before compact')).toBeLessThan(html.indexOf('After compact'));
    }
  );

  it('hides empty reasoning and renders public sections without a separate summary', async () => {
    const empty = conversationItem('reasoning-restored', 'reasoning', {
      sections: [{ text: ' \n\t' }]
    });
    const hidden = await render(ConversationTimeline, {
      ...timelineProps,
      turns: [conversationTurn([empty], { status: 'RUNNING' })]
    });
    expect(hidden).not.toContain('conversation-item reasoning reasoning-group');

    const payload = {
      representation: 'summary',
      sections: [{ text: 'Public reasoning without a separate summary' }]
    };
    expect(payload).not.toHaveProperty('summary');
    const restored = { ...empty, payload };
    const shown = await render(ConversationTimeline, {
      ...timelineProps,
      turns: [conversationTurn([restored], { status: 'RUNNING' })]
    });
    expect(restored.id).toBe(empty.id);
    expect(shown).toMatch(/class="conversation-item reasoning reasoning-group"/u);
    expect(shown).toContain('Public reasoning without a separate summary');
  });

  it('renders separate Node process IDs around a visible Agent reply', async () => {
    const before = {
      ...conversationItem('reasoning-before', 'reasoning', {
        representation: 'summary',
        sections: [{ text: 'Before reply process marker' }]
      }),
      processGroup: { id: 'process-before-reply', isStart: true as const }
    };
    const reply = conversationItem('reply', 'assistant_message', {
      text: 'The reply establishes a process boundary.'
    });
    const after = {
      ...conversationItem('reasoning-after', 'reasoning', {
        representation: 'unspecified',
        sections: [{ text: 'After reply process marker' }]
      }),
      processGroup: { id: 'process-after-reply', isStart: true as const }
    };
    const html = await render(ConversationTimeline, {
      ...timelineProps,
      synchronized: true,
      runs: [{ id: 'run-1', status: 'RUNNING' }],
      turns: [conversationTurn([before, reply, after], { status: 'RUNNING' })]
    });

    expect(html).toContain('data-process-id="process-before-reply"');
    expect(html).toContain('data-process-id="process-after-reply"');
    const positions = [
      'Before reply process marker',
      'The reply establishes a process boundary.',
      'After reply process marker'
    ].map((marker) => html.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('preserves manual process disclosure across Run activity updates', async () => {
    class HostNode {
      readonly props: Record<string, unknown> = {};
      readonly children: HostNode[] = [];
      parent: HostNode | null = null;
      constructor(readonly type: string) {}
    }
    const renderer = createRenderer<HostNode, HostNode>({
      patchProp: (node, key, _previous, next) => {
        node.props[key] = next;
      },
      insert: (node, parent, anchor) => {
        node.parent = parent;
        const index = anchor == null ? -1 : parent.children.indexOf(anchor);
        if (index < 0) parent.children.push(node);
        else parent.children.splice(index, 0, node);
      },
      remove: (node) => {
        if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
        node.parent = null;
      },
      createElement: (type) => new HostNode(type),
      createText: () => new HostNode('#text'),
      createComment: () => new HostNode('#comment'),
      setText() {},
      setElementText() {},
      parentNode: (node) => node.parent,
      nextSibling: (node) => {
        if (!node.parent) return null;
        const index = node.parent.children.indexOf(node);
        return node.parent.children[index + 1] ?? null;
      }
    });
    const groupId = 'process-manual';
    const segment = conversationTurn([
      {
        ...conversationItem('tool-active', 'tool_call', { toolName: 'read' }, 'IN_PROGRESS'),
        processGroup: { id: groupId, isStart: true as const }
      }
    ]);
    const active = conversationWorkProcessBlocks(
      [segment],
      [{ id: 'run-1', status: 'RUNNING' }]
    )[0]!;
    const ended = conversationWorkProcessBlocks(
      [segment],
      [{ id: 'run-1', status: 'SUCCEEDED' }]
    )[0]!;
    const block = shallowRef(active);
    let setupState: Record<string, unknown> | undefined;
    const app = renderer.createApp({
      render: () =>
        h(ConversationWorkProcess, {
          block: block.value,
          synchronized: true,
          now: undefined,
          onVnodeMounted: (vnode) => {
            setupState = (
              vnode.component as unknown as { readonly setupState: Record<string, unknown> } | null
            )?.setupState;
          }
        })
    });
    app.use(i18n);
    app.provide(ssrContextKey, { modules: new Set<string>() });
    app.config.warnHandler = () => {};
    const root = new HostNode('root');
    app.mount(root);
    const open = () => setupState?.['open'];
    try {
      expect(open()).toBe(true);
      if (setupState === undefined) throw new Error('Missing process component state');
      setupState['manualOpen'] = false;
      await nextTick();
      expect(open()).toBe(false);

      block.value = ended;
      await nextTick();
      expect(open()).toBe(false);

      setupState['manualOpen'] = true;
      await nextTick();
      expect(open()).toBe(true);
      block.value = active;
      await nextTick();
      expect(open()).toBe(true);
    } finally {
      app.unmount();
    }
  });

  it('renders public reasoning text in its Node-assigned process without a progress animation', async () => {
    const reasoning = {
      ...conversationItem(
        'reasoning-visible',
        'reasoning',
        {
          representation: 'visible_thinking',
          sections: [{ text: 'Public reasoning content marker.' }]
        },
        'IN_PROGRESS'
      ),
      processGroup: { id: 'process-reasoning', isStart: true as const }
    };
    const html = await render(ConversationTimeline, {
      ...timelineProps,
      synchronized: true,
      runs: [{ id: 'run-1', status: 'RUNNING' }],
      turns: [conversationTurn([reasoning], { status: 'RUNNING' })]
    });

    expect(html).toContain('data-process-id="process-reasoning"');
    expect(html).toContain('Public reasoning content marker.');
    expect(html).not.toContain('reasoning-progress');
  });

  it('renders approval details and gates approval decisions on the supplied Node readiness', async () => {
    const approval = conversationItem(
      'approval-1',
      'approval_request',
      {
        approvalId: 'approval-1',
        approvalStatus: 'PENDING',
        approval: {
          toolName: 'shell',
          reason: 'Confirm the target.',
          input: { command: 'git status', cwd: '/fixture' }
        },
        expiresAt: 1_800_000_000_000
      },
      'PENDING'
    );
    const unavailable = await render(ConversationTimeline, {
      ...timelineProps,
      turns: [conversationTurn([approval])]
    });
    const ready = await render(ConversationTimeline, {
      ...timelineProps,
      nodeReady: true,
      turns: [conversationTurn([approval], { status: 'WAITING_APPROVAL' })]
    });

    expect(unavailable).toContain('shell');
    expect(unavailable).toContain(i18n.global.t('presentation.command'));
    expect(unavailable).toContain('git status');
    expect(unavailable).toContain('/fixture');
    expect(unavailable).toContain('Confirm the target.');
    expect(unavailable).not.toContain(i18n.global.t('generated.conversationApprovals.allow'));
    expect(ready).toContain(i18n.global.t('generated.conversationApprovals.allow'));
    expect(ready).toContain(i18n.global.t('generated.conversationApprovals.deny'));
    expect(ready).toContain('el-button--primary');
    expect(ready).not.toContain('el-button--danger');
    expect(ready).toContain(i18n.global.t('generated.conversationApprovals.expires'));
    for (const status of ['APPROVED', 'REJECTED', 'EXPIRED'] as const) {
      const settled = await render(ConversationTimeline, {
        ...timelineProps,
        nodeReady: true,
        turns: [
          conversationTurn(
            [{ ...approval, payload: { ...(approval.payload as object), approvalStatus: status } }],
            { status: 'RUNNING' }
          )
        ]
      });
      expect(settled).not.toContain('class="approval-actions"');
    }
    const cancelled = await render(ConversationTimeline, {
      ...timelineProps,
      nodeReady: true,
      turns: [conversationTurn([approval], { status: 'CANCELLED' })]
    });
    expect(cancelled).not.toContain('class="approval-actions"');
  });

  it('renders Node-provided input questions and keeps a runless request non-submittable', async () => {
    const question = {
      id: 'scope',
      prompt: 'Which scope should be changed?',
      options: [{ label: 'Public API only', value: 'public-api' }],
      allowOther: true,
      input: 'SINGLE_SELECT' as const
    };
    const html = await render(ConversationTimeline, {
      ...timelineProps,
      nodeReady: true,
      turns: [
        conversationTurn(
          [
            conversationItem('input-1', 'user_input_request', { requestId: 'request-1' }, 'PENDING')
          ],
          { runId: null, status: 'WAITING_INPUT' }
        )
      ],
      userInputQuestions: () => [question]
    });

    expect(html).toContain('Which scope should be changed?');
    expect(html).toContain('Public API only');
    expect(html).toContain(i18n.global.t('generated.conversationTimeline.orEnterAnotherAnswer'));
    const submit = html
      .match(/<button\b[^>]*>[\s\S]*?<\/button>/gu)
      ?.find((button) =>
        button.includes(i18n.global.t('generated.conversationTimeline.submitAnswers'))
      );
    expect(submit).toBeDefined();
    expect(submit).toMatch(/^<button\b[^>]*\sdisabled(?:\s|>|=)/u);
  });

  it('keeps Rewind independent of Run state while gating Rollback on terminal user boundaries', async () => {
    const userMessage = conversationItem(
      'user-1',
      'user_message',
      { text: 'Original user text' },
      'COMPLETED'
    );
    const eligible = await render(ConversationTimeline, {
      ...timelineProps,
      rewindEnabled: true,
      rollbackEnabled: true,
      turns: [
        conversationTurn([userMessage], {
          status: 'FAILED',
          rewind: { before: 'before-1', after: 'after-1' }
        })
      ]
    });
    const running = await render(ConversationTimeline, {
      ...timelineProps,
      rewindEnabled: true,
      rollbackEnabled: true,
      turns: [
        conversationTurn([userMessage], {
          status: 'RUNNING',
          rewind: { before: 'before-1', after: 'after-1' }
        })
      ]
    });

    expect(eligible).toContain(
      i18n.global.t('generated.conversationTimeline.createARollbackBranchBeforeThisMessage')
    );
    expect(eligible).toContain(
      i18n.global.t('generated.conversationTimeline.rollbackConversationBeforeThisMessage')
    );
    expect(running).toContain(
      i18n.global.t('generated.conversationTimeline.createARollbackBranchBeforeThisMessage')
    );
    expect(running).not.toContain(
      i18n.global.t('generated.conversationTimeline.rollbackConversationBeforeThisMessage')
    );
  });

  it('renders optional attachment and generated-image previews through the dialog boundary', async () => {
    const attachment = {
      id: 'attachment-1',
      file: { name: 'upload.png' },
      previewUrl: '/uploads/upload.png',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      receivedBytes: 1,
      status: 'COMPLETED'
    };
    const previews = await render(ImagePreviewDialogs, {
      attachmentOpen: true,
      attachment,
      conversationOpen: true,
      conversation: { name: 'generated.png', url: '/runs/generated.png' }
    });
    const empty = await render(ImagePreviewDialogs, {
      attachmentOpen: true,
      attachment: undefined,
      conversationOpen: true,
      conversation: undefined
    });

    expect(previews).toContain('data-dialog-title="upload.png"');
    expect(previews).toContain('src="/uploads/upload.png"');
    expect(previews).toContain('data-dialog-title="generated.png"');
    expect(previews).toContain('src="/runs/generated.png"');
    expect(empty).toContain(
      `data-dialog-title="${i18n.global.t('generated.imagePreviewDialogs.attachmentPreview')}"`
    );
    expect(empty).toContain(
      `data-dialog-title="${i18n.global.t('generated.imagePreviewDialogs.imagePreview')}"`
    );
    expect(empty).not.toContain('attachment-preview-image');
  });
});
