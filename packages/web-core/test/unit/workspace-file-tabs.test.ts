import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRenderer,
  createSSRApp,
  h,
  ref,
  ssrContextKey,
  type Component,
  type VNode
} from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import { createConsoleKeyboardShortcutService } from '../../src/service/ConsoleKeyboardShortcutService.js';
import { createFilePreviewWindowInteractionService } from '../../src/service/FilePreviewWindowInteractionService.js';
import {
  createStandaloneFileWindowService,
  standaloneFileOpenIntent
} from '../../src/service/StandaloneFileWindowService.js';
import { createWorkspaceFileTabService } from '../../src/service/WorkspaceFileTabService.js';
import { createWorkspaceFileNavigationHistoryService } from '../../src/service/WorkspaceFileNavigationHistoryService.js';
import { i18n } from '../../src/service/LocalePreferenceService.js';
import WorkspaceFileTabs from '../../src/view/workspace/WorkspaceFileTabs.vue';
import { navigationTargetAtTextPosition } from '../../src/util/code-navigation-target.js';

function worktree(path: string) {
  return {
    kind: 'WORKTREE_TEXT' as const,
    nodeId: 'node-1',
    workspaceId: 'workspace-1',
    repositoryPath: '',
    worktreePath: '',
    path
  };
}

const mountedApps: { unmount(): void }[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  vi.unstubAllGlobals();
});

function mountTabs(
  options: { unmountedTabId?: number; canCloseUnmountedTab?: (id: number) => Promise<boolean> } = {}
) {
  class HostNode {
    constructor(readonly type: string) {}
    contains() {
      return false;
    }
    getClientRects() {
      return [];
    }
    querySelectorAll() {
      return [];
    }
  }
  vi.stubGlobal('HTMLElement', HostNode);
  vi.stubGlobal('Node', HostNode);
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
  const classList = { add: vi.fn(), remove: vi.fn() };
  vi.stubGlobal('document', {
    documentElement: { classList },
    body: { classList },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelector: () => null,
    querySelectorAll: () => []
  });
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  });
  const tabs = ref([1, 2].map((id) => ({ ...worktree(`src/${id}.ts`), id, identity: String(id) })));
  const handles = [1, 2].map(() => ({
    focus: vi.fn(),
    openFind: () => false,
    selectAll: () => false,
    toggleEdit: () => 'UNAVAILABLE' as const,
    canClose: vi.fn(async () => true),
    prepareForConfirmedClose: vi.fn()
  }));
  const frame = ref<{
    requestClose(id: number): Promise<boolean>;
    requestCloseAll(): Promise<boolean>;
  }>();
  const close = vi.fn();
  const closeAll = vi.fn();
  const closeLast = vi.fn();
  const headlessFrame = { ...WorkspaceFileTabs, render: () => null } as unknown as Component;
  const app = renderer.createApp({
    render: () =>
      h(headlessFrame, {
        ref: frame,
        tabs: tabs.value,
        activeTabId: 2,
        canCloseUnmountedTab: options.canCloseUnmountedTab,
        onClose: close,
        onCloseAll: closeAll,
        onCloseLast: closeLast,
        onVnodeMounted: (vnode: VNode) => {
          const setup = (
            vnode.component as unknown as {
              setupState: { registerPageHandle(id: number, handle: unknown): void };
            }
          ).setupState;
          handles.forEach((handle, index) => {
            if (index + 1 !== options.unmountedTabId) setup.registerPageHandle(index + 1, handle);
          });
        }
      })
  });
  app.use(i18n);
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.mount(new HostNode('root'));
  mountedApps.push(app);
  return { frame: frame.value!, tabs, handles, close, closeAll, closeLast };
}

describe('Workspace file tab service', () => {
  it('separates Git current files from same-name Workspace files and preserves their targets', () => {
    const tabs = createWorkspaceFileTabService();
    const ordinary = tabs.open(worktree('same.txt'));
    const git = tabs.open({ ...worktree('same.txt'), gitFile: true });
    expect(git.id).not.toBe(ordinary.id);
    const snapshot = tabs.snapshot();
    tabs.clear();
    tabs.restore(snapshot);
    expect(tabs.tabs.value.find((tab) => tab.id === git.id)?.gitFile).toBe(true);
    expect(
      standaloneFileOpenIntent(
        'https://example.test/console?standaloneFile=1&nodeId=n&workspaceId=w&path=same.txt&repositoryPath='
      )?.repositoryPath
    ).toBe('');
    expect(
      standaloneFileOpenIntent(
        'https://example.test/console?standaloneFile=1&nodeId=n&workspaceId=w&path=same.txt&worktreePath=%2Fother'
      )?.worktreePath
    ).toBe('/other');
  });
  it('deduplicates by source-aware identity and updates navigation targets', () => {
    const service = createWorkspaceFileTabService();
    const first = service.open({ ...worktree('src/main.ts'), targetLine: 2 });
    const reopened = service.open({ ...worktree('src/main.ts'), targetLine: 9, targetColumn: 4 });
    const diff = service.open({ ...worktree('src/main.ts'), kind: 'WORKTREE_DIFF' });

    expect(reopened.id).toBe(first.id);
    expect(service.tabs.value).toHaveLength(2);
    expect(service.tabs.value[0]).toMatchObject({ targetLine: 9, targetColumn: 4 });
    expect(diff.identity).not.toBe(first.identity);
  });

  it('keeps metadata-only snapshots and restores the active identity', () => {
    const service = createWorkspaceFileTabService();
    const first = service.open(worktree('src/a.ts'));
    const second = service.open(worktree('src/b.ts'));
    service.activate(first.id);
    const snapshot = service.snapshot();

    const restored = createWorkspaceFileTabService();
    restored.restore(snapshot);

    expect(restored.tabs.value.map((tab) => tab.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(restored.activeTab.value?.identity).toBe(first.identity);
    expect(restored.open(worktree('src/c.ts')).id).toBeGreaterThan(second.id);
  });

  it('falls back to the last restored tab when the active identity is missing', () => {
    const service = createWorkspaceFileTabService();
    const first = service.open(worktree('src/a.ts'));
    const second = service.open(worktree('src/b.ts'));

    service.restore({ tabs: [first, second], activeIdentity: 'missing' });

    expect(service.activeTabId.value).toBe(second.id);
    expect(service.activeTab.value?.identity).toBe(second.identity);
  });
});

describe('Workspace file navigation history', () => {
  it('replays positions across tabs and within one file, preserving edits to the current cursor', () => {
    const history = createWorkspaceFileNavigationHistoryService();
    history.record({ tabId: 1, line: 4, column: 7 }, { tabId: 2, line: 9, column: 2 });
    history.record({ tabId: 2, line: 10, column: 3 }, { tabId: 2, line: 28, column: 1 });
    expect(history.travel(-1, { tabId: 2, line: 30, column: 4 })).toEqual({
      tabId: 2,
      line: 10,
      column: 3
    });
    expect(history.travel(-1, { tabId: 2, line: 11, column: 2 })).toEqual({
      tabId: 1,
      line: 4,
      column: 7
    });
    expect(history.travel(1, { tabId: 1, line: 5, column: 8 })).toEqual({
      tabId: 2,
      line: 11,
      column: 2
    });
    expect(history.travel(1, { tabId: 2, line: 12, column: 1 })).toEqual({
      tabId: 2,
      line: 30,
      column: 4
    });
  });

  it('discards the forward branch after a new jump and never returns to a closed tab', () => {
    const history = createWorkspaceFileNavigationHistoryService();
    history.record({ tabId: 1, line: 1 }, { tabId: 2, line: 3 });
    history.record({ tabId: 2, line: 4 }, { tabId: 3, line: 8 });
    expect(history.travel(-1, { tabId: 3, line: 9 })).toMatchObject({ tabId: 2 });
    history.record({ tabId: 2, line: 5 }, { tabId: 4, line: 7 });
    expect(history.canTravel(1)).toBe(false);
    history.remove(2);
    expect(history.travel(-1, { tabId: 4, line: 8 })).toEqual({ tabId: 1, line: 1 });
    history.remove(4);
    expect(history.canTravel(1)).toBe(false);
    history.clear();
    expect(history.canTravel(-1)).toBe(false);
  });
});

describe('Code navigation targets', () => {
  it('prioritizes a parsed file reference and falls back to an identifier', () => {
    const source =
      'import { target } from "./definition.js";\nimport { management } from "@myagentroam/web-core/management";\ntarget();';
    expect(
      navigationTargetAtTextPosition('src/main.ts', source, source.indexOf('./definition.js') + 5)
    ).toMatchObject({ kind: 'reference', reference: { value: './definition.js' } });
    expect(
      navigationTargetAtTextPosition('src/main.ts', "import value from './other.js'", 22)
    ).toMatchObject({ kind: 'reference', reference: { value: './other.js' } });
    expect(navigationTargetAtTextPosition('src/main.ts', 'const target = value;', 7)).toMatchObject(
      {
        kind: 'symbol',
        value: 'target',
        from: 6,
        to: 12
      }
    );
    expect(navigationTargetAtTextPosition('styles/theme.css', '.main-color {}', 7)).toMatchObject({
      kind: 'symbol',
      value: 'main-color'
    });
    expect(navigationTargetAtTextPosition('src/main.ts', 'left-right', 7)).toMatchObject({
      kind: 'symbol',
      value: 'right'
    });
  });
});

describe('File preview window interaction', () => {
  function fixture(mobile = false, deferredBack = false) {
    type Listener = (event: KeyboardEvent | PopStateEvent) => void;
    const listeners = new Map<string, Set<Listener>>();
    const traversals: (() => void)[] = [];
    let active = true;
    let overlay = false;
    const closeWindow = vi.fn(async () => true);
    const closeTab = vi.fn(async () => true);
    const originalState = { route: 'console' };
    const entries: unknown[] = [originalState];
    let index = 0;
    const history = {
      get state() {
        return entries[index];
      },
      pushState: vi.fn((value: unknown) => {
        entries.splice(index + 1);
        entries.push(value);
        index += 1;
      }),
      replaceState: vi.fn((value: unknown) => {
        entries[index] = value;
      }),
      back: vi.fn(() => {
        const traverse = () => {
          if (index === 0) return;
          index -= 1;
          for (const listener of [...(listeners.get('popstate') ?? [])])
            listener({ state: entries[index] } as PopStateEvent);
        };
        if (deferredBack) traversals.push(traverse);
        else traverse();
      })
    };
    vi.stubGlobal('document', {
      querySelectorAll: () => [{ getClientRects: () => (overlay ? [{}] : []) }]
    });
    vi.stubGlobal('window', {
      history,
      location: { href: 'http://fixture.test/workspace' },
      matchMedia: () => ({
        matches: mobile,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }),
      addEventListener: (type: string, listener: Listener) => {
        const registered = listeners.get(type) ?? new Set<Listener>();
        registered.add(listener);
        listeners.set(type, registered);
      },
      removeEventListener: (type: string, listener: Listener) => {
        const registered = listeners.get(type);
        registered?.delete(listener);
        if (registered?.size === 0) listeners.delete(type);
      }
    });
    const service = createFilePreviewWindowInteractionService({
      isOpen: () => active,
      closeWindow,
      closeTab
    });
    service.mount();
    mountedApps.push({
      unmount: () => {
        service.dispose();
        while (traversals.length > 0) traversals.shift()?.();
      }
    });
    return {
      service,
      closeWindow,
      closeTab,
      history,
      entries,
      originalState,
      listeners,
      flushBack: () => traversals.shift()?.(),
      deactivate: () => {
        active = false;
      },
      showOverlay: () => {
        overlay = true;
      },
      hideOverlay: () => {
        overlay = false;
      }
    };
  }

  function keyEvent(key: string, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent {
    return {
      key,
      code: key.toLowerCase() === 'w' ? 'KeyW' : key,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      defaultPrevented: false,
      isComposing: false,
      repeat: false,
      keyCode: 0,
      composedPath: () => [],
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...modifiers
    } as unknown as KeyboardEvent;
  }

  it.each([{ altKey: true }, { ctrlKey: true }])(
    'closes one tab or the whole window with %j',
    async (modifiers) => {
      const f = fixture();
      expect(f.service.handleShortcut(keyEvent('w', modifiers))).toBe('HANDLED');
      await Promise.resolve();
      expect(f.closeTab).toHaveBeenCalledOnce();
      expect(f.closeWindow).not.toHaveBeenCalled();
      expect(f.service.handleShortcut(keyEvent('W', { ...modifiers, shiftKey: true }))).toBe(
        'HANDLED'
      );
      await Promise.resolve();
      expect(f.closeWindow).toHaveBeenCalledOnce();
    }
  );

  it('closes the window with an unhandled Escape but leaves local panels and IME alone', () => {
    const f = fixture();
    for (const modifiers of [{ defaultPrevented: true }, { isComposing: true }, { keyCode: 229 }])
      f.service.handleEscape(keyEvent('Escape', modifiers));
    expect(f.closeWindow).not.toHaveBeenCalled();
    const event = keyEvent('Escape');
    f.service.handleEscape(event);
    expect(f.closeWindow).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('does not leak repeated or modal close combinations to Workspace shortcuts', () => {
    const f = fixture();
    expect(f.service.handleShortcut(keyEvent('w', { altKey: true, repeat: true }))).toBe('HANDLED');
    f.showOverlay();
    expect(f.service.handleShortcut(keyEvent('w', { ctrlKey: true }))).toBe('HANDLED');
    f.service.handleEscape(keyEvent('Escape'));
    expect(f.closeTab).not.toHaveBeenCalled();
    expect(f.closeWindow).not.toHaveBeenCalled();
  });

  it('ignores unsupported modifiers, composing input and inactive windows', () => {
    const f = fixture();
    for (const modifiers of [
      {},
      { metaKey: true },
      { ctrlKey: true, altKey: true },
      { altKey: true, isComposing: true }
    ])
      expect(f.service.handleShortcut(keyEvent('w', modifiers))).toBe('IGNORED');
    f.deactivate();
    expect(f.service.handleShortcut(keyEvent('w', { altKey: true }))).toBe('IGNORED');
    f.service.handleEscape(keyEvent('Escape'));
    expect(f.closeWindow).not.toHaveBeenCalled();
  });

  it('does not close the file window when a child dialog disappears during the same Escape', () => {
    const f = fixture();
    class OverlayElement {
      readonly nodeType = 1;
      matches() {
        return true;
      }
    }
    // A same-origin iframe still has a different Element constructor.
    vi.stubGlobal('Element', class {});
    f.showOverlay();
    const event = keyEvent('Escape', {
      composedPath: () => [new OverlayElement()] as unknown as EventTarget[]
    });
    expect(f.service.handleShortcut(event)).toBe('IGNORED');
    f.hideOverlay();
    f.service.handleEscape(event);
    expect(f.closeWindow).not.toHaveBeenCalled();
    f.service.handleEscape(keyEvent('Escape'));
    expect(f.closeWindow).toHaveBeenCalledOnce();
  });

  it('ignores retained hidden dialogs and consumes a frame close key with cleanup', async () => {
    const f = fixture();
    const documentListeners = new Map<string, (event: KeyboardEvent) => void>();
    const windowListeners = new Map<string, (event: KeyboardEvent) => void>();
    const frame = {
      contentDocument: {
        addEventListener: (type: string, listener: (event: KeyboardEvent) => void) =>
          documentListeners.set(type, listener),
        removeEventListener: (type: string) => documentListeners.delete(type),
        defaultView: {
          addEventListener: (type: string, listener: (event: KeyboardEvent) => void) =>
            windowListeners.set(type, listener),
          removeEventListener: (type: string) => windowListeners.delete(type)
        }
      }
    } as unknown as HTMLIFrameElement;
    f.service.bindFrame(frame);
    const event = keyEvent('w', { altKey: true });
    documentListeners.get('keydown')!(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(f.closeTab).toHaveBeenCalledOnce();
    await Promise.resolve();
    windowListeners.get('keydown')!(keyEvent('Escape'));
    expect(f.closeWindow).toHaveBeenCalledOnce();
    f.service.dispose();
    expect(documentListeners.size).toBe(0);
    expect(windowListeners.size).toBe(0);
  });

  it('does not access keyboard events in an isolated frame', () => {
    const f = fixture();
    const frame = {
      get contentDocument() {
        throw new Error('SecurityError');
      }
    } as unknown as HTMLIFrameElement;
    expect(() => f.service.bindFrame(frame)).not.toThrow();
    expect(f.closeWindow).not.toHaveBeenCalled();
  });

  it('closes the whole window on mobile Back and releases its single history entry', async () => {
    const f = fixture(true);
    expect(f.entries).toHaveLength(2);
    f.history.back();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.closeWindow).toHaveBeenCalledOnce();
    expect(f.closeTab).not.toHaveBeenCalled();
    expect(f.history.state).toEqual(f.originalState);
    expect(f.listeners.has('popstate')).toBe(false);
  });

  it('restores mobile Back after cancellation and serializes repeated returns', async () => {
    const f = fixture(true);
    let resolve!: (value: boolean) => void;
    f.closeWindow.mockImplementationOnce(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        })
    );
    f.history.back();
    f.history.back();
    await vi.waitFor(() => expect(f.closeWindow).toHaveBeenCalledOnce());
    expect(f.entries).toHaveLength(2);
    resolve(false);
    await Promise.resolve();
    await Promise.resolve();
    f.history.back();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.closeWindow).toHaveBeenCalledTimes(2);
    expect(f.history.state).toEqual(f.originalState);
  });

  it('releases mobile Back on explicit disposal without another close and never intercepts desktop Back', () => {
    const f = fixture(true);
    f.service.dispose();
    expect(f.history.state).toEqual(f.originalState);
    expect(f.closeWindow).not.toHaveBeenCalled();
    const desktop = fixture();
    expect(desktop.history.pushState).not.toHaveBeenCalled();
    expect(desktop.listeners.has('popstate')).toBe(false);
  });

  it('does not treat asynchronous cleanup from a previous window as Back in a newly mounted window', async () => {
    const f = fixture(true, true);
    f.service.dispose();
    const closeWindow = vi.fn(async () => true);
    const next = createFilePreviewWindowInteractionService({
      isOpen: () => true,
      closeWindow,
      closeTab: vi.fn(async () => true)
    });
    next.mount();
    mountedApps.push({ unmount: next.dispose });
    f.flushBack();
    await Promise.resolve();
    await Promise.resolve();
    expect(closeWindow).not.toHaveBeenCalled();
    expect(f.entries).toHaveLength(2);
    expect(f.history.state).not.toEqual(f.originalState);
    f.history.back();
    f.flushBack();
    await Promise.resolve();
    await Promise.resolve();
    expect(closeWindow).toHaveBeenCalledOnce();
    f.flushBack();
    expect(f.history.state).toEqual(f.originalState);
    expect(f.listeners.has('popstate')).toBe(false);
  });

  it('does not reinstall Back for a new window disposed before previous cleanup finishes', async () => {
    const f = fixture(true, true);
    f.service.dispose();
    const next = createFilePreviewWindowInteractionService({
      isOpen: () => true,
      closeWindow: vi.fn(async () => true),
      closeTab: vi.fn(async () => true)
    });
    next.mount();
    next.dispose();
    f.flushBack();
    await Promise.resolve();
    expect(f.history.state).toEqual(f.originalState);
    expect(f.history.back).toHaveBeenCalledOnce();
    expect(f.history.pushState).toHaveBeenCalledOnce();
    expect(f.listeners.has('popstate')).toBe(false);
  });
});

describe('Workspace file tabs frame', () => {
  it('keeps every tab when an unmounted page cancels cached-draft confirmation', async () => {
    const canCloseUnmountedTab = vi.fn(async () => false);
    const state = mountTabs({ unmountedTabId: 1, canCloseUnmountedTab });
    await state.frame.requestCloseAll();
    expect(canCloseUnmountedTab).toHaveBeenCalledExactlyOnceWith(1);
    expect(state.closeAll).not.toHaveBeenCalled();
    expect(state.closeLast).not.toHaveBeenCalled();
    for (const handle of state.handles)
      expect(handle.prepareForConfirmedClose).not.toHaveBeenCalled();
    canCloseUnmountedTab.mockResolvedValueOnce(true);
    await state.frame.requestCloseAll();
    expect(state.handles[0]!.canClose).not.toHaveBeenCalled();
    expect(state.handles[1]!.canClose).toHaveBeenCalledOnce();
    expect(state.closeAll).toHaveBeenCalledExactlyOnceWith([1, 2]);
  });

  it('also confirms cached drafts when closing an unmounted tab individually', async () => {
    const canCloseUnmountedTab = vi.fn(async () => false);
    const state = mountTabs({ unmountedTabId: 1, canCloseUnmountedTab });
    await state.frame.requestClose(1);
    expect(canCloseUnmountedTab).toHaveBeenCalledExactlyOnceWith(1);
    expect(state.close).not.toHaveBeenCalled();
    canCloseUnmountedTab.mockResolvedValueOnce(true);
    await state.frame.requestClose(1);
    expect(state.close).toHaveBeenCalledExactlyOnceWith(1);
    expect(state.closeLast).not.toHaveBeenCalled();
  });

  it('closes only the requested tab through its page confirmation', async () => {
    const state = mountTabs();
    await state.frame.requestClose(2);
    expect(state.handles[0]!.canClose).not.toHaveBeenCalled();
    expect(state.handles[1]!.canClose).toHaveBeenCalledOnce();
    expect(state.close).toHaveBeenCalledExactlyOnceWith(2);
    expect(state.closeAll).not.toHaveBeenCalled();
    expect(state.closeLast).not.toHaveBeenCalled();
  });

  it('confirms every page before closing the whole file window once', async () => {
    const state = mountTabs();
    for (const handle of state.handles) {
      handle.canClose.mockImplementation(async () => {
        expect(state.closeAll).not.toHaveBeenCalled();
        for (const page of state.handles)
          expect(page.prepareForConfirmedClose).not.toHaveBeenCalled();
        return true;
      });
    }
    await state.frame.requestCloseAll();
    for (const handle of state.handles) {
      expect(handle.canClose).toHaveBeenCalledOnce();
      expect(handle.prepareForConfirmedClose).toHaveBeenCalledOnce();
    }
    expect(state.close).not.toHaveBeenCalled();
    expect(state.closeAll).toHaveBeenCalledExactlyOnceWith([1, 2]);
    expect(state.closeLast).toHaveBeenCalledOnce();
  });

  it('keeps all tabs and unload protection when any page cancels', async () => {
    const state = mountTabs();
    state.handles[1]!.canClose.mockResolvedValueOnce(false);
    await state.frame.requestCloseAll();
    expect(state.closeAll).not.toHaveBeenCalled();
    expect(state.close).not.toHaveBeenCalled();
    expect(state.closeLast).not.toHaveBeenCalled();
    for (const handle of state.handles)
      expect(handle.prepareForConfirmedClose).not.toHaveBeenCalled();
    await state.frame.requestCloseAll();
    expect(state.closeAll).toHaveBeenCalledExactlyOnceWith([1, 2]);
  });

  it('does not duplicate confirmation or close a tab while a window close is pending', async () => {
    const state = mountTabs();
    let confirm!: (value: boolean) => void;
    state.handles[0]!.canClose.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        })
    );
    const pending = state.frame.requestCloseAll();
    await state.frame.requestCloseAll();
    await state.frame.requestClose(2);
    expect(state.handles[0]!.canClose).toHaveBeenCalledOnce();
    expect(state.handles[1]!.canClose).not.toHaveBeenCalled();
    confirm(true);
    await pending;
    expect(state.closeAll).toHaveBeenCalledOnce();
    expect(state.close).not.toHaveBeenCalled();
  });

  it('abandons a pending window close when the tab set changes', async () => {
    const state = mountTabs();
    state.handles[1]!.canClose.mockImplementationOnce(async () => {
      state.tabs.value = [];
      return true;
    });
    await state.frame.requestCloseAll();
    expect(state.closeAll).not.toHaveBeenCalled();
    expect(state.closeLast).not.toHaveBeenCalled();
    for (const handle of state.handles)
      expect(handle.prepareForConfirmedClose).not.toHaveBeenCalled();
  });

  it('renders source-aware tabs with an active item and close action', async () => {
    const app = createSSRApp({
      render: () =>
        h(
          WorkspaceFileTabs,
          {
            tabs: [
              { ...worktree('src/main.ts'), id: 1, identity: 'one' },
              { ...worktree('src/diff.ts'), kind: 'WORKTREE_DIFF', id: 2, identity: 'two' }
            ],
            activeTabId: 2
          },
          { default: () => h('p', 'page') }
        )
    });
    app.use(i18n);
    app.use(ElementPlus);
    app.directive('tooltip', { getSSRProps: () => ({}) });
    app.provide(ID_INJECTION_KEY, { prefix: 40, current: 0 });
    app.provide(ZINDEX_INJECTION_KEY, { current: 0 });

    const html = await renderToString(app);

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('src/main.ts');
    expect(html).toContain('src/diff.ts');
    const buttonClasses = Array.from(
      html.matchAll(/<button\b[^>]*\bclass="([^"]*)"/gu),
      ([, classes]) => classes!.split(/\s+/u)
    );
    expect(
      buttonClasses.filter((classes) => classes.includes('workspace-file-tab-close'))
    ).toHaveLength(2);
    expect(
      buttonClasses.filter((classes) => classes.includes('workspace-file-window-close'))
    ).toHaveLength(1);
    expect(html).toContain(i18n.global.t('filePreviewDialog.closeFileWindow'));
    expect(html).toContain('aria-label=');
    expect(html).toContain('page');
  });
});

describe('Console keyboard shortcut service', () => {
  it('prevents defaults only for the first target that handles the event', () => {
    const service = createConsoleKeyboardShortcutService();
    const calls: string[] = [];
    service.register({
      priority: 1,
      handle() {
        calls.push('low');
        return 'HANDLED';
      }
    });
    service.register({
      priority: 2,
      handle() {
        calls.push('high');
        return 'HANDLED';
      }
    });
    const event = keyboardEvent();

    service.handle(event);

    expect(calls).toEqual(['high']);
    expect(event.prevented).toBe(true);
  });

  it('leaves browser behavior intact when all targets ignore the event', () => {
    const service = createConsoleKeyboardShortcutService();
    service.register({ priority: 1, handle: () => 'IGNORED' });
    const event = keyboardEvent();

    service.handle(event);

    expect(event.prevented).toBe(false);
  });
});

describe('Standalone file window service', () => {
  it.each([
    ['/console?standaloneFile=1&path=main.ts', 'mar-file-preview'],
    ['/console?standaloneFile=1&markdownPreview=1&path=README.md', 'mar-markdown-preview'],
    ['/console?standaloneFile=1&htmlPreview=1&path=index.html', 'mar-html-preview']
  ])('opens %s directly within the installed app and reuses the companion window', (url, name) => {
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({ matches: true }))
    });
    try {
      const replace = vi.fn();
      const dispatchEvent = vi.fn((event: Event) => {
        event.preventDefault();
        return false;
      });
      const popup = {
        closed: false,
        opener: {} as Window,
        location: { replace },
        focus: vi.fn(),
        dispatchEvent
      } as unknown as Window;
      const openWindow = vi.fn(() => popup);
      const service = createStandaloneFileWindowService(openWindow);

      expect(service.open(url)).toBe(popup);
      expect(openWindow).toHaveBeenCalledWith(url, name);
      expect(replace).not.toHaveBeenCalled();
      expect(dispatchEvent).not.toHaveBeenCalled();
      expect(popup.opener).toBeNull();

      service.open(url);
      expect(openWindow).toHaveBeenCalledOnce();
      expect(dispatchEvent).toHaveBeenCalledOnce();
      expect(replace).not.toHaveBeenCalled();
      expect(popup.focus).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the blank-window navigation when opened from a browser', () => {
    const matchMedia = vi.fn(() => ({ matches: false }));
    vi.stubGlobal('window', { matchMedia });
    try {
      const replace = vi.fn();
      const popup = {
        opener: {} as Window,
        location: { replace },
        focus: vi.fn(),
        dispatchEvent: vi.fn(() => true)
      } as unknown as Window;
      const openWindow = vi.fn(() => popup);

      createStandaloneFileWindowService(openWindow).open('/console?standaloneFile=1&path=main.ts');

      expect(matchMedia).toHaveBeenCalledWith('(display-mode: standalone)');
      expect(openWindow).toHaveBeenCalledWith('', 'mar-file-preview');
      expect(replace).toHaveBeenCalledWith('/console?standaloneFile=1&path=main.ts');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not navigate a blocked popup from an installed app', () => {
    vi.stubGlobal('window', { matchMedia: vi.fn(() => ({ matches: true })) });
    try {
      const openWindow = vi.fn(() => null);
      expect(
        createStandaloneFileWindowService(openWindow).open('/console?standaloneFile=1')
      ).toBeUndefined();
      expect(openWindow).toHaveBeenCalledWith('/console?standaloneFile=1', 'mar-file-preview');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the stable companion window name and replaces its URL', () => {
    const replace = vi.fn();
    const focus = vi.fn();
    const dispatchEvent = vi.fn(() => true);
    const popup = {
      opener: {} as Window,
      location: { replace },
      focus,
      dispatchEvent
    } as unknown as Window;
    const openWindow = vi.fn(() => popup);

    const result = createStandaloneFileWindowService(openWindow).open('/console?standaloneFile=1');

    expect(openWindow).toHaveBeenCalledWith('', 'mar-file-preview');
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(popup.opener).toBeNull();
    expect(replace).toHaveBeenCalledWith('/console?standaloneFile=1');
    expect(focus).toHaveBeenCalledOnce();
    expect(result).toBe(popup);
  });

  it('reports a blocked popup without trying to navigate it', () => {
    expect(createStandaloneFileWindowService(() => null).open('/console')).toBeUndefined();
  });

  it('uses a separate named window for executable HTML previews', () => {
    const popup = {
      closed: false,
      opener: null,
      location: { replace: vi.fn() },
      focus: vi.fn(),
      dispatchEvent: vi.fn(() => true)
    } as unknown as Window;
    const openWindow = vi.fn(() => popup);
    const service = createStandaloneFileWindowService(openWindow);
    service.open('/console?standaloneFile=1&htmlPreview=1&path=index.html');
    service.open('/console?standaloneFile=1&htmlPreview=1&path=other.html');
    expect(openWindow).toHaveBeenCalledOnce();
    expect(openWindow).toHaveBeenCalledWith('', 'mar-html-preview');
    expect(
      standaloneFileOpenIntent(
        '/console?standaloneFile=1&htmlPreview=1&nodeId=node-a&workspaceId=workspace-a&path=index.html'
      )
    ).toBeUndefined();
  });

  it('lets an existing Console consume the file intent without reloading', () => {
    const replace = vi.fn();
    const popup = {
      opener: {} as Window,
      location: { replace },
      focus: vi.fn(),
      dispatchEvent: vi.fn((event: Event) => {
        event.preventDefault();
        return false;
      })
    } as unknown as Window;

    createStandaloneFileWindowService(() => popup).open(
      '/console?standaloneFile=1&nodeId=node-a&workspaceId=workspace-a&path=src/main.ts'
    );

    expect(replace).not.toHaveBeenCalled();
  });

  it('reuses the live file window without reopening its named target', () => {
    const replace = vi.fn();
    const popup = {
      closed: false,
      opener: {} as Window,
      location: { replace },
      focus: vi.fn(),
      dispatchEvent: vi.fn((event: Event) => {
        if (event instanceof CustomEvent && event.detail.url.includes('other.ts')) {
          event.preventDefault();
          return false;
        }
        return true;
      })
    } as unknown as Window;
    const openWindow = vi.fn(() => popup);
    const service = createStandaloneFileWindowService(openWindow);

    service.open('/console?standaloneFile=1&path=main.ts');
    service.open('/console?standaloneFile=1&path=other.ts');

    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledOnce();
    expect(popup.dispatchEvent).toHaveBeenCalledTimes(2);
  });

  it('parses ordinary Workspace file intents and standard Git Diff tab intents', () => {
    expect(
      standaloneFileOpenIntent(
        '/console?standaloneFile=1&nodeId=node-a&workspaceId=workspace-a&path=src/main.ts&line=3'
      )
    ).toEqual({
      nodeId: 'node-a',
      workspaceId: 'workspace-a',
      path: 'src/main.ts',
      line: 3
    });
    expect(
      standaloneFileOpenIntent(
        '/console?standaloneFile=1&markdownPreview=1&nodeId=node-a&workspaceId=workspace-a&path=README.md'
      )
    ).toBeUndefined();
    expect(
      standaloneFileOpenIntent(
        '/console?standaloneFile=1&nodeId=node-a&workspaceId=workspace-a&path=notes%2Flinked.tmp&worktreePath=%2Fsrv%2Fworktrees%2Flinked'
      )
    ).toEqual({
      nodeId: 'node-a',
      workspaceId: 'workspace-a',
      path: 'notes/linked.tmp',
      worktreePath: '/srv/worktrees/linked'
    });
    expect(
      standaloneFileOpenIntent(
        '/console?standaloneFile=1&nodeId=node-a&workspaceId=workspace-a&fileTabKind=HISTORY_DIFF&path=src%2Fmain.ts&repositoryPath=packages%2Fchild&commit=abc123&previousPath=src%2Fold.ts&refs=refs%2Fheads%2Fmain&paths=src%2Fmain.ts'
      )
    ).toEqual({
      nodeId: 'node-a',
      workspaceId: 'workspace-a',
      path: 'src/main.ts',
      tab: {
        kind: 'HISTORY_DIFF',
        nodeId: 'node-a',
        workspaceId: 'workspace-a',
        path: 'src/main.ts',
        repositoryPath: 'packages/child',
        worktreePath: '',
        commit: 'abc123',
        previousPath: 'src/old.ts',
        refs: ['refs/heads/main'],
        paths: ['src/main.ts']
      }
    });
  });

  it('keeps rendered Markdown in a separate companion window', () => {
    const replace = vi.fn();
    const popup = {
      opener: {} as Window,
      location: { replace },
      focus: vi.fn()
    } as unknown as Window;
    const openWindow = vi.fn(() => popup);

    createStandaloneFileWindowService(openWindow).open(
      '/console?standaloneFile=1&markdownPreview=1'
    );

    expect(openWindow).toHaveBeenCalledWith('', 'mar-markdown-preview');
  });

  it('opens Git Diff tab intents in the standard file preview companion window', () => {
    const popup = {
      opener: {} as Window,
      location: { replace: vi.fn() },
      focus: vi.fn(),
      dispatchEvent: vi.fn(() => true)
    } as unknown as Window;
    const openWindow = vi.fn(() => popup);

    createStandaloneFileWindowService(openWindow).open(
      '/console?standaloneFile=1&fileTabKind=WORKTREE_DIFF'
    );

    expect(openWindow).toHaveBeenCalledWith('', 'mar-file-preview');
    expect(popup.opener).toBeNull();
  });
});

function keyboardEvent(): KeyboardEvent & { prevented: boolean } {
  const event = {
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
    stopPropagation() {}
  };
  return event as unknown as KeyboardEvent & { prevented: boolean };
}
