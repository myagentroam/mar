import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, reactive, ref } from 'vue';
import Tabs from '../../src/view/workspace/WorkspaceFileTabs.vue?unit-render';
import DiffPage from '../../src/view/workspace/WorkspaceGitDiffPage.vue?unit-render';
import type { WorkspaceFileTab } from '../../src/util/workspace-file-tab.js';
import { consoleKeyboardShortcutService } from '../../src/service/ConsoleKeyboardShortcutService.js';
import { renderComponent, flushComponent, trigger } from './support/component-renderer.js';

const viewerHandle = vi.hoisted(() => ({
  focus: vi.fn(),
  openFind: vi.fn(() => true),
  selectAll: vi.fn(() => true),
  toggleEdit: vi.fn(() => 'CHANGED' as const),
  canClose: vi.fn(async () => true)
}));
vi.mock('../../src/view/workspace/GitDiffViewer.vue?unit-render', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      props: ['diff', 'loading', 'loadFailed'],
      emits: ['retry'],
      setup(props, { emit, expose }) {
        expose(viewerHandle);
        return () =>
          h('diff-viewer', { ...props }, [h('button', { onClick: () => emit('retry') }, 'Retry')]);
      }
    })
  };
});
const tab = (id: number): WorkspaceFileTab => ({
  id,
  identity: String(id),
  kind: 'WORKTREE_TEXT',
  nodeId: 'node',
  workspaceId: 'workspace',
  path: `${id}.ts`,
  fileName: `${id}.ts`,
  repositoryPath: '',
  worktreePath: ''
});

beforeEach(() => {
  vi.clearAllMocks();
  const classList = { add: vi.fn(), remove: vi.fn() };
  vi.stubGlobal('HTMLElement', class {});
  vi.stubGlobal('document', {
    documentElement: { classList },
    body: { classList },
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => []
  });
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Workspace file page behavior', () => {
  it.each(['CHANGED', 'UNAVAILABLE'] as const)(
    'consumes Ctrl/Cmd+E only for an active page returning %s',
    async (result) => {
      const handles = [1, 2].map(() => ({
        focus: vi.fn(),
        openFind: () => false,
        selectAll: () => false,
        toggleEdit: vi.fn(() => result),
        canClose: async () => true
      }));
      const view = renderComponent(
        Tabs,
        { tabs: [tab(1), tab(2)], activeTabId: 2 },
        {
          default: ({
            tab: item,
            registerPageHandle
          }: {
            tab: WorkspaceFileTab;
            registerPageHandle: (value: unknown) => void;
          }) => {
            registerPageHandle(handles[item.id - 1]);
            return h('p', item.fileName);
          }
        }
      );
      try {
        const root = view.findAll('section')[0]!;
        Object.assign(root, {
          contains: (target: unknown) => target === root,
          getClientRects: () => [],
          querySelectorAll: () => []
        });
        await flushComponent();
        for (const control of [true, false]) {
          const event = Object.assign(new Event('keydown', { cancelable: true }), {
            key: 'e',
            ctrlKey: control,
            metaKey: !control,
            altKey: false,
            shiftKey: false
          });
          Object.defineProperty(event, 'target', { value: root });
          consoleKeyboardShortcutService.handle(event as KeyboardEvent);
          expect(event.defaultPrevented).toBe(result === 'CHANGED');
        }
        expect(handles[0]!.toggleEdit).not.toHaveBeenCalled();
        expect(handles[1]!.toggleEdit).toHaveBeenCalledTimes(2);
      } finally {
        view.unmount();
      }
    }
  );

  it('rejects stale Diff results, retries failures, and aborts outstanding work on unmount', async () => {
    const pending: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
    const load = vi.fn(
      (_tab: WorkspaceFileTab, _signal?: AbortSignal) =>
        new Promise((resolve, reject) => pending.push({ resolve, reject }))
    );
    const loadError = vi.fn();
    const props = reactive({
      tab: { ...tab(1), kind: 'WORKTREE_DIFF' as const },
      active: false,
      load,
      onLoadError: loadError
    });
    const view = renderComponent(DiffPage, props);
    try {
      expect(view.findAll('diff-viewer')[0]!.props.loading).toBe(true);
      props.tab = { ...props.tab, identity: 'second' };
      await flushComponent();
      expect(load.mock.calls[0]![1]!.aborted).toBe(true);
      pending[0]!.resolve({ obsolete: true });
      await flushComponent();
      expect(view.findAll('diff-viewer')[0]!.props.diff).toBeUndefined();
      const failure = new Error('Diff unavailable');
      pending[1]!.reject(failure);
      await flushComponent();
      expect(loadError).toHaveBeenCalledWith(failure);
      expect(view.findAll('diff-viewer')[0]!.props.loadFailed).toBe(true);
      await trigger(view.findAll('button')[0]!, 'onClick');
      expect(view.findAll('diff-viewer')[0]!.props.loadFailed).toBe(false);
      pending[2]!.resolve({ current: true });
      await flushComponent();
      expect(view.findAll('diff-viewer')[0]!.props.diff).toEqual({ current: true });
      props.tab = { ...props.tab, identity: 'third' };
      await flushComponent();
    } finally {
      view.unmount();
    }
    expect(load.mock.calls.at(-1)![1]!.aborted).toBe(true);
    pending.at(-1)!.resolve({ late: true });
    await flushComponent();
    expect(loadError).toHaveBeenCalledOnce();
  });

  it('forwards the public Diff page editing and navigation handles to its viewer', async () => {
    const handle = ref<typeof viewerHandle>();
    const view = renderComponent(DiffPage, {
      ref: handle,
      tab: { ...tab(1), kind: 'WORKTREE_DIFF' },
      active: false,
      load: async () => ({ current: true })
    });
    try {
      await flushComponent();
      handle.value!.focus();
      expect(viewerHandle.focus).toHaveBeenCalledOnce();
      expect(handle.value!.openFind()).toBe(true);
      expect(handle.value!.selectAll()).toBe(true);
      expect(handle.value!.toggleEdit()).toBe('CHANGED');
      expect(await handle.value!.canClose()).toBe(true);
    } finally {
      view.unmount();
    }
  });
});
