import { readFileSync } from 'node:fs';
import {
  createRenderer,
  createSSRApp,
  h,
  nextTick,
  reactive,
  ssrContextKey,
  type Component,
  type VNode
} from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { serializeComposerTag } from '@myagentroam/protocol';
import {
  composerReferenceDescription,
  composerReferenceLabel
} from '../../src/util/composer-reference.js';
import type { WorkspaceQueueItem } from '../../src/model/workbench.js';
import ComposerAttachments from '../../src/view/composer/ComposerAttachments.vue';
import ComposerCommandPicker from '../../src/view/composer/ComposerCommandPicker.vue';
import ComposerReferencePicker from '../../src/view/composer/ComposerReferencePicker.vue';
import ComposerQueue from '../../src/view/composer/ComposerQueue.vue';
import ComposerToolbar from '../../src/view/composer/ComposerToolbar.vue';
import ConversationComposer from '../../src/view/composer/ConversationComposer.vue';
import MessageReferenceTags from '../../src/view/composer/MessageReferenceTags.vue';
import FileTypeIcon from '../../src/view/workspace/FileTypeIcon.vue';

async function render(
  component: Component,
  props: Record<string, unknown>,
  tooltipValues?: unknown[]
) {
  const app = createSSRApp({ render: () => h(component, props) });
  app.use(i18n);
  app.use(ElementPlus);
  app.directive('tooltip', {
    getSSRProps: (binding) => {
      tooltipValues?.push(binding.value);
      return {};
    }
  });
  app.provide(ID_INJECTION_KEY, { prefix: 200, current: 0 });
  app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
  return renderToString(app);
}

const pickerProps = {
  open: true,
  commands: [],
  skills: [],
  quickPrompts: [],
  quickPromptsLoading: false,
  quickPromptsFailed: false,
  pickerKind: 'runner',
  skillsEnabled: true,
  skillsLoading: false,
  skillsFailed: false,
  activeIndex: 0,
  loading: false,
  failed: false
};

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('queue interactions', () => {
  function mountQueue() {
    type HostNode = { type: string; props: Record<string, unknown> };
    const renderer = createRenderer<HostNode, HostNode>({
      patchProp() {},
      insert() {},
      remove() {},
      setText() {},
      setElementText() {},
      createElement: (type) => ({ type, props: {} }),
      createText: () => ({ type: '#text', props: {} }),
      createComment: () => ({ type: '#comment', props: {} }),
      parentNode: () => null,
      nextSibling: () => null
    });
    const dragStart = vi.fn();
    const reorder = vi.fn();
    let state: Record<string, unknown>;
    const props = reactive({
      items: [
        {
          queueItemId: 'q1',
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'mar-agent',
          clientMessageId: 'client-q1',
          sessionTitle: 'Session one',
          content: 'First',
          createdAt: 1
        },
        {
          queueItemId: 'q2',
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'mar-agent',
          clientMessageId: 'client-q2',
          sessionTitle: 'Session one',
          content: 'Second',
          createdAt: 2
        }
      ] satisfies WorkspaceQueueItem[],
      paused: false,
      loading: false,
      editingQueueItemId: undefined,
      editingContent: '',
      goal: undefined,
      onDragStart: dragStart,
      onReorder: reorder
    });
    const app = renderer.createApp({
      render: () =>
        h(ComposerQueue, {
          ...props,
          onVnodeMounted: (vnode: VNode) => {
            state = (vnode.component as unknown as { setupState: Record<string, unknown> })
              .setupState;
          }
        })
    });
    app.use(i18n);
    app.provide(ssrContextKey, { modules: new Set<string>() });
    app.config.warnHandler = () => {};
    app.mount({ type: 'root', props: {} });
    const item = { queueItemId: 'q1', content: 'First' };
    function fire(
      name: 'onItemPointerDown' | 'onItemPointerMove' | 'onItemPointerUp' | 'onItemContextMenu',
      overrides: Record<string, unknown> = {}
    ) {
      const event = {
        pointerId: 1,
        pointerType: 'touch',
        isPrimary: true,
        button: 0,
        clientX: 10,
        clientY: 10,
        target: { closest: () => null },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        ...overrides
      };
      (state[name] as (event: unknown, item: unknown) => void)(event, item);
      return event;
    }
    return {
      app,
      props,
      fire,
      dragStart,
      reorder,
      getState: () => state
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('scrolls to the end for new queue identities, including equal-sized snapshots', async () => {
    const queue = mountQueue();
    const list = { scrollTop: 10, scrollHeight: 400 };
    queue.getState().workList = list;
    try {
      queue.props.items.push({ ...queue.props.items[0]!, queueItemId: 'q3' });
      await nextTick();
      expect(list.scrollTop).toBe(400);

      list.scrollTop = 20;
      queue.props.items = queue.props.items.map((item, index) =>
        index === 0 ? { ...item, queueItemId: 'q4' } : item
      );
      await nextTick();
      expect(list.scrollTop).toBe(400);
    } finally {
      queue.app.unmount();
    }
  });

  it('keeps the scroll position when existing queue items are edited, reordered or removed', async () => {
    const queue = mountQueue();
    const list = { scrollTop: 20, scrollHeight: 400 };
    queue.getState().workList = list;
    try {
      queue.props.items = queue.props.items.map((item) => ({ ...item, content: 'Updated' }));
      await nextTick();
      expect(list.scrollTop).toBe(20);
      queue.props.items.reverse();
      await nextTick();
      expect(list.scrollTop).toBe(20);
      queue.props.items.pop();
      await nextTick();
      expect(list.scrollTop).toBe(20);
    } finally {
      queue.app.unmount();
    }
  });

  it.each(['touch', 'pen'])('opens the move menu after a %s long-press', async (pointerType) => {
    const queue = mountQueue();
    try {
      queue.fire('onItemPointerDown', { pointerType });
      expect(queue.getState().contextMenu).toBeUndefined();
      await vi.advanceTimersByTimeAsync(500);
      await nextTick();
      await nextTick();
      expect(queue.getState().contextMenu).toMatchObject({ queueItemId: 'q1' });
      expect(queue.getState().contextMenuIndex).toBe(0);
      expect(queue.dragStart).not.toHaveBeenCalled();
    } finally {
      queue.app.unmount();
    }
  });

  it('swallows the click from lifting a held long-press', async () => {
    type Handler = (event: Event) => void;
    const listeners: Record<string, Handler[]> = {};
    vi.stubGlobal('addEventListener', (type: string, handler: Handler) => {
      (listeners[type] ??= []).push(handler);
    });
    vi.stubGlobal('removeEventListener', (type: string, handler: Handler) => {
      listeners[type] = (listeners[type] ?? []).filter((candidate) => candidate !== handler);
    });
    const queue = mountQueue();
    try {
      queue.fire('onItemPointerDown');
      await vi.advanceTimersByTimeAsync(500);
      await nextTick();
      await nextTick();
      expect(queue.getState().contextMenu).toMatchObject({ queueItemId: 'q1' });
      expect(listeners.click).toHaveLength(1);
      const clickHandler = listeners.click?.[0];
      queue.fire('onItemContextMenu');
      expect(listeners.click).toEqual([clickHandler]);
      const synthetic = {
        detail: 0,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        stopImmediatePropagation: vi.fn()
      };
      for (const handler of listeners.click ?? []) handler(synthetic as unknown as Event);
      expect(synthetic.preventDefault).not.toHaveBeenCalled();
      const click = {
        detail: 1,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        stopImmediatePropagation: vi.fn()
      };
      for (const handler of listeners.click ?? []) handler(click as unknown as Event);
      expect(click.preventDefault).toHaveBeenCalled();
      expect(click.stopImmediatePropagation).toHaveBeenCalled();
      expect(queue.getState().contextMenu).toMatchObject({ queueItemId: 'q1' });
      const later = {
        detail: 1,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        stopImmediatePropagation: vi.fn()
      };
      for (const handler of listeners.click ?? []) handler(later as unknown as Event);
      expect(later.preventDefault).not.toHaveBeenCalled();
    } finally {
      queue.app.unmount();
    }
  });

  it('moves a long-pressed item down with the existing queue intents', async () => {
    const queue = mountQueue();
    try {
      queue.fire('onItemPointerDown');
      await vi.advanceTimersByTimeAsync(500);
      await nextTick();
      await nextTick();
      (queue.getState().contextCommand as (command: string) => void)('down');
      expect(queue.dragStart).toHaveBeenCalledExactlyOnceWith('q1');
      expect(queue.reorder).toHaveBeenCalledExactlyOnceWith('q2');
      expect(queue.dragStart.mock.invocationCallOrder[0]).toBeLessThan(
        queue.reorder.mock.invocationCallOrder[0]!
      );
      expect(queue.getState().contextMenu).toBeUndefined();
    } finally {
      queue.app.unmount();
    }
  });

  it('opens the menu from a touch contextmenu without waiting', async () => {
    const queue = mountQueue();
    try {
      queue.fire('onItemPointerDown');
      const event = queue.fire('onItemContextMenu');
      await nextTick();
      await nextTick();
      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
      expect(queue.getState().contextMenu).toMatchObject({ queueItemId: 'q1' });
    } finally {
      queue.app.unmount();
    }
  });

  it('keeps the held long-press menu if the browser also fires contextmenu', async () => {
    const queue = mountQueue();
    try {
      queue.fire('onItemPointerDown');
      await vi.advanceTimersByTimeAsync(500);
      await nextTick();
      await nextTick();
      const opened = queue.getState().contextMenu;
      const event = queue.fire('onItemContextMenu');
      await nextTick();
      await nextTick();
      expect(event.preventDefault).toHaveBeenCalled();
      expect(queue.getState().contextMenu).toBe(opened);
    } finally {
      queue.app.unmount();
    }
  });

  it.each(['move', 'cancel', 'mouse', 'button', 'loading'])(
    'does not open the menu on %s',
    async (scenario) => {
      const queue = mountQueue();
      try {
        if (scenario === 'loading') queue.props.loading = true;
        queue.fire('onItemPointerDown', {
          pointerType: scenario === 'mouse' ? 'mouse' : 'touch',
          target:
            scenario === 'button'
              ? { closest: (selector: string) => (selector.includes('button') ? {} : null) }
              : { closest: () => null }
        });
        if (scenario === 'move') queue.fire('onItemPointerMove', { clientY: 40 });
        if (scenario === 'cancel') queue.fire('onItemPointerUp');
        await vi.advanceTimersByTimeAsync(500);
        await nextTick();
        expect(queue.getState().contextMenu).toBeUndefined();
        expect(queue.dragStart).not.toHaveBeenCalled();
        expect(queue.reorder).not.toHaveBeenCalled();
      } finally {
        queue.app.unmount();
      }
    }
  );

  it('keeps native mouse dragging and suppresses HTML5 drag for touch', () => {
    const queue = mountQueue();
    try {
      const touchDrag = { preventDefault: vi.fn() };
      queue.fire('onItemPointerDown');
      (queue.getState().onNativeDragStart as (event: object, id: string) => void)(touchDrag, 'q1');
      expect(touchDrag.preventDefault).toHaveBeenCalled();
      expect(queue.dragStart).not.toHaveBeenCalled();

      const mouseDrag = { preventDefault: vi.fn() };
      queue.fire('onItemPointerDown', { pointerType: 'mouse' });
      (queue.getState().onNativeDragStart as (event: object, id: string) => void)(mouseDrag, 'q1');
      expect(mouseDrag.preventDefault).not.toHaveBeenCalled();
      expect(queue.dragStart).toHaveBeenCalledExactlyOnceWith('q1');
    } finally {
      queue.app.unmount();
    }
  });

  it('does not move past the ends of the queue', async () => {
    const queue = mountQueue();
    try {
      queue.fire('onItemPointerDown');
      await vi.advanceTimersByTimeAsync(500);
      await nextTick();
      await nextTick();
      (queue.getState().contextCommand as (command: string) => void)('up');
      expect(queue.dragStart).not.toHaveBeenCalled();
      expect(queue.reorder).not.toHaveBeenCalled();
    } finally {
      queue.app.unmount();
    }
  });

  it('clears a pending long-press on unmount', async () => {
    const queue = mountQueue();
    queue.fire('onItemPointerDown');
    queue.app.unmount();
    await vi.advanceTimersByTimeAsync(500);
    expect(queue.dragStart).not.toHaveBeenCalled();
    expect(queue.reorder).not.toHaveBeenCalled();
  });
});

describe.each(['zh-CN', 'en-US'] as const)('public Composer components (%s)', (locale) => {
  beforeEach(() => localePreferenceService().setLocale(locale));

  it('renders quote snapshots as literal text and keeps ordinary file references as tags', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.stubGlobal('document', {
      documentElement: {
        setAttribute: vi.fn(),
        removeAttribute: vi.fn(),
        classList: { add: vi.fn(), remove: vi.fn() },
        style: { removeProperty: vi.fn(), setProperty: vi.fn() }
      },
      querySelector: () => null
    });
    const html = await render(MessageReferenceTags, {
      references: [
        { type: 'file', path: 'src/example.ts', label: 'example.ts' },
        {
          type: 'quote',
          id: 'snapshot',
          source: 'assistant',
          messageId: 'reply',
          label: 'Reply excerpt',
          text: 'First line\n<script>alert(1)</script> & <mar_references>'
        }
      ]
    });
    expect(html).toContain('message-reference-tag');
    expect(html).toContain('example.ts');
    expect(html).toContain('quote-excerpt-text');
    expect(html).toContain(
      'First line\n&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;mar_references&gt;'
    );
    expect(html).not.toContain('<script>');
  });

  it('bounds file tags and tooltip descriptions without changing the reference', () => {
    const reference = {
      type: 'file' as const,
      path: `${'long-directory/'.repeat(60)}example.ts`,
      label: `${'😀'.repeat(40)}.ts`
    };
    expect(composerReferenceLabel(reference)).toBe(`${'😀'.repeat(31)}…`);
    const description = composerReferenceDescription(reference);
    expect(Array.from(description)).toHaveLength(500);
    expect(description.endsWith('…')).toBe(true);
    expect(reference.label).toBe(`${'😀'.repeat(40)}.ts`);
    expect(reference.path.endsWith('example.ts')).toBe(true);
  });

  it.each(['assistant', 'file', 'diff'] as const)(
    'limits the displayed %s snapshot without shortening its serialized content',
    async (source) => {
      const text = '😀'.repeat(600);
      const fields = { type: 'quote' as const, id: 'bounded', label: 'Saved excerpt', text };
      const reference =
        source === 'assistant'
          ? { ...fields, source, messageId: 'reply' }
          : source === 'file'
            ? {
                ...fields,
                source,
                path: 'src/example.ts',
                origin: 'WORKING_TREE' as const,
                startLine: 1,
                endLine: 30
              }
            : { ...fields, source, path: 'src/example.ts', origin: 'WORKING_TREE' as const };
      const html = await render(MessageReferenceTags, { references: [reference] });
      expect(html).toContain(`${'😀'.repeat(499)}…`);
      expect(html).not.toContain(text);
      expect(serializeComposerTag('mar_references', { references: [reference] })).toContain(text);
    }
  );

  it.each(['Earlier in this conversation', '0', '2025-02-30T00:00:00Z'])(
    'keeps protocol-valid descriptive quote timestamp %s readable',
    async (timestamp) => {
      const html = await render(MessageReferenceTags, {
        references: [
          {
            type: 'quote',
            id: 'descriptive-time',
            source: 'assistant',
            messageId: 'reply',
            label: 'Reply excerpt',
            timestamp,
            text: 'Saved reply excerpt.'
          }
        ]
      });
      expect(html).toContain(` · ${timestamp}</span>`);
      expect(html).not.toContain('NaN');
    }
  );

  it.each(['2026-11-11T08:11:57.256Z', '2026-11-11T00:00:00+08:00'])(
    'formats ISO quote timestamp %s as an absolute date',
    async (timestamp) => {
      const html = await render(MessageReferenceTags, {
        references: [
          {
            type: 'quote',
            id: 'absolute-time',
            source: 'assistant',
            messageId: 'reply',
            label: 'Reply excerpt',
            timestamp,
            text: 'Saved reply excerpt.'
          }
        ]
      });
      expect(html).toMatch(/ · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}<\/span>/);
      expect(html).not.toContain(timestamp);
    }
  );

  it('keeps queued attachments hidden while preserving body and queue actions', async () => {
    const attachments = serializeComposerTag('mar_attachments', {
      files: [
        { name: 'screenshot.jpg', path: '.mar/temp-files/input/screenshot.jpg', mime: 'image/jpeg' }
      ]
    });
    const html = await render(ComposerQueue, {
      items: [
        { queueItemId: 'queued-body', content: `Queued message\n${attachments}` },
        { queueItemId: 'queued-files', content: attachments }
      ],
      paused: false,
      loading: false,
      editingQueueItemId: undefined,
      editingContent: '',
      goal: undefined
    });
    expect(html).toContain('Queued message');
    expect(html).toContain('queued-files');
    expect(html).not.toContain('conversation-file-attachment');
    expect(html).not.toContain('screenshot.jpg');
    expect(html).not.toContain('mar_attachments');
    const actionLabel = locale === 'zh-CN' ? '执行' : 'Steer';
    expect(html).toContain(`aria-label="${actionLabel}"`);
    expect(html).not.toContain(`title="${actionLabel}"`);
    expect(html).toContain(`>${actionLabel}</span>`);
  });

  it.each([false, true])(
    'shows saved quote snapshots without XML in queue entries (editing: %s)',
    async (editing) => {
      const content = serializeComposerTag('mar_references', {
        references: [
          {
            type: 'quote',
            id: 'quote-queue',
            source: 'assistant',
            messageId: 'reply-1',
            label: 'Reply excerpt',
            text: 'Private snapshot text'
          }
        ]
      });
      const html = await render(ComposerQueue, {
        items: [{ queueItemId: 'quote-only', content }],
        paused: false,
        loading: false,
        editingQueueItemId: editing ? 'quote-only' : undefined,
        editingContent: '',
        goal: undefined
      });
      expect(html).toContain('message-reference-tag');
      expect(html).toContain(locale === 'zh-CN' ? '回复片段' : 'Reply excerpt');
      expect(html).toContain('Private snapshot text');
      expect(html).not.toContain('mar_references');
    }
  );

  it('shows Session and marctl source labels for queued normal and steering messages', async () => {
    const origin = serializeComposerTag('mar_session_origin', {
      sessionId: 'session-42',
      name: 'Reviewer'
    });
    const steered = serializeComposerTag('mar_steer', { message: 'Steering follow-up' });
    const terminalOrigin = serializeComposerTag('mar_session_origin', {});
    const sharedOrigin = serializeComposerTag('mar_channel', {
      source: 'WEB_SHARE',
      channelId: 'link',
      senderId: 'visitor',
      name: 'Alice'
    });
    const html = await render(ComposerQueue, {
      items: [
        { queueItemId: 'normal', content: `Normal follow-up\n${origin}` },
        { queueItemId: 'steer', content: `${steered}\n${origin}` },
        { queueItemId: 'terminal', content: `Terminal follow-up\n${terminalOrigin}` },
        { queueItemId: 'plain', content: 'Unmarked follow-up' },
        { queueItemId: 'shared', content: 'Shared follow-up\n' + sharedOrigin }
      ],
      paused: false,
      loading: false,
      editingQueueItemId: undefined,
      editingContent: '',
      goal: undefined
    });
    expect(html).toContain(locale === 'zh-CN' ? '来自 Reviewer' : 'From Reviewer');
    expect(html).toContain(
      locale === 'zh-CN'
        ? '来源：会话\n会话 ID：session-42'
        : 'Source: Session\nSession ID: session-42'
    );
    expect(html).toContain(locale === 'zh-CN' ? '来自 Alice' : 'From Alice');
    expect(html).toContain(locale === 'zh-CN' ? '来源：网页分享' : 'Source: Web share');
    expect(html).toContain('Shared follow-up');
    expect(html).toContain(locale === 'zh-CN' ? '来自 marctl' : 'From marctl');
    expect(html).toContain('Normal follow-up');
    expect(html).toContain('Steering follow-up');
    expect(html).toContain('Terminal follow-up');
    expect(html).toContain('Unmarked follow-up');
    expect(html).not.toContain('mar_session_origin');
    expect(html).not.toContain('mar_steer');
  });

  it('owns all fixed messages without installing an enterprise catalog', () => {
    for (const name of [
      'ConversationComposer',
      'ComposerToolbar',
      'ComposerQueue',
      'ComposerAttachments',
      'ComposerCommandPicker'
    ]) {
      const source = readFileSync(
        new URL(`../../src/view/composer/${name}.vue`, import.meta.url),
        'utf8'
      );
      const keys = [
        ...source.matchAll(/'((?:generated|common|goal|composer|quickPrompts)\.[\w.-]+)'/gu)
      ].map((match) => match[1]!);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) expect(i18n.global.te(key, locale), key).toBe(true);
    }
  });

  it('renders attachment progress, preview and escaped filenames', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.stubGlobal('document', {
      documentElement: {
        setAttribute: vi.fn(),
        removeAttribute: vi.fn(),
        classList: { add: vi.fn(), remove: vi.fn() },
        style: { removeProperty: vi.fn(), setProperty: vi.fn() }
      },
      querySelector: () => null
    });
    const html = await render(ComposerAttachments, {
      attachments: [
        {
          id: 'image',
          file: { name: '<image>.png', size: 2048 },
          status: 'UPLOADING',
          receivedBytes: 1024,
          previewUrl: '/preview.png'
        },
        {
          id: 'failed',
          file: { name: 'generated.report.txt', size: 12 },
          status: 'FAILED',
          receivedBytes: 0,
          previewUrl: null,
          error: 'Remote failure'
        }
      ]
    });
    expect(html).toContain('50%');
    expect(html).toContain('&lt;image&gt;.png');
    expect(html).toContain('generated.report.txt');
    expect(html).toContain('Remote failure');
    expect(html).toContain('src="/preview.png"');
    const icon = await render(FileTypeIcon, { name: 'generated.report.txt' });
    expect(html.replace(/ data-v-[\da-f]+/gu, '')).toContain(
      icon.replace(/ data-v-[\da-f]+/gu, '')
    );
    expect(html.match(/class="file-type-icon /gu)).toHaveLength(1);
    expect(html).toContain(i18n.global.t('generated.composerAttachments.uploading2'));
    expect(html).toContain(i18n.global.t('generated.composerAttachments.uploadFailed'));
    expect(await render(ComposerAttachments, { attachments: [] })).not.toContain('<ul');
  });

  it('renders command and skill candidates with the same active-index semantics', async () => {
    const html = await render(ComposerCommandPicker, {
      ...pickerProps,
      commands: [{ id: 'plan', description: 'Native plan description' }],
      skills: [{ name: 'review', description: 'Review generated.source text' }],
      activeIndex: 1
    });
    expect(html).toContain('/plan');
    expect(html).toContain('Native plan description');
    expect(html).toContain('Review generated.source text');
    expect(html).toMatch(
      /<button\b(?=[^>]*role="option")(?=[^>]*aria-selected="true")(?=[^>]*data-picker-index="1")[^>]*>/u
    );
    expect(html).toMatch(
      /<button\b(?=[^>]*role="option")(?=[^>]*aria-selected="false")(?=[^>]*data-picker-index="0")[^>]*>/u
    );
    expect(html).toContain(i18n.global.t('generated.composerCommandPicker.commandsAndSkills'));
  });

  it('keeps one full-content hint per quick-prompt or file candidate', async () => {
    const promptHints: unknown[] = [];
    const promptHtml = await render(
      ComposerCommandPicker,
      {
        ...pickerProps,
        pickerKind: 'quick-prompt',
        quickPrompts: [{ id: 'review', phrase: 'review', prompt: 'Review the current changes' }]
      },
      promptHints
    );
    expect(promptHtml).toContain('#review');
    expect(promptHtml).toContain('Review the current changes');
    expect(promptHints.filter(Boolean)).toEqual(['Review the current changes']);

    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.stubGlobal('document', {
      documentElement: {
        classList: { add: vi.fn(), remove: vi.fn() },
        setAttribute: vi.fn(),
        removeAttribute: vi.fn()
      }
    });
    const fileHints: unknown[] = [];
    const fileHtml = await render(
      ComposerReferencePicker,
      {
        open: true,
        candidates: [
          {
            type: 'file',
            key: 'file:src/nested/example.ts',
            entry: { name: 'example.ts', path: 'src/nested/example.ts', kind: 'FILE' }
          }
        ],
        activeIndex: 0,
        loading: false,
        query: 'example'
      },
      fileHints
    );
    expect(fileHtml).toContain('example.ts');
    expect(fileHtml).toContain('src/nested/example.ts');
    expect(fileHints.filter(Boolean)).toEqual(['src/nested/example.ts']);
  });

  it('keeps failed quick-prompt loading distinct from empty candidates', async () => {
    const failed = await render(ComposerCommandPicker, {
      ...pickerProps,
      pickerKind: 'quick-prompt',
      quickPromptsFailed: true
    });
    const empty = await render(ComposerCommandPicker, {
      ...pickerProps,
      pickerKind: 'quick-prompt'
    });
    expect(failed).toContain(i18n.global.t('quickPrompts.loadFailed'));
    expect(failed).not.toContain(i18n.global.t('quickPrompts.noMatches'));
    expect(empty).toContain(i18n.global.t('quickPrompts.noMatches'));
    expect(empty).not.toContain(i18n.global.t('quickPrompts.loadFailed'));
    expect(await render(ComposerCommandPicker, { ...pickerProps, open: false })).not.toContain(
      'role="listbox"'
    );
  });

  it('renders a paused queue with a goal and keeps user content unchanged', async () => {
    const labels =
      locale === 'zh-CN'
        ? { pending: '待执行工作', goal: '目标', queue: '队列 1', remove: '移除' }
        : { pending: 'Pending work', goal: 'Goal', queue: 'Queue 1', remove: 'Remove' };
    const props = {
      items: [{ queueItemId: 'q1', content: 'Original queued message <script> generated.goal.' }],
      paused: true,
      loading: true,
      editingQueueItemId: undefined,
      editingContent: '',
      goal: { goal: { id: 'goal-1', objective: 'Raw objective', revision: 1, turns: 2 } }
    };
    const html = await render(ComposerQueue, props);
    expect(html).not.toContain('composer-queue-count');
    expect(await render(ComposerQueue, { ...props, goal: undefined })).not.toContain(
      'composer-queue-count'
    );
    expect(await render(ComposerQueue, { ...props, items: [] })).not.toContain(
      'composer-queue-count'
    );
    expect(html).toContain('Original queued message &lt;script&gt; generated.goal.');
    expect(html).toContain('Raw objective');
    expect(html).toContain(labels.pending);
    expect(html).not.toContain('composer-queue-heading');
    expect(html).toContain(i18n.global.t('generated.composerQueue.paused'));
    expect(html).toContain('role="status"');
    expect(html.indexOf('Raw objective')).toBeLessThan(html.indexOf('composer-work-list'));
    expect(await render(ComposerQueue, { ...props, items: [] })).not.toContain(
      'composer-work-list'
    );
    expect(html).toContain(labels.goal);
    expect(html).toContain('goal-card');
    expect(html).not.toContain('mission-card');
    expect(html).toContain(labels.queue);
    expect(html).toMatch(
      new RegExp(
        `<button\\b(?=[^>]*\\sdisabled(?:[\\s=>]))[^>]*>\\s*${labels.remove}\\s*</button>`,
        'u'
      )
    );
    expect(html).toContain('draggable="true"');
    expect(html).toContain('disabled');
  });

  it.each(
    [false, true].flatMap((hidden) =>
      [false, true].flatMap((loading) =>
        [false, true].map((canInterrupt) => ({ hidden, loading, canInterrupt }))
      )
    )
  )(
    'preserves toolbar controls and context feedback independently of global loading: %j',
    async ({ hidden, loading, canInterrupt }) => {
      const props = {
        draftSessionOpen: true,
        runner: 'mar-agent',
        runnerOptions: [],
        runnerLoading: false,
        runnerDisabled: false,
        runnerLabel: 'MAR Agent',
        modelEffortSelection: undefined,
        modelEffortLabel: 'Original model',
        hideModelSelection: hidden,
        hideContextUsage: hidden,
        selectedModel: '',
        selectedEffort: '',
        models: [],
        efforts: [],
        access: 'full-access',
        accessLabel: 'Original access',
        accessOptions: [],
        configurationDisabled: true,
        accessDisabled: true,
        fastEnabled: false,
        contextUsage: hidden ? undefined : { percentage: 25 },
        contextUsageLabel: hidden ? '' : 'Original context summary\nGC: 3 · 12345 tokens',
        canCompactContext: false,
        mobileViewport: false,
        activeRun: { status: 'RUNNING' },
        canInterrupt,
        interruptVisible: true,
        inputHasContent: true,
        hasSelectedCommand: false,
        loading,
        attachmentsPending: true,
        effortLabel: (value: string) => value
      };
      const html = await render(ComposerToolbar, props);
      const runnerInputPattern = new RegExp(
        `<input\\b(?=[^>]*aria-label="${i18n.global.t('common.runner')}")[^>]*>`,
        'u'
      );
      const runnerInput = runnerInputPattern.exec(html)?.[0];
      expect(runnerInput).toBeDefined();
      expect(runnerInput).not.toMatch(/\sdisabled(?:[\s=>])/u);
      const send = /<button\b(?=[^>]*class="[^"]*\bcomposer-send-button\b)[^>]*>/u.exec(html)?.[0];
      const stop = /<button\b(?=[^>]*class="[^"]*\bcomposer-stop-button\b)[^>]*>/u.exec(html)?.[0];
      expect(send).toBeDefined();
      expect(send).toMatch(/\sdisabled(?:[\s=>])/u);
      expect(stop).toBeDefined();
      expect(/\sdisabled(?:[\s=>])/u.test(stop!)).toBe(!canInterrupt);
      expect(html).toContain('composer-attachment-button');
      if (hidden) {
        expect(html).not.toContain('composer-model-slot');
        expect(html).not.toContain('Original model');
        expect(html).not.toContain('composer-context-button');
        expect(html).not.toContain('Original context summary');
      } else {
        expect(html).toContain('Original model');
        expect(html).toContain('25%');
        expect(html).toContain('Original context summary');
        expect(html).toContain(
          `aria-description="Original context summary\nGC: 3 · 12345 tokens\n${locale === 'zh-CN' ? '当前无法压缩上下文。' : 'Context compaction is currently unavailable.'}"`
        );
        const compactable = await render(ComposerToolbar, { ...props, canCompactContext: true });
        expect(compactable).toContain(
          `aria-description="Original context summary\nGC: 3 · 12345 tokens\n${locale === 'zh-CN' ? '点击压缩上下文' : 'Click to compact context'}"`
        );
        for (const contextUsage of [undefined, null, { percentage: 0 }]) {
          const empty = await render(ComposerToolbar, {
            ...props,
            contextUsage,
            contextUsageLabel: '0 / — tokens (0%)\nGC: 0 · 0 tokens'
          });
          expect(empty).toContain('composer-context-button');
          expect(empty).toContain('aria-label="0 / — tokens (0%)\nGC: 0 · 0 tokens"');
          expect(empty).toContain('aria-disabled="true"');
          expect(empty).toContain('--context-usage:0%');
          expect(empty).toMatch(/<span\b[^>]*>0%<\/span>/u);
          expect(empty).not.toContain('NaN');
        }
      }
      expect(html).toContain(
        locale === 'zh-CN'
          ? 'Enter 排队 · Ctrl + Enter 插入消息'
          : 'Enter to queue · Ctrl + Enter to steer'
      );
      expect(
        i18n.global.t('generated.composerToolbar.enterToSendShiftAltEnterFor', { send: 'Enter' })
      ).toBe(
        locale === 'zh-CN'
          ? 'Enter 发送 · Shift/Alt + Enter 换行'
          : 'Enter to send · Shift/Alt + Enter for a new line'
      );
      const submitting = await render(ComposerToolbar, {
        ...props,
        submitting: true,
        runnerDisabled: true
      });
      expect(runnerInputPattern.exec(submitting)?.[0]).toMatch(/\sdisabled(?:[\s=>])/u);
      expect(submitting).toMatch(/class="composer-submitting"[^>]*role="status"/u);
      expect(submitting).toContain(locale === 'zh-CN' ? '发送中...' : 'Sending...');
      expect(submitting).toMatch(
        /<button\b(?=[^>]*class="[^"]*\bcomposer-send-button\b)(?=[^>]*aria-busy="true")(?=[^>]*\sdisabled)[^>]*>/u
      );
      const sendButton =
        /<button\b(?=[^>]*class="[^"]*\bcomposer-send-button\b)[^>]*>([\s\S]*?)<\/button>/u.exec(
          submitting
        );
      expect(sendButton?.[1]).toMatch(/<svg\b(?=[^>]*data-mar-icon="loading-action")/u);
    }
  );

  it('only hints command-state details that add information to the visible label', async () => {
    const tooltipValues: unknown[] = [];
    const html = await render(
      ConversationComposer,
      {
        input: '',
        placeholder: 'Message',
        working: false,
        workingLabel: '',
        readonly: false,
        dropTarget: false,
        mobileViewport: false,
        commandStates: [undefined, '', 'Plan mode', 'Additional plan details'].map(
          (detail, index) => ({
            commandId: `plan-${index}`,
            label: 'Plan mode',
            detail,
            closable: true
          })
        ),
        loading: false,
        skillTokens: []
      },
      tooltipValues
    );
    expect(html).toContain('Plan mode');
    expect(html).toContain('aria-label="Plan mode"');
    expect(html).toContain('aria-label="Additional plan details"');
    expect(tooltipValues.filter(Boolean)).toEqual(['Additional plan details']);
  });

  it('places input context tags after pending work and attachments, before the input', async () => {
    const html = await render(
      {
        render: () =>
          h(
            ConversationComposer,
            {
              input: '',
              placeholder: 'Message',
              working: false,
              workingLabel: '',
              readonly: false,
              dropTarget: false,
              mobileViewport: false,
              commandStates: [],
              loading: false,
              skillTokens: [
                {
                  name: 'find-skills',
                  source: 'WORKSPACE',
                  skillFilePath: '/workspace/.agents/skills/find-skills/SKILL.md',
                  available: true
                }
              ]
            },
            {
              queue: () => h('div', { class: 'pending-work-fixture' }, 'Queued message'),
              attachments: () => h('div', { class: 'attachment-fixture' }, 'report.txt')
            }
          )
      },
      {}
    );
    expect(html.indexOf('pending-work-fixture')).toBeLessThan(html.indexOf('attachment-fixture'));
    expect(html.indexOf('attachment-fixture')).toBeLessThan(
      html.indexOf('composer-command-states')
    );
    expect(html.indexOf('composer-command-states')).toBeLessThan(html.indexOf('<textarea'));
    expect(html).toContain('find-skills');
  });

  it('keeps the submitted text read-only while the submission window is pending', async () => {
    const props = {
      input: 'Submitted message',
      placeholder: 'Message',
      working: false,
      workingLabel: '',
      readonly: false,
      dropTarget: false,
      mobileViewport: false,
      commandStates: [],
      loading: true,
      skillTokens: []
    };
    const pending = await render(ConversationComposer, props);
    expect(pending).toMatch(/<textarea[^>]*readonly/u);
    expect(pending).toContain('Submitted message');
    const settled = await render(ConversationComposer, { ...props, loading: false });
    expect(settled).not.toMatch(/<textarea[^>]*readonly/u);
  });

  it.each(['', 'Reconnecting'])(
    'renders the shared input and gates activity while connection feedback is %s',
    async (connectionLabel) => {
      const html = await render(ConversationComposer, {
        input: 'Raw user input',
        placeholder: 'Original placeholder',
        working: true,
        workingLabel: 'Original working status',
        connectionLabel,
        readonly: true,
        dropTarget: false,
        mobileViewport: false,
        commandStates: [],
        loading: false,
        skillTokens: []
      });
      expect(html).toContain('Raw user input');
      expect(html).toMatch(
        /class="[^"]*\bcomposer-working\b[^"]*"[^>]*>.*class="composer-shell readonly has-working"/su
      );
      expect(html).toContain(connectionLabel || 'Original working status');
      if (connectionLabel) {
        expect(html).not.toContain('is-active');
        expect(html).not.toContain('Original working status');
      } else expect(html).toContain('is-active');
      expect(html).toMatch(/<textarea[^>]*readonly/u);
      expect(html).not.toContain('composer-takeover');
      expect(html).not.toMatch(
        /generated\.|composer\.removeSkill|composer\.skillUnavailableToken/u
      );
    }
  );
});
