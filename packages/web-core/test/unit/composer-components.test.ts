import { readFileSync } from 'node:fs';
import {
  createRenderer,
  createSSRApp,
  h,
  nextTick,
  reactive,
  ssrContextKey,
  type Component
} from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n, localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import { serializeComposerTag } from '@myagentroam/protocol';
import ComposerAttachments from '../../src/view/composer/ComposerAttachments.vue';
import ComposerCommandPicker from '../../src/view/composer/ComposerCommandPicker.vue';
import ComposerQueue from '../../src/view/composer/ComposerQueue.vue';
import ComposerToolbar from '../../src/view/composer/ComposerToolbar.vue';
import ConversationComposer from '../../src/view/composer/ConversationComposer.vue';

it('uses shared Composer typography and registered semantic colors without changing its structure', () => {
  const source = (name: string) =>
    readFileSync(new URL(`../../src/view/${name}.vue`, import.meta.url), 'utf8');
  const composer = source('composer/ConversationComposer');
  const completion = source('composer/PromptCompletionEditor');
  const toolbar = source('composer/ComposerToolbar');
  expect(composer).toContain('font-size: var(--mar-font-size-input)');
  expect(composer).not.toMatch(/--mar-font-size-input\s*:/u);
  expect(composer).toContain('font-family: inherit');
  expect(composer).toContain('color: var(--mar-color-success-text)');
  expect(composer).toContain('background: var(--mar-color-warning-bg)');
  expect(completion).toContain('caret-color: var(--mar-text-primary)');
  expect(completion).not.toContain('var(--mar-text)');
  expect(completion).toContain('font-size: var(--mar-font-size-meta)');
  expect(toolbar).toContain('font-size: var(--mar-font-size-body)');
  expect(toolbar).toContain('color: var(--mar-color-on-accent)');
  for (const name of [
    'composer/ConversationComposer',
    'composer/ComposerToolbar',
    'composer/ComposerQueue',
    'composer/ComposerCommandPicker',
    'composer/ComposerFileReferencePicker',
    'composer/ComposerAttachments',
    'conversation/HostedConversationComposer'
  ]) {
    expect(source(name)).not.toMatch(
      /font-size:\s*(?:12px|13px|0\.(?:65|66|68|69|72|76|8125)rem);/u
    );
    expect(source(name)).not.toMatch(/font-weight:\s*(?:650|700);/u);
  }
});

async function render(component: Component, props: Record<string, unknown>) {
  const app = createSSRApp({ render: () => h(component, props) });
  app.use(i18n);
  app.use(ElementPlus);
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

describe('queue mobile reorder menu', () => {
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
        { queueItemId: 'q1', content: 'First' },
        { queueItemId: 'q2', content: 'Second' }
      ],
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
          onVnodeMounted: (vnode) => {
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
    expect(html).toContain(`title="${actionLabel}"`);
    expect(html).toContain(`>${actionLabel}</span>`);
  });

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

  it.each([false, true])(
    'preserves attachment and stop controls when model metadata is hidden: %s',
    async (hidden) => {
      const html = await render(ComposerToolbar, {
        draftSessionOpen: false,
        runner: 'mar-agent',
        runnerOptions: [],
        runnerLoading: false,
        runnerLabel: 'MAR Agent',
        modelEffortSelection: undefined,
        modelEffortLabel: 'Original model',
        hideModelSelection: hidden,
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
        contextUsageLabel: hidden ? '' : 'Original context summary',
        canCompactContext: false,
        mobileViewport: false,
        activeRun: { status: 'RUNNING' },
        canInterrupt: true,
        interruptVisible: true,
        inputHasContent: true,
        hasSelectedCommand: false,
        loading: false,
        attachmentsPending: true,
        effortLabel: (value: string) => value
      });
      const send = /<button\b(?=[^>]*class="[^"]*\bcomposer-send-button\b)[^>]*>/u.exec(html)?.[0];
      const stop = /<button\b(?=[^>]*class="[^"]*\bcomposer-stop-button\b)[^>]*>/u.exec(html)?.[0];
      expect(send).toBeDefined();
      expect(send).toMatch(/\sdisabled(?:[\s=>])/u);
      expect(stop).toBeDefined();
      expect(stop).not.toMatch(/\sdisabled(?:[\s=>])/u);
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
      }
      expect(html).toContain(
        locale === 'zh-CN'
          ? 'Enter 排队 · Ctrl + Enter 插入消息'
          : 'Enter to queue · Ctrl + Enter to steer'
      );
      expect(i18n.global.t('generated.composerToolbar.enterToSendShiftAltEnterFor')).toBe(
        locale === 'zh-CN'
          ? 'Enter 发送 · Shift/Alt + Enter 换行'
          : 'Enter to send · Shift/Alt + Enter for a new line'
      );
    }
  );

  it('renders the shared input without a legacy external-session overlay', async () => {
    const html = await render(ConversationComposer, {
      input: 'Raw user input',
      placeholder: 'Original placeholder',
      working: true,
      workingLabel: 'Original working status',
      readonly: true,
      dropTarget: false,
      mobileViewport: false,
      commandStates: [],
      loading: false,
      skillTokens: []
    });
    expect(html).toContain('Raw user input');
    expect(html).toMatch(
      /class="composer-working"[^>]*>.*Original working status.*class="composer-shell readonly has-working"/su
    );
    expect(html).toMatch(/<textarea[^>]*readonly/u);
    expect(html).not.toContain('composer-takeover');
    expect(html).not.toMatch(/generated\.|composer\.removeSkill|composer\.skillUnavailableToken/u);
  });
});
