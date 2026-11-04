import { describe, expect, it, vi } from 'vitest';
import { effectScope, ref, watch } from 'vue';
import { createWorkspaceSessionPaneLifecycle } from '../../src/service/workspace-session-pane-loader.js';
import { createConversationScrollService } from '../../src/service/conversation-scroll-service.js';
import type { DraftTarget } from '../../src/service/session-draft-service.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('secondary session Pane lifecycle', () => {
  it('preserves the same visible session reading position and follow intent while positioning a different target', async () => {
    const target = ref<DraftTarget>({
      kind: 'session',
      nodeId: 'n',
      workspaceId: 'w',
      sessionId: 'a'
    });
    const visible = ref(false);
    const element = {
      scrollHeight: 1000,
      scrollTop: 0,
      clientHeight: 200,
      ownerDocument: { elementFromPoint: () => null },
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 200 }),
      contains: () => false
    } as unknown as HTMLElement;
    const scroll = createConversationScrollService();
    scroll.setElement(element);
    let cached = false;
    const scope = effectScope();
    const lifecycle = scope.run(() =>
      createWorkspaceSessionPaneLifecycle({
        target,
        visible,
        loading: ref(false),
        loadingContent: ref(false),
        failed: ref(false),
        currentRequest: () => 0,
        loader: {
          load: vi.fn().mockResolvedValue({
            session: { id: 'a', workspaceId: 'w', runner: 'codex' },
            changed: true
          })
        },
        restore: () => cached,
        save: () => {
          cached = true;
        },
        cancel: vi.fn(),
        stopWatch: vi.fn(),
        beginInitialRender: async () => {},
        scrollElement: () => scroll.element.value,
        scrollLatest: async () => {
          scroll.scrollToLatest();
        },
        markRead: vi.fn(),
        notice: vi.fn()
      })
    )!;
    visible.value = true;
    await lifecycle.reload();
    expect(element.scrollTop).toBe(1000);
    element.scrollTop = 300;
    scroll.handleScroll(vi.fn());
    expect(scroll.following.value).toBe(false);
    visible.value = false;
    visible.value = true;
    await lifecycle.reload();
    expect(element.scrollTop).toBe(300);
    expect(scroll.following.value).toBe(false);

    visible.value = false;
    target.value = { kind: 'session', nodeId: 'n', workspaceId: 'w', sessionId: 'b' };
    target.value = { kind: 'session', nodeId: 'n', workspaceId: 'w', sessionId: 'a' };
    visible.value = true;
    await lifecycle.reload();
    expect(element.scrollTop).toBe(1000);
    expect(scroll.following.value).toBe(true);

    scroll.scrollToLatest();
    visible.value = false;
    visible.value = true;
    await lifecycle.reload();
    const restoreAnchor = scroll.captureRenderAnchor();
    Object.defineProperty(element, 'scrollHeight', { value: 1200, configurable: true });
    restoreAnchor();
    expect(scroll.following.value).toBe(true);
    expect(element.scrollTop).toBe(1200);

    element.scrollTop = 300;
    scroll.handleScroll(vi.fn());
    target.value = { kind: 'session', nodeId: 'n', workspaceId: 'w', sessionId: 'b' };
    await lifecycle.reload();
    expect(element.scrollTop).toBe(1200);
    expect(scroll.following.value).toBe(true);
    visible.value = false;
    const remounted = { ...element, scrollTop: 0 } as HTMLElement;
    scroll.setElement(remounted);
    visible.value = true;
    await lifecycle.reload();
    expect(remounted.scrollTop).toBe(1200);
    scope.stop();
  });

  it('invalidates a pending read after an A → B → A target change', async () => {
    const target = ref<DraftTarget>({
      kind: 'session',
      nodeId: 'n',
      workspaceId: 'a',
      sessionId: 'same'
    });
    const visible = ref(true);
    const first = deferred<never>();
    const markRead = vi.fn();
    const scroll = vi.fn();
    const notice = vi.fn();
    const scope = effectScope();
    let revision = 0;
    let current!: () => boolean;
    scope.run(() => {
      watch(
        target,
        () => {
          revision += 1;
        },
        { flush: 'sync' }
      );
      createWorkspaceSessionPaneLifecycle({
        target,
        visible,
        loading: ref(false),
        loadingContent: ref(false),
        failed: ref(false),
        currentRequest: () => revision,
        loader: {
          load: vi.fn((input) => {
            current = input.isCurrent;
            return first.promise;
          })
        },
        restore: () => false,
        save: vi.fn(),
        cancel: vi.fn(),
        stopWatch: vi.fn(),
        beginInitialRender: async () => {},
        scrollElement: () => undefined,
        scrollLatest: scroll,
        markRead,
        notice
      });
    });
    const oldCurrent = current;
    target.value = { ...target.value, workspaceId: 'b' };
    target.value = { ...target.value, workspaceId: 'a' };
    expect(oldCurrent()).toBe(false);
    scope.stop();
    first.resolve(undefined as never);
    await first.promise;
    await Promise.resolve();
    expect(scroll).not.toHaveBeenCalled();
    expect(markRead).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
  });

  it('does not scroll or mark read when disposed during initial rendering', async () => {
    const target = ref<DraftTarget>({
      kind: 'session',
      nodeId: 'n',
      workspaceId: 'w',
      sessionId: 's'
    });
    const render = deferred<void>();
    const scroll = vi.fn();
    const markRead = vi.fn();
    const cancel = vi.fn();
    const notice = vi.fn();
    const scope = effectScope();
    scope.run(() =>
      createWorkspaceSessionPaneLifecycle({
        target,
        visible: ref(true),
        loading: ref(false),
        loadingContent: ref(false),
        failed: ref(false),
        currentRequest: () => 0,
        loader: {
          load: vi.fn().mockResolvedValue({
            session: { id: 's', workspaceId: 'w', runner: 'codex' },
            changed: true
          })
        },
        restore: () => false,
        save: vi.fn(),
        cancel,
        stopWatch: vi.fn(),
        beginInitialRender: () => render.promise,
        scrollElement: () => undefined,
        scrollLatest: scroll,
        markRead,
        notice
      })
    );
    await Promise.resolve();
    scope.stop();
    render.resolve();
    await render.promise;
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(scroll).not.toHaveBeenCalled();
    expect(markRead).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
  });

  it.each(['target change', 'scope disposal'])(
    'invalidates in-flight positioning after %s',
    async (action) => {
      const target = ref<DraftTarget>({
        kind: 'session',
        nodeId: 'n',
        workspaceId: 'w',
        sessionId: 'a'
      });
      const gate = deferred<void>();
      const positioned = vi.fn();
      const scope = effectScope();
      const lifecycle = scope.run(() =>
        createWorkspaceSessionPaneLifecycle({
          target,
          visible: ref(true),
          loading: ref(false),
          loadingContent: ref(false),
          failed: ref(false),
          currentRequest: () => 0,
          loader: {
            load: vi.fn().mockResolvedValue({
              session: { id: 'a', workspaceId: 'w', runner: 'codex' },
              changed: true
            })
          },
          restore: () => false,
          save: vi.fn(),
          cancel: vi.fn(),
          stopWatch: vi.fn(),
          beginInitialRender: async () => {},
          scrollElement: () => undefined,
          scrollLatest: async (isCurrent) => {
            await gate.promise;
            if (isCurrent()) positioned();
          },
          markRead: vi.fn(),
          notice: vi.fn()
        })
      )!;
      const old = lifecycle.reload();
      await Promise.resolve();
      await Promise.resolve();
      if (action === 'target change')
        target.value = { kind: 'session', nodeId: 'n', workspaceId: 'w', sessionId: 'b' };
      else scope.stop();
      gate.resolve();
      await old;
      if (action === 'target change') {
        await lifecycle.reload();
        expect(positioned).toHaveBeenCalledOnce();
      } else expect(positioned).not.toHaveBeenCalled();
      scope.stop();
    }
  );
});
