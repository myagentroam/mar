import { workspaceTargetRef } from './support/workspace-fixture.js';
import { ref, type Ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchPageInteractionService } from '../../src/service/workbench-page-interaction-service.js';
import { createConsoleKeyboardShortcutService } from '../../src/service/console-keyboard-shortcut-service.js';
import type { WorkspaceInspectorHandle } from '../../src/service/workbench-surface-state-service.js';
import type { NodeSummary, WorkspaceTab } from '../../src/model/workbench.js';

function fixture() {
  const view = ref<'nodes' | 'settings'>('nodes');
  const workspaceTabs = ref<WorkspaceTab[]>([
    {
      id: 'node-1:workspace-1',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      label: 'One',
      lastActiveAt: 1
    },
    {
      id: 'node-1:workspace-2',
      nodeId: 'node-1',
      workspaceId: 'workspace-2',
      label: 'Two',
      lastActiveAt: 2
    },
    {
      id: 'node-2:workspace-3',
      nodeId: 'node-2',
      workspaceId: 'workspace-3',
      label: 'Three',
      lastActiveAt: 3
    }
  ]);
  const activeWorkspaceTabId = ref<string | undefined>('node-1:workspace-1');
  const activateWorkspaceTab = vi.fn(async () => undefined);
  const closeWorkspaceTab = vi.fn();
  const closeUnpinnedWorkspaceTabs = vi.fn();
  const openNewSessionComposer = vi.fn();
  const openFile = vi.fn(async () => undefined);
  const openWorkspaceFileComparison = vi.fn(async () => undefined);
  const openWorkspaceFileExternal = vi.fn();
  const openAttachmentImage = vi.fn(async () => undefined);
  const workspaceInspector = ref<WorkspaceInspectorHandle | null>({
    openFile,
    openWorkspaceFileTab: vi.fn(),
    openWorkspaceFile: vi.fn(async () => undefined),
    openWorkspaceFileComparison,
    openWorkspaceFileExternal,
    openCurrentRenderedPreview: vi.fn(() => false),
    revealAndOpenWorkspaceFile: vi.fn(async () => undefined),
    openChanges: vi.fn(),
    openSearch: vi.fn(),
    refreshVisibleSection: vi.fn(),
    snapshot: vi.fn(() => undefined),
    restore: vi.fn(),
    restoreWorkspace: vi.fn()
  });
  const notice = vi.fn();
  const quickOpenFileVisible = ref(false);
  const selectedWorkspaceId = ref<string | undefined>('workspace-1');
  const nodeReady = ref(true);
  const nodes = ref([{ id: 'node-1', connected: true, disabled: false }]) as unknown as Ref<
    NodeSummary[]
  >;
  const service = createWorkbenchPageInteractionService({
    view,
    nodes,
    workspaceTabs,
    activeWorkspaceTabId,
    activateWorkspaceTab,
    closeWorkspaceTab,
    closeUnpinnedWorkspaceTabs,
    workspaceTarget: workspaceTargetRef(ref('node-1'), selectedWorkspaceId),
    selectedWorkspace: ref({
      path: '/workspace',
      kind: 'GIT_WORKSPACE'
    }) as never,
    nodeReady,
    openNewSessionComposer,
    filesReady: ref(true),
    contentSearchReady: ref(true),
    terminalReady: ref(true),
    quickOpenFileVisible,
    workspaceInspector,
    openAttachmentImage,
    toggleTerminal: vi.fn(),
    sessionActivityClockNow: ref(0),
    notice,
    formatSessionTime: (value: number) => String(value)
  });
  return {
    service,
    nodes,
    quickOpenFileVisible,
    view,
    workspaceTabs,
    activeWorkspaceTabId,
    activateWorkspaceTab,
    closeWorkspaceTab,
    closeUnpinnedWorkspaceTabs,
    openNewSessionComposer,
    selectedWorkspaceId,
    nodeReady,
    workspaceInspector,
    notice,
    openFile,
    openWorkspaceFileComparison,
    openWorkspaceFileExternal,
    openAttachmentImage
  };
}

describe('Workbench page file interaction', () => {
  it('opens image attachments in the shared dialog but preserves file and modified-click navigation', () => {
    const state = fixture();
    const image = {
      name: 'photo.png',
      mime: 'image/png',
      path: '.mar/temp-files/session/photo.png'
    };
    state.service.openAgentWorkspaceFile(image.path, undefined, undefined, false, image);
    expect(state.openAttachmentImage).toHaveBeenCalledWith(image);
    expect(state.workspaceInspector.value?.openWorkspaceFile).not.toHaveBeenCalled();
    state.service.openAgentWorkspaceFile(image.path, undefined, undefined, true, image);
    expect(state.openWorkspaceFileExternal).toHaveBeenCalled();
    expect(state.openAttachmentImage).toHaveBeenCalledTimes(1);
    state.service.openAgentWorkspaceFile('src/main.ts');
    expect(state.openWorkspaceFileComparison).toHaveBeenCalledWith(
      'src/main.ts',
      undefined,
      undefined
    );
  });
  beforeEach(() => {
    vi.stubGlobal('Element', class {});
    vi.stubGlobal('HTMLElement', class {});
    vi.stubGlobal('document', { activeElement: null });
  });
  afterEach(() => vi.unstubAllGlobals());

  function focusedTarget(...selectors: string[]) {
    class Target {
      closest(pattern: string) {
        return pattern.split(',').some((selector) => selectors.includes(selector.trim()))
          ? this
          : null;
      }
    }
    vi.stubGlobal('Element', Target);
    return new Target();
  }

  it.each([false, true])('cycles visible tabs with Ctrl+Tab (reverse: %s)', (shiftKey) => {
    const f = fixture();
    expect(
      f.service.onGlobalKeydown({ key: 'Tab', ctrlKey: true, shiftKey } as KeyboardEvent)
    ).toBe('HANDLED');
    expect(f.activateWorkspaceTab).toHaveBeenLastCalledWith(
      f.workspaceTabs.value[shiftKey ? 2 : 1]
    );
    f.activeWorkspaceTabId.value = 'node-2:workspace-3';
    expect(
      f.service.onGlobalKeydown({ key: 'Tab', ctrlKey: true, shiftKey: false } as KeyboardEvent)
    ).toBe('HANDLED');
    expect(f.activateWorkspaceTab).toHaveBeenLastCalledWith(f.workspaceTabs.value[0]);
  });

  it.each([
    { key: 'ArrowLeft', altKey: true, index: 2 },
    { key: 'ArrowRight', altKey: true, index: 1 },
    { key: 'Tab', ctrlKey: true, index: 1 },
    { key: 'Tab', ctrlKey: true, shiftKey: true, index: 2 },
    { key: '2', code: 'Digit2', ctrlKey: true, index: 1 },
    { key: 'n', code: 'KeyN', altKey: true, action: 'new' },
    { key: 'n', code: 'KeyN', ctrlKey: true, action: 'new' },
    { key: 'w', ctrlKey: true, action: 'close' },
    { key: 'w', altKey: true, action: 'close' },
    { key: 'w', ctrlKey: true, shiftKey: true, action: 'closeAll' },
    { key: 'w', altKey: true, shiftKey: true, action: 'closeAll' }
  ])('handles Workspace shortcuts in Composer: $key $action', (shortcut) => {
    const f = fixture();
    const target = focusedTarget('textarea', '.composer-host');
    const shortcuts = createConsoleKeyboardShortcutService();
    shortcuts.register({ priority: 0, handle: f.service.onGlobalKeydown });
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    shortcuts.handle({
      ...shortcut,
      target,
      preventDefault,
      stopPropagation
    } as unknown as KeyboardEvent);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    if ('index' in shortcut)
      expect(f.activateWorkspaceTab).toHaveBeenCalledWith(f.workspaceTabs.value[shortcut.index!]);
    if (shortcut.action === 'new') expect(f.openNewSessionComposer).toHaveBeenCalledOnce();
    if (shortcut.action === 'close')
      expect(f.closeWorkspaceTab).toHaveBeenCalledWith(f.workspaceTabs.value[0]);
    if (shortcut.action === 'closeAll') expect(f.closeUnpinnedWorkspaceTabs).toHaveBeenCalledOnce();
  });

  it.each([false, true])('consumes pinned Composer close shortcuts (bulk: %s)', (shiftKey) => {
    const f = fixture();
    f.workspaceTabs.value = [{ ...f.workspaceTabs.value[0]!, pinned: true }];
    const target = focusedTarget('textarea', '.composer-host');
    for (const modifier of [{ ctrlKey: true }, { altKey: true }]) {
      for (const repeat of [false, true]) {
        expect(
          f.service.onGlobalKeydown({
            key: 'w',
            ...modifier,
            shiftKey,
            repeat,
            target
          } as unknown as KeyboardEvent)
        ).toBe('HANDLED');
      }
    }
    expect(f.closeWorkspaceTab).not.toHaveBeenCalled();
    expect(f.closeUnpinnedWorkspaceTabs).toHaveBeenCalledTimes(shiftKey ? 2 : 0);
  });

  it.each([false, true])(
    'consumes single-tab and repeated Ctrl+Tab in Composer (pinned: %s)',
    (pinned) => {
      const f = fixture();
      const target = focusedTarget('textarea', '.composer-host');
      for (const tabs of [f.workspaceTabs.value, [{ ...f.workspaceTabs.value[0]!, pinned }]]) {
        f.workspaceTabs.value = tabs;
        for (const shiftKey of [false, true]) {
          const shortcuts = createConsoleKeyboardShortcutService();
          shortcuts.register({ priority: 0, handle: f.service.onGlobalKeydown });
          const preventDefault = vi.fn();
          shortcuts.handle({
            key: 'Tab',
            ctrlKey: true,
            shiftKey,
            repeat: tabs.length > 1,
            target,
            preventDefault,
            stopPropagation: vi.fn()
          } as unknown as KeyboardEvent);
          expect(preventDefault).toHaveBeenCalledOnce();
        }
      }
      expect(f.activateWorkspaceTab).not.toHaveBeenCalled();
    }
  );

  it.each(['.terminal-dock', '.el-overlay', '.el-popper', '.el-select', '[role="dialog"]'])(
    'keeps %s ownership even inside Composer',
    (selector) => {
      const f = fixture();
      const target = focusedTarget('textarea', '.composer-host', selector);
      for (const shortcut of [
        { key: 'w', ctrlKey: true },
        { key: 'Tab', ctrlKey: true },
        { key: '2', ctrlKey: true },
        { key: 'ArrowRight', altKey: true },
        { key: 'n', altKey: true },
        { key: 'n', ctrlKey: true }
      ]) {
        expect(f.service.onGlobalKeydown({ ...shortcut, target } as unknown as KeyboardEvent)).toBe(
          'IGNORED'
        );
      }
      expect(f.closeWorkspaceTab).not.toHaveBeenCalled();
      expect(f.activateWorkspaceTab).not.toHaveBeenCalled();
      expect(f.openNewSessionComposer).not.toHaveBeenCalled();
    }
  );

  it('does not repurpose native Tab or unavailable Ctrl+Tab shortcuts', () => {
    const f = fixture();
    for (const extra of [
      { ctrlKey: false },
      { altKey: true },
      { metaKey: true },
      { isComposing: true },
      { keyCode: 229 },
      { defaultPrevented: true }
    ]) {
      expect(
        f.service.onGlobalKeydown({
          key: 'Tab',
          ctrlKey: true,
          ...extra
        } as unknown as KeyboardEvent)
      ).toBe('IGNORED');
    }
    f.quickOpenFileVisible.value = true;
    expect(f.service.onGlobalKeydown({ key: 'Tab', ctrlKey: true } as KeyboardEvent)).toBe(
      'IGNORED'
    );
    f.quickOpenFileVisible.value = false;
    f.activeWorkspaceTabId.value = undefined;
    expect(f.service.onGlobalKeydown({ key: 'Tab', ctrlKey: true } as KeyboardEvent)).toBe(
      'IGNORED'
    );
    f.activeWorkspaceTabId.value = 'node-1:workspace-1';
    f.workspaceTabs.value = [];
    expect(f.service.onGlobalKeydown({ key: 'Tab', ctrlKey: true } as KeyboardEvent)).toBe(
      'IGNORED'
    );
    f.view.value = 'settings';
    expect(f.service.onGlobalKeydown({ key: 'Tab', ctrlKey: true } as KeyboardEvent)).toBe(
      'IGNORED'
    );
    expect(f.activateWorkspaceTab).not.toHaveBeenCalled();
  });

  it('cycles through Workspace tabs with Alt+Arrow using their visible order and wraparound', () => {
    const f = fixture();
    const event = {
      key: 'ArrowLeft',
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      isComposing: false,
      keyCode: 37
    } as KeyboardEvent;
    expect(f.service.onGlobalKeydown(event)).toBe('HANDLED');
    expect(f.activateWorkspaceTab).toHaveBeenLastCalledWith(f.workspaceTabs.value[2]);
    f.activeWorkspaceTabId.value = 'node-2:workspace-3';
    expect(f.service.onGlobalKeydown({ ...event, key: 'ArrowRight' } as KeyboardEvent)).toBe(
      'HANDLED'
    );
    expect(f.activateWorkspaceTab).toHaveBeenLastCalledWith(f.workspaceTabs.value[0]);
  });

  it.each([
    ['ArrowLeft', false],
    ['ArrowRight', false],
    ['ArrowLeft', true],
    ['ArrowRight', true]
  ] as const)('consumes %s with a single tab (pinned: %s) without reactivation', (key, pinned) => {
    const f = fixture();
    f.workspaceTabs.value = [{ ...f.workspaceTabs.value[0]!, pinned }];
    const shortcuts = createConsoleKeyboardShortcutService();
    shortcuts.register({ priority: 0, handle: f.service.onGlobalKeydown });
    for (const repeat of [false, true]) {
      const preventDefault = vi.fn();
      const stopPropagation = vi.fn();
      shortcuts.handle({
        key,
        altKey: true,
        repeat,
        preventDefault,
        stopPropagation
      } as unknown as KeyboardEvent);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(stopPropagation).toHaveBeenCalledOnce();
    }
    expect(f.activateWorkspaceTab).not.toHaveBeenCalled();
  });

  it.each(['ArrowLeft', 'ArrowRight'])('consumes repeated %s without cycling tabs again', (key) => {
    const f = fixture();
    expect(f.service.onGlobalKeydown({ key, altKey: true, repeat: true } as KeyboardEvent)).toBe(
      'HANDLED'
    );
    expect(f.activateWorkspaceTab).not.toHaveBeenCalled();
  });

  it.each([
    ['n', 'KeyN'],
    ['1', 'Digit1']
  ])('keeps repeated Alt+%s outside the arrow shortcut handling', (key, code) => {
    const f = fixture();
    expect(
      f.service.onGlobalKeydown({ key, code, altKey: true, repeat: true } as KeyboardEvent)
    ).toBe('IGNORED');
    expect(f.openNewSessionComposer).not.toHaveBeenCalled();
    expect(f.activateWorkspaceTab).not.toHaveBeenCalled();
  });

  it('activates Workspace tabs by one-based Ctrl+number shortcuts, with zero selecting the tenth', () => {
    const f = fixture();
    const event = {
      shiftKey: false,
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      isComposing: false
    };

    expect(f.service.onGlobalKeydown({ ...event, key: '2' } as KeyboardEvent)).toBe('HANDLED');
    expect(f.activateWorkspaceTab).toHaveBeenLastCalledWith(f.workspaceTabs.value[1]);
    expect(f.service.onGlobalKeydown({ ...event, code: 'Digit1', key: '¡' } as KeyboardEvent)).toBe(
      'HANDLED'
    );
    expect(f.activateWorkspaceTab).toHaveBeenLastCalledWith(f.workspaceTabs.value[0]);
    expect(f.service.onGlobalKeydown({ ...event, key: '4' } as KeyboardEvent)).toBe('IGNORED');
    expect(f.service.onGlobalKeydown({ ...event, key: '0' } as KeyboardEvent)).toBe('IGNORED');
    f.workspaceTabs.value = Array.from({ length: 10 }, (_, index) => ({
      ...f.workspaceTabs.value[0]!,
      id: `node-1:workspace-${index + 1}`,
      workspaceId: `workspace-${index + 1}`
    }));
    expect(f.service.onGlobalKeydown({ ...event, code: 'Digit0', key: '0' } as KeyboardEvent)).toBe(
      'HANDLED'
    );
    expect(f.activateWorkspaceTab).toHaveBeenLastCalledWith(f.workspaceTabs.value[9]);
  });

  it.each([
    { shiftKey: true },
    { altKey: true },
    { metaKey: true },
    { isComposing: true },
    { keyCode: 229 },
    { defaultPrevented: true }
  ])('does not select a numbered tab for an excluded Ctrl+number event: %j', (extra) => {
    const f = fixture();
    expect(
      f.service.onGlobalKeydown({ key: '2', ctrlKey: true, ...extra } as unknown as KeyboardEvent)
    ).toBe('IGNORED');
    expect(f.activateWorkspaceTab).not.toHaveBeenCalled();
  });

  it('consumes repeated Ctrl+number without reactivating an existing tab', () => {
    const f = fixture();
    expect(
      f.service.onGlobalKeydown({ key: '2', ctrlKey: true, repeat: true } as KeyboardEvent)
    ).toBe('HANDLED');
    expect(f.activateWorkspaceTab).not.toHaveBeenCalled();
    expect(
      f.service.onGlobalKeydown({ key: '0', ctrlKey: true, repeat: true } as KeyboardEvent)
    ).toBe('IGNORED');
  });

  it.each(['input', 'textarea', 'select', '[contenteditable]:not([contenteditable="false"])'])(
    'preserves %s behavior for Ctrl+number outside Composer',
    (selector) => {
      const f = fixture();
      const target = focusedTarget(selector);
      expect(
        f.service.onGlobalKeydown({ key: '2', ctrlKey: true, target } as unknown as KeyboardEvent)
      ).toBe('IGNORED');
      expect(f.activateWorkspaceTab).not.toHaveBeenCalled();
    }
  );

  it('no longer selects numbered Workspace tabs with Alt+number', () => {
    const f = fixture();
    expect(f.service.onGlobalKeydown({ key: '2', altKey: true } as KeyboardEvent)).toBe('IGNORED');
    expect(f.activateWorkspaceTab).not.toHaveBeenCalled();
  });

  it.each(['altKey', 'ctrlKey'] as const)(
    'opens a new session with %s+N when the active Workspace is ready',
    (modifier) => {
      const f = fixture();

      expect(
        f.service.onGlobalKeydown({
          code: 'KeyN',
          key: 'ñ',
          shiftKey: false,
          metaKey: false,
          [modifier]: true,
          isComposing: false
        } as unknown as KeyboardEvent)
      ).toBe('HANDLED');
      expect(f.openNewSessionComposer).toHaveBeenCalledOnce();

      f.nodeReady.value = false;
      expect(
        f.service.onGlobalKeydown({
          code: 'KeyN',
          key: 'n',
          [modifier]: true
        } as unknown as KeyboardEvent)
      ).toBe('IGNORED');
      expect(f.openNewSessionComposer).toHaveBeenCalledOnce();
    }
  );

  it.each([
    { repeat: true },
    { shiftKey: true },
    { altKey: true },
    { metaKey: true },
    { isComposing: true },
    { keyCode: 229 },
    { defaultPrevented: true }
  ])('does not create a session for an excluded Ctrl+N event: %j', (extra) => {
    const f = fixture();
    expect(
      f.service.onGlobalKeydown({ key: 'n', ctrlKey: true, ...extra } as unknown as KeyboardEvent)
    ).toBe('IGNORED');
    expect(f.openNewSessionComposer).not.toHaveBeenCalled();
  });

  it('does not create a session with Ctrl+N outside a ready Workspace', () => {
    const f = fixture();
    const event = { key: 'n', ctrlKey: true } as KeyboardEvent;
    f.selectedWorkspaceId.value = undefined;
    expect(f.service.onGlobalKeydown(event)).toBe('IGNORED');
    f.selectedWorkspaceId.value = 'workspace-1';
    f.view.value = 'settings';
    expect(f.service.onGlobalKeydown(event)).toBe('IGNORED');
    f.view.value = 'nodes';
    f.quickOpenFileVisible.value = true;
    expect(f.service.onGlobalKeydown(event)).toBe('IGNORED');
    expect(f.openNewSessionComposer).not.toHaveBeenCalled();
  });

  it.each(['input', 'textarea', 'select', '[contenteditable]:not([contenteditable="false"])'])(
    'preserves %s behavior for Ctrl+N outside Composer',
    (selector) => {
      const f = fixture();
      const target = focusedTarget(selector);
      expect(
        f.service.onGlobalKeydown({ key: 'n', ctrlKey: true, target } as unknown as KeyboardEvent)
      ).toBe('IGNORED');
      expect(f.openNewSessionComposer).not.toHaveBeenCalled();
    }
  );

  it.each(['ArrowLeft', 'ArrowRight'])('does not enable Ctrl+%s as an Alt shortcut', (key) => {
    const f = fixture();
    expect(f.service.onGlobalKeydown({ key, ctrlKey: true } as KeyboardEvent)).toBe('IGNORED');
    expect(f.activateWorkspaceTab).not.toHaveBeenCalled();
  });

  it('leaves Shift+Tab to native focus navigation', () => {
    const f = fixture();
    expect(
      f.service.onGlobalKeydown({
        key: 'Tab',
        shiftKey: true,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        isComposing: false,
        keyCode: 9
      } as KeyboardEvent)
    ).toBe('IGNORED');
    expect(f.activateWorkspaceTab).not.toHaveBeenCalled();
  });

  it.each(['altKey', 'ctrlKey'] as const)(
    'closes the active normal tab with %s+W and leaves double Escape unchanged',
    (modifier) => {
      const f = fixture();
      const escape = { key: 'Escape', keyCode: 27 } as KeyboardEvent;
      expect(f.service.onGlobalKeydown(escape)).toBe('IGNORED');
      expect(f.service.onGlobalKeydown(escape)).toBe('IGNORED');
      expect(f.closeWorkspaceTab).not.toHaveBeenCalled();
      expect(
        f.service.onGlobalKeydown({ key: 'w', [modifier]: true } as unknown as KeyboardEvent)
      ).toBe('HANDLED');
      expect(f.closeWorkspaceTab).toHaveBeenCalledWith(f.workspaceTabs.value[0]);
      expect(f.closeUnpinnedWorkspaceTabs).not.toHaveBeenCalled();
    }
  );

  it.each(['altKey', 'ctrlKey'] as const)(
    'consumes %s+W without closing pins and delegates bulk close',
    (modifier) => {
      const f = fixture();
      f.workspaceTabs.value[0] = { ...f.workspaceTabs.value[0]!, pinned: true };
      expect(
        f.service.onGlobalKeydown({ key: 'w', [modifier]: true } as unknown as KeyboardEvent)
      ).toBe('HANDLED');
      expect(f.closeWorkspaceTab).not.toHaveBeenCalled();
      expect(
        f.service.onGlobalKeydown({
          key: 'W',
          [modifier]: true,
          shiftKey: true
        } as unknown as KeyboardEvent)
      ).toBe('HANDLED');
      expect(f.closeUnpinnedWorkspaceTabs).toHaveBeenCalledOnce();
    }
  );

  it.each(['altKey', 'ctrlKey'] as const)(
    'consumes repeated %s close keys without closing tabs again',
    (modifier) => {
      const f = fixture();
      f.workspaceTabs.value[0] = { ...f.workspaceTabs.value[0]!, pinned: true };
      for (const shiftKey of [false, true]) {
        expect(
          f.service.onGlobalKeydown({
            key: 'w',
            [modifier]: true,
            repeat: true,
            shiftKey
          } as unknown as KeyboardEvent)
        ).toBe('HANDLED');
      }
      expect(f.closeWorkspaceTab).not.toHaveBeenCalled();
      expect(f.closeUnpinnedWorkspaceTabs).not.toHaveBeenCalled();
    }
  );

  it('supports Option+W physical keys and ignores unavailable or modified closing shortcuts', () => {
    const f = fixture();
    expect(
      f.service.onGlobalKeydown({ key: '∑', code: 'KeyW', altKey: true } as KeyboardEvent)
    ).toBe('HANDLED');
    f.closeWorkspaceTab.mockClear();
    for (const extra of [
      { defaultPrevented: true },
      { isComposing: true },
      { keyCode: 229 },
      { ctrlKey: true },
      { metaKey: true }
    ]) {
      expect(
        f.service.onGlobalKeydown({ key: 'w', altKey: true, ...extra } as unknown as KeyboardEvent)
      ).toBe('IGNORED');
    }
    f.quickOpenFileVisible.value = true;
    expect(f.service.onGlobalKeydown({ key: 'w', altKey: true } as KeyboardEvent)).toBe('IGNORED');
    f.quickOpenFileVisible.value = false;
    f.view.value = 'settings';
    expect(f.service.onGlobalKeydown({ key: 'w', altKey: true } as KeyboardEvent)).toBe('IGNORED');
    f.view.value = 'nodes';
    f.workspaceTabs.value = [];
    expect(
      f.service.onGlobalKeydown({ key: 'w', altKey: true, shiftKey: true } as KeyboardEvent)
    ).toBe('IGNORED');
    expect(f.closeWorkspaceTab).not.toHaveBeenCalled();
    expect(f.closeUnpinnedWorkspaceTabs).not.toHaveBeenCalled();
  });

  it.each([
    'input',
    'textarea',
    'select',
    '[contenteditable]',
    '.terminal-dock',
    '.el-overlay',
    '[role="dialog"]'
  ])('does not close tabs while %s has focus', (selector) => {
    class Target {
      closest(pattern: string) {
        return pattern.includes(selector) ? this : null;
      }
    }
    vi.stubGlobal('Element', Target);
    const f = fixture();
    for (const shiftKey of [false, true]) {
      expect(
        f.service.onGlobalKeydown({
          key: 'w',
          altKey: true,
          shiftKey,
          target: new Target()
        } as unknown as KeyboardEvent)
      ).toBe('IGNORED');
    }
    expect(f.closeWorkspaceTab).not.toHaveBeenCalled();
    expect(f.closeUnpinnedWorkspaceTabs).not.toHaveBeenCalled();
  });

  it('opens unified Quick Open without requiring a selected Workspace file capability', () => {
    const f = fixture();
    const event = {
      key: 'o',
      shiftKey: true,
      ctrlKey: true,
      metaKey: false,
      isComposing: false
    } as KeyboardEvent;
    expect(f.service.onGlobalKeydown(event)).toBe('HANDLED');
    expect(f.quickOpenFileVisible.value).toBe(true);
  });

  it('does not open Quick Open outside Work mode or without an available Node', () => {
    const f = fixture();
    const event = { key: 'o', shiftKey: true, ctrlKey: true, metaKey: false } as KeyboardEvent;
    f.view.value = 'settings';
    expect(f.service.onGlobalKeydown(event)).toBe('IGNORED');
    f.view.value = 'nodes';
    f.nodes.value = [{ id: 'node-1', connected: false, disabled: false }] as never;
    expect(f.service.onGlobalKeydown(event)).toBe('IGNORED');
  });

  it('ignores Workspace tab shortcuts when the Workbench cannot switch tabs', () => {
    const f = fixture();
    const tabs = f.workspaceTabs.value;
    const event = {
      key: 'ArrowLeft',
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      isComposing: false,
      keyCode: 37
    } as KeyboardEvent;
    f.view.value = 'settings';
    expect(f.service.onGlobalKeydown(event)).toBe('IGNORED');
    f.view.value = 'nodes';
    f.workspaceTabs.value = [];
    expect(f.service.onGlobalKeydown(event)).toBe('IGNORED');
    f.workspaceTabs.value = tabs;
    f.activeWorkspaceTabId.value = 'missing';
    expect(f.service.onGlobalKeydown(event)).toBe('IGNORED');
    expect(f.service.onGlobalKeydown({ ...event, isComposing: true } as KeyboardEvent)).toBe(
      'IGNORED'
    );
    expect(f.activateWorkspaceTab).not.toHaveBeenCalled();
  });

  it.each([
    'input',
    'textarea',
    'select',
    '.terminal-dock',
    '.el-overlay',
    '.el-popper',
    '.el-select',
    '[role="dialog"]',
    '[contenteditable]:not([contenteditable="false"])'
  ])('does not take Workspace tab shortcuts from %s', (selector) => {
    class Target {
      closest(pattern: string) {
        return pattern
          .split(',')
          .map((value) => value.trim())
          .includes(selector)
          ? this
          : null;
      }
    }
    vi.stubGlobal('Element', Target);
    const f = fixture();
    const event = {
      key: 'ArrowRight',
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      isComposing: false,
      keyCode: 39,
      target: new Target()
    } as unknown as KeyboardEvent;
    for (const tabs of [f.workspaceTabs.value, f.workspaceTabs.value.slice(0, 1)]) {
      f.workspaceTabs.value = tabs;
      expect(f.service.onGlobalKeydown(event)).toBe('IGNORED');
      expect(f.service.onGlobalKeydown({ ...event, repeat: true } as KeyboardEvent)).toBe(
        'IGNORED'
      );
      for (const shiftKey of [false, true]) {
        expect(
          f.service.onGlobalKeydown({
            ...event,
            key: 'Tab',
            altKey: false,
            ctrlKey: true,
            shiftKey
          } as KeyboardEvent)
        ).toBe('IGNORED');
      }
    }
    expect(f.activateWorkspaceTab).not.toHaveBeenCalled();
  });
  it('prefers Git Changes for Agent file targets and preserves the file fallback arguments', () => {
    const { service, openFile, openWorkspaceFileComparison } = fixture();

    service.openAgentWorkspaceFile('/workspace/src/changed.ts', 12, 4);

    expect(openWorkspaceFileComparison).toHaveBeenCalledWith('src/changed.ts', 12, 4);
    expect(openFile).not.toHaveBeenCalled();
  });

  it('keeps Quick Open on the ordinary file preview path', () => {
    const { service, openFile, openWorkspaceFileComparison } = fixture();

    service.openQuickWorkspaceFile('src/file.ts', 8, 2);

    expect(openFile).toHaveBeenCalledWith('src/file.ts', 8, 2);
    expect(openWorkspaceFileComparison).not.toHaveBeenCalled();
  });

  it('reports an unavailable Inspector instead of opening a file while its Vue ref is null', () => {
    const f = fixture();
    f.workspaceInspector.value = null;

    expect(() => f.service.openQuickWorkspaceFile('src/file.ts')).not.toThrow();
    expect(f.openFile).not.toHaveBeenCalled();
    expect(f.notice).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  it('keeps external Agent targets out of the Git Changes path', () => {
    const { service, openWorkspaceFileComparison, openWorkspaceFileExternal } = fixture();

    service.openAgentWorkspaceFile('/workspace/src/file.md', 3, undefined, true);

    expect(openWorkspaceFileExternal).toHaveBeenCalledWith('src/file.md', 3, undefined);
    expect(openWorkspaceFileComparison).not.toHaveBeenCalled();
  });
});
