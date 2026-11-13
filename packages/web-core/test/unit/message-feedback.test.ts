import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, nextTick, type Component, type VNode } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { clearMessages, showMessage } from '../../src/service/message-feedback-service.js';
import { translate } from '../../src/service/locale-preference-service.js';
import { AuthenticationContextChangedError } from '../../src/service/workbench-http-service.js';

const feedback = vi.hoisted(() => {
  const handlers = {
    success: { close: vi.fn() },
    info: { close: vi.fn() },
    warning: { close: vi.fn() },
    error: { close: vi.fn() }
  };
  return {
    handlers,
    success: vi.fn((_options: unknown) => handlers.success),
    info: vi.fn((_options: unknown) => handlers.info),
    warning: vi.fn((_options: unknown) => handlers.warning),
    error: vi.fn((_options: unknown) => handlers.error),
    closeAll: vi.fn()
  };
});

vi.mock('element-plus', () => ({
  ElMessage: {
    success: feedback.success,
    info: feedback.info,
    warning: feedback.warning,
    error: feedback.error,
    closeAll: feedback.closeAll
  }
}));

interface MessageOptions {
  readonly message: () => VNode;
  readonly icon: Component;
  readonly showClose: boolean;
  readonly grouping: boolean;
  readonly duration: number;
  readonly appendTo?: unknown;
  readonly onClose: () => void;
}

function optionsFor(
  type: 'success' | 'info' | 'warning' | 'error',
  callIndex = feedback[type].mock.calls.length - 1
): MessageOptions {
  return feedback[type].mock.calls[callIndex]![0] as MessageOptions;
}

function messageText(options: MessageOptions): string {
  const children = options.message().children as VNode[];
  return children[0]!.children as string;
}

beforeEach(() => vi.clearAllMocks());

describe('Message feedback service', () => {
  it('waits for a closing dialog to unmount before choosing the message owner', async () => {
    const dialog = { ownerDocument: { body: {} } };
    let focusedDialog: unknown = dialog;
    vi.stubGlobal('document', {
      activeElement: { closest: () => focusedDialog }
    });
    vi.stubGlobal(
      'MutationObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
    try {
      // Model the pending DOM flush caused by setting the dialog v-if to false.
      void nextTick(() => {
        focusedDialog = undefined;
      });
      showMessage('Settings saved', 'success');
      await nextTick();
      expect(optionsFor('success').appendTo).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('clears pending old feedback before rendering feedback from the next identity', async () => {
    showMessage('Old identity result', 'error');
    clearMessages();
    showMessage('New identity result', 'info');
    await nextTick();
    const lastClear = feedback.closeAll.mock.invocationCallOrder.at(-1)!;
    expect(feedback.error.mock.invocationCallOrder[0]).toBeLessThan(lastClear);
    expect(feedback.info.mock.invocationCallOrder[0]).toBeGreaterThan(lastClear);
  });

  it('ignores blank text without opening a message', async () => {
    for (const message of ['', ' \t\n ']) showMessage(message, 'info');
    await nextTick();

    expect(feedback.info).not.toHaveBeenCalled();
    expect(feedback.success).not.toHaveBeenCalled();
    expect(feedback.warning).not.toHaveBeenCalled();
    expect(feedback.error).not.toHaveBeenCalled();
  });

  it('suppresses stale authentication-context errors by their type', async () => {
    const cause = new AuthenticationContextChangedError();

    expect(cause.name).toBe('AbortError');
    showMessage('The authentication context changed.', 'error', cause);
    await nextTick();

    expect(feedback.error).not.toHaveBeenCalled();
  });

  it('still shows ordinary errors, AbortErrors, and timeouts', async () => {
    const failures = [
      ['An ordinary error.', new Error('An ordinary error.')],
      [
        'The authentication context changed.',
        new DOMException('The authentication context changed.', 'AbortError')
      ],
      ['The request timed out.', new DOMException('The request timed out.', 'TimeoutError')]
    ] as const;

    for (const [message, cause] of failures) showMessage(message, 'error', cause);
    await nextTick();

    expect(feedback.error).toHaveBeenCalledTimes(failures.length);
    expect(
      feedback.error.mock.calls.map(([options]) => messageText(options as MessageOptions))
    ).toEqual(failures.map(([message]) => message));
  });

  it('uses the explicit severity, matching MAR icon, and severity duration', async () => {
    for (const [type, duration] of [
      ['success', 3_000],
      ['info', 3_000],
      ['warning', 6_000],
      ['error', 6_000]
    ] as const) {
      for (const message of [
        `Explicit ${type}; success, info, warning, and error are only words.`,
        'The request failed.\nCode: MODEL_UNAVAILABLE\nRequest ID: req-feedback-test',
        'x'.repeat(181)
      ]) {
        showMessage(message, type);
        await nextTick();
        const options = optionsFor(type);

        expect(options).toMatchObject({ showClose: false, grouping: false, duration });
        expect(messageText(options)).toBe(message);
        const iconHtml = await renderToString(createSSRApp(options.icon));
        expect(iconHtml).toContain(`data-mar-icon="${type}"`);
      }
    }
  });

  it('closes dialog-owned feedback after its dialog is removed and disconnects its observer', async () => {
    let dialogConnected = true;
    let observerCallback: (() => void) | undefined;
    const body = {};
    const dialog = {
      get isConnected() {
        return dialogConnected;
      },
      ownerDocument: { body }
    };
    const observer = { observe: vi.fn(), disconnect: vi.fn() };
    vi.stubGlobal('document', {
      activeElement: { closest: vi.fn(() => dialog) }
    });
    vi.stubGlobal(
      'MutationObserver',
      class {
        constructor(callback: MutationCallback) {
          observerCallback = () => callback([], this as unknown as MutationObserver);
        }
        observe = observer.observe;
        disconnect = observer.disconnect;
      }
    );

    try {
      showMessage('Dialog-owned feedback', 'error');
      await nextTick();
      const options = optionsFor('error');

      expect(options.appendTo).toBe(dialog);
      expect(observer.observe).toHaveBeenCalledWith(body, { childList: true, subtree: true });
      observerCallback?.();
      expect(feedback.handlers.error.close).not.toHaveBeenCalled();

      dialogConnected = false;
      observerCallback?.();
      expect(feedback.handlers.error.close).toHaveBeenCalledOnce();

      options.onClose();
      expect(observer.disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps repeated identical feedback as distinct messages', async () => {
    showMessage('The request failed.', 'error');
    await nextTick();
    showMessage('The request failed.', 'error');
    await nextTick();

    expect(feedback.error).toHaveBeenCalledTimes(2);
    for (const callIndex of [0, 1]) {
      expect(messageText(optionsFor('error', callIndex))).toBe('The request failed.');
      expect(optionsFor('error', callIndex).grouping).toBe(false);
    }
  });

  it('renders multiline and overlong feedback as safe text with automatic and manual closing', async () => {
    const multiline = '<img src=x>\nSecond line';
    showMessage(multiline, 'info');
    await nextTick();
    showMessage('x'.repeat(181), 'success');
    await nextTick();
    showMessage('x'.repeat(180), 'success');
    await nextTick();

    const multilineOptions = optionsFor('info');
    const multilineVNode = multilineOptions.message();
    const children = multilineVNode.children as VNode[];
    const text = children[0]!;
    const close = children[1]!;
    const html = await renderToString(createSSRApp({ render: () => multilineVNode }));

    expect(multilineOptions.duration).toBe(3_000);
    expect(text.type).toBe('span');
    expect(text.props).toMatchObject({ class: 'mar-message-text' });
    expect(text.children).toBe(multiline);
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toContain('<img src=x>');
    expect(close.type).toBe('button');
    expect(close.props).toMatchObject({
      type: 'button',
      class: 'el-message__closeBtn mar-message-close mar-icon-action',
      title: translate('common.close'),
      'aria-label': translate('common.close')
    });
    expect(multilineOptions.showClose).toBe(false);
    expect(typeof close.props?.['onClick']).toBe('function');
    (close.props?.['onClick'] as () => void)();
    expect(feedback.handlers.info.close).toHaveBeenCalledOnce();
    expect(messageText(optionsFor('success', 0))).toBe('x'.repeat(181));
    expect(optionsFor('success', 0).duration).toBe(3_000);
    expect(messageText(optionsFor('success', 1))).toBe('x'.repeat(180));
    expect(optionsFor('success').duration).toBe(3_000);
  });

  it('clears all Element Plus messages', async () => {
    clearMessages();

    expect(feedback.closeAll).toHaveBeenCalledOnce();
    await nextTick();
    expect(feedback.closeAll).toHaveBeenCalledTimes(2);
  });
});
