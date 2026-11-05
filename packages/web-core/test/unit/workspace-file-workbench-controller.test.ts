import { expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createWorkspaceFileTabService } from '../../src/service/workspace-file-tab-service.js';
import { filePreviewKind } from '../../src/util/file-preview.js';
import { standaloneFileOpenIntent } from '../../src/service/standalone-file-window-service.js';
import type { WorkspaceDirectFileRange } from '../../src/model/workspace-direct-file.js';

it.each([
  ['ordinary', 'file.ts', undefined, true],
  ['repository', 'file.ts', '', false],
  ['binary', 'file.txt', undefined, false]
] as const)(
  'prewarms code navigation only for an eligible %s preview',
  async (_case, path, repositoryPath, expected) => {
    const target = { nodeId: 'node', workspaceId: 'workspace' };
    const request = vi.fn(async (_url: string) => ({}));
    const http = { request } as unknown as ReturnType<typeof createScopedHttpService>;
    const bytes =
      _case === 'binary' ? new Uint8Array([65, 0, 66]) : new TextEncoder().encode('text');
    const owner = createWorkspaceFileWorkbenchController({
      externalTarget: () => target,
      fileWriteEnabled: () => true,
      onPopupBlocked: vi.fn(),
      target: () => target,
      page: () => undefined,
      prewarmEnabled: () => true,
      resolveRepositoryPath: () => undefined,
      reveal: async () => {},
      comparison: async () => undefined,
      onOpenFailure: vi.fn(),
      onRevealFailure: vi.fn(),
      preview: {
        http,
        onFailure: vi.fn(),
        onWritten: vi.fn(),
        transfers: () => ({
          directFileReadRange: async () => ({
            bytes,
            size: bytes.length,
            offset: 0,
            nextOffset: null,
            revision: 'r'
          })
        })
      },
      navigation: { http, onFileTarget: vi.fn(), onFailure: vi.fn() }
    });
    try {
      await owner.openWorkspaceFile(path, undefined, undefined, false, undefined, repositoryPath);
      expect(request.mock.calls.some(([url]) => url.includes('/symbols/prepare?'))).toBe(expected);
    } finally {
      owner.dispose();
    }
  }
);

it.each([false, true])(
  'keeps navigation per tab and cancels the inactive tab (history=%s)',
  async (history) => {
    const target = { nodeId: 'node', workspaceId: 'workspace' };
    let finish!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const definition = (path: string) => ({
      definition: {
        state: 'READY',
        targets: [{ path, line: 3 }],
        references: [],
        paths: [],
        truncated: false
      }
    });
    const request = vi.fn((url: string) =>
      url.includes('symbol=pending') ? pending : Promise.resolve(definition('target.ts'))
    );
    const http = { request } as unknown as ReturnType<typeof createScopedHttpService>;
    const bytes = new TextEncoder().encode('thing');
    const range = async () => ({
      bytes,
      size: bytes.length,
      offset: 0,
      nextOffset: null,
      revision: 'r'
    });
    const owner = createWorkspaceFileWorkbenchController({
      externalTarget: () => target,
      fileWriteEnabled: () => false,
      onPopupBlocked: vi.fn(),
      target: () => target,
      page: () => undefined,
      prewarmEnabled: () => false,
      resolveRepositoryPath: () => undefined,
      reveal: async () => {},
      comparison: async () => undefined,
      onOpenFailure: vi.fn(),
      onRevealFailure: vi.fn(),
      preview: {
        http,
        onFailure: vi.fn(),
        onWritten: vi.fn(),
        transfers: () => ({ directFileReadRange: range, directGitFileReadRange: range })
      },
      navigation: { http, onFileTarget: vi.fn(), onFailure: vi.fn() }
    });
    try {
      const intent = (path: string) => ({
        kind: history ? ('HISTORY_TEXT' as const) : ('WORKTREE_TEXT' as const),
        ...target,
        path,
        repositoryPath: '',
        worktreePath: '',
        ...(history ? { commit: 'a'.repeat(40), refs: [] } : {})
      });
      if (history) await owner.openTab(intent('first.ts'));
      else await owner.openFile('first.ts');
      const first = owner.activeTabId.value!;
      if (history) await owner.openTab(intent('second.ts'));
      else await owner.openFile('second.ts');
      const second = owner.activeTabId.value!;
      owner.activateTab(first);
      await owner.navigate({ ...target, pageId: first, path: 'first.ts' }, { symbol: 'thing' });
      const firstFrame = owner.frames.value.find((frame) => frame.id === first)!;
      expect(firstFrame.navigationTargets.value).toMatchObject([{ path: 'target.ts' }]);
      owner.activateTab(second);
      const secondFrame = owner.frames.value.find((frame) => frame.id === second)!;
      const navigating = owner.navigate(
        { ...target, pageId: second, path: 'second.ts' },
        { symbol: 'pending' }
      );
      expect(secondFrame.navigationLoading.value).toBe(true);
      owner.activateTab(first);
      expect(secondFrame.navigationLoading.value).toBe(false);
      finish(definition('late.ts'));
      await navigating;
      expect(secondFrame.navigationTargets.value).toEqual([]);
      expect(firstFrame.navigationTargets.value).toMatchObject([{ path: 'target.ts' }]);
      owner.closeTabs([second]);
      expect(owner.tabList.value.map((tab) => tab.id)).toEqual([first]);
    } finally {
      owner.dispose();
    }
  }
);

it('opens previews independently of a slow reveal and prevents its late failure from replacing the latest target', async () => {
  const target = { nodeId: 'node', workspaceId: 'workspace' };
  let rejectReveal!: (error: unknown) => void;
  const delayedReveal = new Promise<void>((_resolve, reject) => {
    rejectReveal = reject;
  });
  const reveal = vi.fn().mockReturnValueOnce(delayedReveal).mockResolvedValue(undefined);
  const onRevealFailure = vi.fn();
  const http = createScopedHttpService();
  const bytes = new TextEncoder().encode('content');
  const owner = createWorkspaceFileWorkbenchController({
    externalTarget: () => target,
    fileWriteEnabled: () => false,
    onPopupBlocked: vi.fn(),
    target: () => target,
    page: () => undefined,
    prewarmEnabled: () => false,
    resolveRepositoryPath: () => undefined,
    reveal,
    comparison: async () => undefined,
    onOpenFailure: vi.fn(),
    onRevealFailure,
    preview: {
      http,
      onFailure: vi.fn(),
      onWritten: vi.fn(),
      transfers: () => ({
        directFileReadRange: async () => ({
          bytes,
          size: bytes.length,
          offset: 0,
          nextOffset: null,
          revision: 'r'
        })
      })
    },
    navigation: { http, onFileTarget: vi.fn(), onFailure: vi.fn() }
  });
  try {
    await owner.openFile('deep/A.ts');
    await owner.openFile('deep/B.ts');
    expect(owner.tabList.value.map((tab) => tab.path)).toEqual(['deep/A.ts', 'deep/B.ts']);
    expect(owner.activeTab.value?.path).toBe('deep/B.ts');
    rejectReveal(new Error('late reveal'));
    await nextTick();
    expect(owner.activeTab.value?.path).toBe('deep/B.ts');
    expect(onRevealFailure).not.toHaveBeenCalled();
    await owner.openFile('deep/A.ts', 6, 7);
    expect(owner.activeTab.value?.path).toBe('deep/A.ts');
    const frame = owner.frames.value.find((entry) => entry.id === owner.activeTabId.value);
    expect(frame?.targetLine.value).toBe(6);
    expect(frame?.targetColumn.value).toBe(7);
  } finally {
    owner.dispose();
  }
});

it('shows an unknown-extension tab while its bounded content read is pending', async () => {
  const target = { nodeId: 'node', workspaceId: 'workspace' };
  const bytes = new TextEncoder().encode('plain text');
  let finish!: (value: WorkspaceDirectFileRange) => void;
  const pending = new Promise<WorkspaceDirectFileRange>((resolve) => {
    finish = resolve;
  });
  const read = vi.fn(() => pending);
  const http = createScopedHttpService();
  const owner = createWorkspaceFileWorkbenchController({
    externalTarget: () => target,
    fileWriteEnabled: () => true,
    onPopupBlocked: vi.fn(),
    target: () => target,
    page: () => undefined,
    prewarmEnabled: () => false,
    resolveRepositoryPath: () => undefined,
    reveal: async () => {},
    comparison: async () => undefined,
    onOpenFailure: vi.fn(),
    onRevealFailure: vi.fn(),
    preview: {
      http,
      onFailure: vi.fn(),
      onWritten: vi.fn(),
      transfers: () => ({ directFileReadRange: read })
    },
    navigation: { http, onFileTarget: vi.fn(), onFailure: vi.fn() }
  });
  try {
    const opening = owner.openFile('draft.custom');
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    expect(owner.tabList.value).toMatchObject([{ path: 'draft.custom' }]);
    expect(owner.frames.value[0]?.loading.value).toBe(true);
    finish({ bytes, size: bytes.length, offset: 0, nextOffset: null, revision: 'r' });
    await opening;
    expect(owner.frames.value[0]?.loading.value).toBe(false);
    expect(owner.frames.value[0]?.fileContent.value).toMatchObject({
      path: 'draft.custom',
      content: 'plain text'
    });
  } finally {
    owner.dispose();
  }
});

it.each(['WORKTREE_DIFF', 'HISTORY_DIFF'] as const)(
  'opens %s as a Diff without reading a raw preview',
  async (kind) => {
    const target = { nodeId: 'node', workspaceId: 'workspace' };
    const request = vi.fn();
    const http = { request } as unknown as ReturnType<typeof createScopedHttpService>;
    const owner = createWorkspaceFileWorkbenchController({
      externalTarget: () => target,
      fileWriteEnabled: () => false,
      onPopupBlocked: vi.fn(),
      target: () => target,
      page: () => undefined,
      prewarmEnabled: () => false,
      resolveRepositoryPath: () => undefined,
      reveal: async () => {},
      comparison: async () => undefined,
      onOpenFailure: vi.fn(),
      onRevealFailure: vi.fn(),
      preview: { http, onFailure: vi.fn(), onWritten: vi.fn(), transfers: () => ({}) },
      navigation: { http, onFileTarget: vi.fn(), onFailure: vi.fn() }
    });
    try {
      await owner.openTab({
        kind,
        ...target,
        path: 'notes.md',
        repositoryPath: '',
        worktreePath: '',
        ...(kind === 'HISTORY_DIFF' ? { commit: 'b'.repeat(40) } : {})
      });
      expect(owner.tabList.value).toMatchObject([{ kind, path: 'notes.md' }]);
      expect(owner.frames.value).toEqual([]);
      expect(request).not.toHaveBeenCalled();
    } finally {
      owner.dispose();
    }
  }
);

it('retains historical cursor location when opening and restoring a text tab', async () => {
  const target = { nodeId: 'node', workspaceId: 'workspace' };
  const bytes = new TextEncoder().encode('first\nsecond\nthird\n');
  const http = createScopedHttpService();
  const owner = createWorkspaceFileWorkbenchController({
    externalTarget: () => target,
    fileWriteEnabled: () => false,
    onPopupBlocked: vi.fn(),
    target: () => target,
    page: () => undefined,
    prewarmEnabled: () => false,
    resolveRepositoryPath: () => undefined,
    reveal: async () => {},
    comparison: async () => undefined,
    onOpenFailure: vi.fn(),
    onRevealFailure: vi.fn(),
    preview: {
      http,
      onFailure: vi.fn(),
      onWritten: vi.fn(),
      transfers: () => ({
        directGitFileReadRange: async () => ({
          bytes,
          size: bytes.length,
          revision: 'a'.repeat(64),
          nextOffset: null
        })
      })
    },
    navigation: { http, onFileTarget: vi.fn(), onFailure: vi.fn() }
  });
  try {
    await owner.openTab({
      kind: 'HISTORY_TEXT',
      ...target,
      path: 'src/history.ts',
      repositoryPath: '',
      worktreePath: '',
      commit: 'b'.repeat(40),
      targetLine: 3,
      targetColumn: 2
    });
    expect(owner.tabList.value).toMatchObject([{ targetLine: 3, targetColumn: 2 }]);
    expect(owner.frames.value[0]!.targetLine.value).toBe(3);
    expect(owner.frames.value[0]!.targetColumn.value).toBe(2);
    owner.restore(owner.snapshot());
    await vi.waitFor(() =>
      expect(owner.frames.value[0]?.fileContent.value?.content).toBe('first\nsecond\nthird\n')
    );
    expect(owner.frames.value[0]!.targetLine.value).toBe(3);
    expect(owner.frames.value[0]!.targetColumn.value).toBe(2);
  } finally {
    owner.dispose();
  }
});

it('keeps a Git media preview scoped to its linked worktree', async () => {
  const target = { nodeId: 'node', workspaceId: 'workspace' };
  const http = createScopedHttpService();
  const owner = createWorkspaceFileWorkbenchController({
    externalTarget: () => target,
    fileWriteEnabled: () => false,
    onPopupBlocked: vi.fn(),
    target: () => target,
    page: () => undefined,
    prewarmEnabled: () => false,
    resolveRepositoryPath: () => undefined,
    reveal: async () => {},
    comparison: async () => undefined,
    onOpenFailure: vi.fn(),
    onRevealFailure: vi.fn(),
    preview: { http, onFailure: vi.fn(), onWritten: vi.fn(), transfers: () => ({}) },
    navigation: { http, onFileTarget: vi.fn(), onFailure: vi.fn() }
  });
  try {
    await owner.openTab({
      kind: 'WORKTREE_DIFF',
      ...target,
      path: 'assets/photo.png',
      repositoryPath: '',
      worktreePath: '/repo/linked'
    });
    expect(owner.tabList.value).toMatchObject([
      { kind: 'WORKTREE_PREVIEW', worktreePath: '/repo/linked', path: 'assets/photo.png' }
    ]);
    const url = new URL(owner.frames.value[0]!.contentUrl.value!, 'http://test.local');
    expect(url.searchParams.get('worktreePath')).toBe('/repo/linked');
    expect(url.searchParams.has('repositoryPath')).toBe(false);
  } finally {
    owner.dispose();
  }
});

it.each(['WORKTREE_DIFF', 'HISTORY_TEXT'] as const)(
  'focuses a reopened %s preview and rejects invalid history sources',
  async (kind) => {
    const target = { nodeId: 'node', workspaceId: 'workspace' };
    const focusPage = vi.fn(() => true);
    const port = {
      requestCloseAll: async () => true,
      captureDirtyDrafts: () => [],
      hasPendingSave: () => false,
      cursorPosition: () => undefined,
      navigateTo: vi.fn(),
      focusPage
    };
    const http = createScopedHttpService();
    const owner = createWorkspaceFileWorkbenchController({
      externalTarget: () => target,
      fileWriteEnabled: () => false,
      onPopupBlocked: vi.fn(),
      target: () => target,
      page: () => port,
      prewarmEnabled: () => false,
      resolveRepositoryPath: () => undefined,
      reveal: async () => {},
      comparison: async () => undefined,
      onOpenFailure: vi.fn(),
      onRevealFailure: vi.fn(),
      preview: {
        http,
        onFailure: vi.fn(),
        onWritten: vi.fn(),
        transfers: () => ({
          directGitFileReadRange: async () => ({
            bytes: new Uint8Array([0]),
            size: 20,
            nextOffset: null,
            revision: 'r'
          })
        })
      },
      navigation: { http, onFileTarget: vi.fn(), onFailure: vi.fn() }
    });
    const intent = {
      kind,
      ...target,
      path: 'manual.pdf',
      repositoryPath: '',
      worktreePath: '',
      ...(kind === 'HISTORY_TEXT' ? { commit: 'b'.repeat(40), refs: ['main'] } : {})
    };
    try {
      await owner.openTab(intent);
      const tab = owner.activeTab.value!;
      focusPage.mockClear();
      await owner.openTab(intent);
      await nextTick();
      expect(owner.tabList.value).toHaveLength(1);
      expect(owner.activeTab.value?.id).toBe(tab.id);
      expect(focusPage).toHaveBeenCalledExactlyOnceWith(tab.id);
      focusPage.mockClear();
      await owner.openTab({
        kind: 'HISTORY_TEXT',
        ...target,
        path: 'other.ts',
        repositoryPath: '',
        worktreePath: ''
      });
      await nextTick();
      expect(focusPage).not.toHaveBeenCalled();
      expect(owner.tabList.value).toHaveLength(1);
    } finally {
      owner.dispose();
    }
  }
);

it.each(['WORKTREE_DIFF', 'HISTORY_TEXT'] as const)(
  'does not focus late %s data after the active tab, target, or tab lifetime changes',
  async (kind) => {
    for (const destination of ['another tab', 'another Workspace', 'closed tab'] as const) {
      let target = { nodeId: 'node', workspaceId: 'workspace' };
      let release!: (value: undefined) => void;
      const pending = new Promise<undefined>((resolve) => {
        release = resolve;
      });
      const readObject = vi.fn((...args: unknown[]) =>
        args.includes('A.pdf') ? pending : Promise.resolve(undefined)
      );
      const focusPage = vi.fn(() => true);
      const port = {
        requestCloseAll: async () => true,
        captureDirtyDrafts: () => [],
        hasPendingSave: () => false,
        cursorPosition: () => undefined,
        navigateTo: vi.fn(),
        focusPage
      };
      const http = createScopedHttpService();
      const owner = createWorkspaceFileWorkbenchController({
        externalTarget: () => target,
        fileWriteEnabled: () => false,
        onPopupBlocked: vi.fn(),
        target: () => target,
        page: () => port,
        prewarmEnabled: () => false,
        resolveRepositoryPath: () => undefined,
        reveal: async () => {},
        comparison: async () => undefined,
        onOpenFailure: vi.fn(),
        onRevealFailure: vi.fn(),
        preview: {
          http,
          onFailure: vi.fn(),
          onWritten: vi.fn(),
          transfers: () => ({
            directFileObjectUrl: readObject,
            directGitFileObjectUrl: readObject,
            directGitFileReadRange: async () => ({
              bytes: new Uint8Array([0]),
              size: 20,
              nextOffset: null,
              revision: 'r'
            })
          })
        },
        navigation: { http, onFileTarget: vi.fn(), onFailure: vi.fn() }
      });
      const intent = (path: string) => ({
        kind,
        ...target,
        path,
        repositoryPath: '',
        worktreePath: '',
        ...(kind === 'HISTORY_TEXT' ? { commit: 'b'.repeat(40), refs: ['main'] } : {})
      });
      try {
        const opening = owner.openTab(intent('A.pdf'));
        await vi.waitFor(() => expect(readObject).toHaveBeenCalled());
        const first = owner.activeTab.value!;
        if (destination === 'another tab') await owner.openTab(intent('B.pdf'));
        else if (destination === 'another Workspace') target = { ...target, workspaceId: 'other' };
        else owner.closeTabs([first.id]);
        await nextTick();
        const active = owner.activeTabId.value;
        const calls = focusPage.mock.calls.length;
        release(undefined);
        await opening;
        await nextTick();
        expect(focusPage).toHaveBeenCalledTimes(calls);
        expect(owner.activeTabId.value).toBe(active);
      } finally {
        release(undefined);
        owner.dispose();
      }
    }
  }
);

it.each([
  ['photo.png', 'image'],
  ['diagram.svg', 'image'],
  ['manual.pdf', 'pdf'],
  ['report.docx', 'document'],
  ['table.xlsx', 'spreadsheet'],
  ['slides.pptx', 'presentation'],
  ['clip.mp4', 'video'],
  ['sound.mp3', 'audio']
] as const)('opens Git %s in its %s format with the correct Server source', async (path, kind) => {
  const target = { nodeId: 'node', workspaceId: 'workspace' };
  const commit = 'b'.repeat(40);
  const http = createScopedHttpService();
  for (const history of [false, true]) {
    const owner = createWorkspaceFileWorkbenchController({
      externalTarget: () => target,
      fileWriteEnabled: () => false,
      onPopupBlocked: vi.fn(),
      target: () => target,
      page: () => undefined,
      prewarmEnabled: () => false,
      resolveRepositoryPath: () => undefined,
      reveal: async () => {},
      comparison: async () => undefined,
      onOpenFailure: vi.fn(),
      onRevealFailure: vi.fn(),
      preview: {
        http,
        onFailure: vi.fn(),
        onWritten: vi.fn(),
        transfers: () => ({
          directGitFileReadRange: async () => ({
            bytes: new Uint8Array([0]),
            size: 20,
            nextOffset: null,
            revision: 'revision'
          })
        })
      },
      navigation: { http, onFileTarget: vi.fn(), onFailure: vi.fn() }
    });
    try {
      const params = new URLSearchParams({
        standaloneFile: '1',
        fileTabKind: history ? 'HISTORY_DIFF' : 'WORKTREE_DIFF',
        ...target,
        path,
        repositoryPath: 'packages/media',
        gitFile: '1',
        worktreePath: '',
        ...(history ? { commit, refs: 'refs/heads/main' } : {})
      });
      const intent = standaloneFileOpenIntent(`/console?${params}`)?.tab;
      expect(intent).toBeDefined();
      await owner.openTab(intent!);
      const frame = owner.frames.value[0]!;
      expect(owner.tabList.value).toMatchObject([
        {
          kind: history ? 'HISTORY_TEXT' : 'WORKTREE_PREVIEW',
          path,
          repositoryPath: 'packages/media',
          ...(history ? { commit } : { gitFile: true })
        }
      ]);
      expect(
        filePreviewKind(frame.fileContent.value!.path, frame.fileContent.value!.encoding)
      ).toBe(kind);
      expect(frame.loading.value).toBe(false);
      const url = new URL(frame.contentUrl.value!, 'http://test.local');
      expect(url.pathname).toBe(
        `/api/workspaces/workspace${history ? `/git/commits/${commit}` : ''}/files/content`
      );
      expect(url.searchParams.get('repositoryPath')).toBe('packages/media');
      expect(url.searchParams.get('path')).toBe(path);
      if (history) expect(url.searchParams.getAll('refs')).toEqual(['refs/heads/main']);
      if (history && path === 'photo.png') {
        const cached = owner.snapshot();
        owner.restore(cached);
        await vi.waitFor(() =>
          expect(owner.frames.value[0]?.contentUrl.value).toBe(url.pathname + url.search)
        );
        expect(owner.tabList.value).toHaveLength(1);
      }
    } finally {
      owner.dispose();
    }
  }
});
import { createScopedHttpService } from '../../src/service/scoped-http-service.js';
import { createWorkspaceFileWorkbenchController } from '../../src/service/workspace-file-workbench-controller.js';

it('uses one navigation entry for same-page positions and cross-file targets', async () => {
  const target = { nodeId: 'node', workspaceId: 'workspace' };
  const http = createScopedHttpService();
  const navigateTo = vi.fn();
  const port = {
    requestCloseAll: vi.fn(async () => true),
    captureDirtyDrafts: () => [],
    hasPendingSave: () => false,
    cursorPosition: () => undefined,
    navigateTo,
    focusPage: () => true
  };
  const owner = createWorkspaceFileWorkbenchController({
    target: () => target,
    externalTarget: () => target,
    fileWriteEnabled: () => false,
    onPopupBlocked: vi.fn(),
    prewarmEnabled: () => false,
    resolveRepositoryPath: () => undefined,
    reveal: async () => {},
    onOpenFailure: vi.fn(),
    onRevealFailure: vi.fn(),
    comparison: async () => undefined,
    page: () => port,
    preview: { http, transfers: () => ({}), onFailure: vi.fn(), onWritten: vi.fn() },
    navigation: { http, onFailure: vi.fn(), onFileTarget: vi.fn() }
  });
  try {
    await owner.openFile('same.ts');
    const id = owner.activeTab.value!.id;
    owner.openNavigationTarget({ source: 'DEFINITION', path: 'same.ts', line: 10, column: 3 }, id);
    expect(navigateTo).toHaveBeenCalledWith(id, 10, 3);
    owner.openNavigationTarget({ source: 'REFERENCE', path: 'other.ts', line: 7, column: 2 }, id);
    await vi.waitFor(() =>
      expect(owner.activeTab.value).toMatchObject({
        path: 'other.ts',
        targetLine: 7,
        targetColumn: 2
      })
    );
    expect(navigateTo).toHaveBeenCalledOnce();
  } finally {
    owner.dispose();
  }
});

it('owns external file, Git and HTML window intents with live target and write capability', () => {
  let target = { nodeId: 'node-a', workspaceId: 'workspace-a' };
  let writable = false;
  const blocked = vi.fn();
  const windows: Array<{
    location: { replace: ReturnType<typeof vi.fn> };
    focus: ReturnType<typeof vi.fn>;
    closed: boolean;
    opener: null;
    dispatchEvent: () => boolean;
  }> = [];
  const open = vi.fn(() => {
    const popup = {
      location: { replace: vi.fn() },
      focus: vi.fn(),
      closed: false,
      opener: null,
      dispatchEvent: () => true
    };
    windows.push(popup);
    return popup;
  });
  vi.stubGlobal('window', { open, matchMedia: () => ({ matches: false }) });
  const http = createScopedHttpService();
  const owner = createWorkspaceFileWorkbenchController({
    target: () => target,
    externalTarget: () => target,
    fileWriteEnabled: () => writable,
    onPopupBlocked: blocked,
    prewarmEnabled: () => false,
    resolveRepositoryPath: () => undefined,
    reveal: async () => {},
    onOpenFailure: vi.fn(),
    onRevealFailure: vi.fn(),
    comparison: async () => undefined,
    page: () => undefined,
    preview: { http, transfers: () => ({}), onFailure: vi.fn(), onWritten: vi.fn() },
    navigation: { http, onFailure: vi.fn(), onFileTarget: vi.fn() }
  });
  try {
    owner.openExternal('first.ts', 4, 2);
    const first = new URL(windows[0]!.location.replace.mock.calls[0]![0], 'http://localhost');
    expect(first.searchParams.get('workspaceId')).toBe('workspace-a');
    expect(first.searchParams.has('write')).toBe(false);
    target = { nodeId: 'node-b', workspaceId: 'workspace-b' };
    writable = true;
    owner.openExternal('editable.ts');
    const editable = new URL(windows[0]!.location.replace.mock.calls[1]![0], 'http://localhost');
    expect(editable.searchParams.get('workspaceId')).toBe('workspace-b');
    expect(editable.searchParams.get('write')).toBe('1');
    owner.openDiffExternal({
      kind: 'HISTORY_DIFF',
      ...target,
      path: 'new.ts',
      repositoryPath: 'sub',
      worktreePath: '',
      commit: 'abc',
      refs: ['main'],
      paths: ['new.ts', 'next.ts']
    });
    const diff = new URL(windows[0]!.location.replace.mock.calls[2]![0], 'http://localhost');
    expect(diff.searchParams.get('workspaceId')).toBe('workspace-b');
    expect(diff.searchParams.has('write')).toBe(false);
    expect(diff.searchParams.getAll('paths')).toEqual(['new.ts', 'next.ts']);
    expect(diff.searchParams.getAll('refs')).toEqual(['main']);
    owner.openHtmlExternal('index.html');
    owner.openHtmlExternal('other.html');
    expect(open).toHaveBeenCalledTimes(3);
    expect(blocked).not.toHaveBeenCalled();
  } finally {
    owner.dispose();
    vi.unstubAllGlobals();
  }
});
import type { ScopedHttpService } from '../../src/service/scoped-http-service.js';

it.each(['new open', 'new snapshot', 'closed tab'] as const)(
  'keeps restoration scoped when a %s arrives while a read is pending',
  async (change) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested: string[] = [];
    const request = vi.fn(async (url: string) => {
      const path = new URL(url, 'http://test.local').searchParams.get('path') ?? '';
      requested.push(path);
      if (path === 'first.html') await held;
      return {
        file: {
          path,
          encoding: 'utf-8',
          content: path,
          size: 10,
          nextOffset: null,
          revision: 'a'.repeat(64)
        }
      };
    });
    const http = { request } as unknown as ScopedHttpService;
    const focusPage = vi.fn(() => true);
    const port = {
      requestCloseAll: async () => true,
      captureDirtyDrafts: () => [],
      hasPendingSave: () => false,
      cursorPosition: () => undefined,
      navigateTo: vi.fn(),
      focusPage
    };
    const owner = createWorkspaceFileWorkbenchController({
      externalTarget: () => ({ nodeId: 'node', workspaceId: 'workspace' }),
      fileWriteEnabled: () => false,
      onPopupBlocked: () => {},
      target: () => ({ nodeId: 'node', workspaceId: 'workspace' }),
      prewarmEnabled: () => false,
      resolveRepositoryPath: () => undefined,
      reveal: async () => {},
      onOpenFailure: vi.fn(),
      onRevealFailure: vi.fn(),
      comparison: async () => undefined,
      page: () => port,
      preview: { http, transfers: () => ({}), onFailure: vi.fn(), onWritten: vi.fn() },
      navigation: { http, onFileTarget: vi.fn(), onFailure: vi.fn() }
    });
    const tabs = createWorkspaceFileTabService();
    for (const path of ['first.html', 'second.ts', 'third.ts'])
      tabs.open({
        kind: 'WORKTREE_TEXT',
        nodeId: 'node',
        workspaceId: 'workspace',
        path,
        repositoryPath: '',
        worktreePath: ''
      });
    owner.restore({ fileTabs: tabs.snapshot(), dirtyTextDrafts: [] });
    try {
      await vi.waitFor(() => expect(requested).toContain('first.html'));
      if (change === 'new open') {
        expect(owner.suspendForHtml()).toBe(true);
        await owner.openFile('latest.ts');
      } else if (change === 'closed tab')
        owner.closeTabs([owner.tabList.value.find((tab) => tab.path === 'third.ts')!.id]);
      else {
        const replacement = createWorkspaceFileTabService();
        replacement.open({
          kind: 'WORKTREE_TEXT',
          nodeId: 'node',
          workspaceId: 'workspace',
          path: 'new.ts',
          repositoryPath: '',
          worktreePath: ''
        });
        owner.restore({ fileTabs: replacement.snapshot(), dirtyTextDrafts: [] });
      }
      release();
      await vi.waitFor(() =>
        expect(requested).toContain(change === 'new snapshot' ? 'new.ts' : 'second.ts')
      );
      if (change === 'new open') {
        await vi.waitFor(() => expect(requested).toContain('third.ts'));
        expect(owner.activeTab.value?.path).toBe('latest.ts');
        expect(focusPage).toHaveBeenCalledTimes(1);
      } else if (change === 'closed tab') {
        await nextTick();
        expect(requested).not.toContain('third.ts');
        expect(owner.tabList.value.map((tab) => tab.path)).toEqual(['first.html', 'second.ts']);
      } else {
        await nextTick();
        expect(requested).not.toContain('second.ts');
        expect(owner.tabList.value.map((tab) => tab.path)).toEqual(['new.ts']);
      }
    } finally {
      release();
      owner.dispose();
    }
  }
);

it('owns file navigation independently of tool visibility and removes closed locations', async () => {
  const page = {
    requestCloseAll: async () => true,
    captureDirtyDrafts: () => [],
    hasPendingSave: () => false,
    cursorPosition: () => ({ line: 2, column: 3 }),
    navigateTo: vi.fn(),
    focusPage: vi.fn(() => true)
  };
  const http = createScopedHttpService();
  const workbench = createWorkspaceFileWorkbenchController({
    externalTarget: () => ({ nodeId: 'node', workspaceId: 'workspace' }),
    fileWriteEnabled: () => false,
    onPopupBlocked: () => {},
    target: () => ({ nodeId: 'node', workspaceId: 'workspace' }),
    prewarmEnabled: () => false,
    resolveRepositoryPath: () => undefined,
    reveal: async () => {},
    onOpenFailure: vi.fn(),
    onRevealFailure: vi.fn(),
    comparison: async () => undefined,
    page: () => page,
    preview: { http, transfers: () => ({}), onFailure: () => {}, onWritten: () => {} },
    navigation: { http, onFailure: () => {}, onFileTarget: () => {} }
  });
  const intent = {
    kind: 'WORKTREE_DIFF' as const,
    nodeId: 'node',
    workspaceId: 'workspace',
    repositoryPath: '',
    worktreePath: ''
  };
  await workbench.openTab({ ...intent, path: 'a.ts' });
  const first = workbench.activeTab.value!;
  await workbench.openTab({ ...intent, path: 'b.ts', targetLine: 8 });
  const second = workbench.activeTab.value!;
  expect(workbench.canGoBack.value).toBe(true);
  workbench.travel(-1);
  await nextTick();
  expect(workbench.activeTabId.value).toBe(first.id);
  expect(page.navigateTo).toHaveBeenCalledWith(first.id, 2, 3);
  workbench.closeTabs([second.id]);
  expect(workbench.canGoForward.value).toBe(false);
});

it('releases an in-flight preview when its confirmed tab closes', async () => {
  let signal: AbortSignal | undefined;
  let finish!: () => void;
  const pending = new Promise<undefined>((resolve) => {
    finish = () => resolve(undefined);
  });
  const directFileReadRange = vi.fn(
    (...args: [string, number, number, string?, unknown?, string?, AbortSignal?]) => {
      signal = args[6];
      return pending;
    }
  );
  const http = createScopedHttpService();
  const workbench = createWorkspaceFileWorkbenchController({
    externalTarget: () => ({ nodeId: 'node', workspaceId: 'workspace' }),
    fileWriteEnabled: () => false,
    onPopupBlocked: () => {},
    target: () => ({ nodeId: 'node', workspaceId: 'workspace' }),
    prewarmEnabled: () => false,
    resolveRepositoryPath: () => undefined,
    reveal: async () => {},
    onOpenFailure: vi.fn(),
    onRevealFailure: vi.fn(),
    comparison: async () => undefined,
    page: () => undefined,
    preview: {
      http,
      transfers: () => ({ directFileReadRange }),
      onFailure: () => {},
      onWritten: () => {}
    },
    navigation: { http, onFailure: () => {}, onFileTarget: () => {} }
  });
  const target = { nodeId: 'n', workspaceId: 'w', path: 'a.txt' };
  const opening = workbench.openFile(target.path);
  const tab = workbench.activeTab.value!;
  expect(signal?.aborted).toBe(false);
  workbench.closeTabs([tab.id]);
  expect(signal?.aborted).toBe(true);
  expect(workbench.tabList.value).toEqual([]);
  finish();
  await opening;
  expect(workbench.frames.value).toEqual([]);
});

it('does not deliver deferred navigation to a replacement page or tab', async () => {
  const makePage = () => ({
    cursorPosition: () => ({ line: 1, column: 1 }),
    navigateTo: vi.fn(),
    focusPage: vi.fn(() => true),
    requestCloseAll: async () => true,
    captureDirtyDrafts: () => [],
    hasPendingSave: () => false
  });
  const oldPage = makePage();
  const newPage = makePage();
  let page = oldPage;
  const http = createScopedHttpService();
  const owner = createWorkspaceFileWorkbenchController({
    externalTarget: () => ({ nodeId: 'node', workspaceId: 'workspace' }),
    fileWriteEnabled: () => false,
    onPopupBlocked: () => {},
    target: () => ({ nodeId: 'node', workspaceId: 'workspace' }),
    prewarmEnabled: () => false,
    resolveRepositoryPath: () => undefined,
    reveal: async () => {},
    onOpenFailure: vi.fn(),
    onRevealFailure: vi.fn(),
    comparison: async () => undefined,
    page: () => page,
    preview: { http, transfers: () => ({}), onFailure: () => {}, onWritten: () => {} },
    navigation: { http, onFailure: () => {}, onFileTarget: () => {} }
  });
  const intent = {
    kind: 'WORKTREE_DIFF' as const,
    nodeId: 'node',
    workspaceId: 'workspace',
    repositoryPath: '',
    worktreePath: ''
  };
  await owner.openTab({ ...intent, path: 'a' });
  await owner.openTab({ ...intent, path: 'b' });
  owner.travel(-1);
  page = newPage;
  await nextTick();
  expect(oldPage.navigateTo).not.toHaveBeenCalled();
  expect(newPage.navigateTo).not.toHaveBeenCalled();
});

it('does not reopen an old comparison after a newer file intent', async () => {
  let finish!: (
    value: import('../../src/util/workspace-file-tab.js').WorkspaceFileOpenIntent
  ) => void;
  const http = createScopedHttpService();
  const owner = createWorkspaceFileWorkbenchController({
    externalTarget: () => ({ nodeId: 'node', workspaceId: 'workspace' }),
    fileWriteEnabled: () => false,
    onPopupBlocked: () => {},
    target: () => ({ nodeId: 'node', workspaceId: 'workspace' }),
    prewarmEnabled: () => false,
    resolveRepositoryPath: () => undefined,
    reveal: async () => {},
    onOpenFailure: vi.fn(),
    onRevealFailure: vi.fn(),
    comparison: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    page: () => undefined,
    preview: { http, transfers: () => ({}), onFailure: () => {}, onWritten: () => {} },
    navigation: { http, onFailure: () => {}, onFileTarget: () => {} }
  });
  const intent = {
    kind: 'WORKTREE_DIFF' as const,
    nodeId: 'node',
    workspaceId: 'workspace',
    repositoryPath: '',
    worktreePath: '',
    path: 'old.ts'
  };
  const pending = owner.openComparison('old.ts');
  await owner.openTab({ ...intent, path: 'new.ts' });
  finish(intent);
  await pending;
  expect(owner.tabList.value.map((tab) => tab.path)).toEqual(['new.ts']);
});

it.each(['target', 'failure'] as const)(
  'ignores a late navigation %s after suspending for HTML',
  async (outcome) => {
    const target = { nodeId: 'node', workspaceId: 'workspace' };
    let finish!: (value: unknown) => void;
    let fail!: (error: Error) => void;
    const request = vi.fn(
      () =>
        new Promise<unknown>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        })
    );
    const http = { request } as unknown as ScopedHttpService;
    const onFileTarget =
      vi.fn<
        Parameters<typeof createWorkspaceFileWorkbenchController>[0]['navigation']['onFileTarget']
      >();
    const onFailure = vi.fn();
    const bytes = new TextEncoder().encode('import "./late"');
    const owner = createWorkspaceFileWorkbenchController({
      externalTarget: () => target,
      fileWriteEnabled: () => false,
      onPopupBlocked: vi.fn(),
      target: () => target,
      page: () => undefined,
      prewarmEnabled: () => false,
      resolveRepositoryPath: () => undefined,
      reveal: async () => {},
      comparison: async () => undefined,
      onOpenFailure: vi.fn(),
      onRevealFailure: vi.fn(),
      preview: {
        http,
        onFailure: vi.fn(),
        onWritten: vi.fn(),
        transfers: () => ({
          directFileReadRange: async () => ({
            bytes,
            size: bytes.length,
            offset: 0,
            nextOffset: null,
            revision: 'r'
          })
        })
      },
      navigation: { http, onFileTarget, onFailure }
    });
    onFileTarget.mockImplementation((location, pageId) => {
      void owner.openNavigationTarget(location, pageId);
    });
    try {
      await owner.openFile('main.ts');
      const frame = owner.frames.value[0]!;
      const pending = owner.navigate(
        { ...target, pageId: frame.id, path: 'main.ts' },
        {
          reference: {
            languageId: 'ecmascript',
            extractorId: 'ecmascript-import',
            kind: 'module',
            value: './late',
            from: 0,
            to: 15
          },
          sourceContext: { text: 'import "./late"', position: 10 }
        }
      );
      expect(frame.navigationLoading.value).toBe(true);
      expect(owner.suspendForHtml()).toBe(true);
      if (outcome === 'failure') fail(new Error('late navigation failure'));
      else
        finish({
          definition: {
            state: 'READY',
            targets: [],
            references: [],
            paths: [{ path: 'late.ts', line: 1 }],
            truncated: false
          }
        });
      await pending;
      expect(owner.suspended.value).toBe(true);
      expect(frame.navigationLoading.value).toBe(false);
      expect(owner.tabList.value.map((tab) => tab.path)).toEqual(['main.ts']);
      expect(onFileTarget).not.toHaveBeenCalled();
      expect(onFailure).not.toHaveBeenCalled();
    } finally {
      owner.dispose();
    }
  }
);

it('captures dirty drafts and cursor when suspending, but refuses while saving', () => {
  let saving = true;
  let identity = '';
  const http = createScopedHttpService();
  const owner = createWorkspaceFileWorkbenchController({
    externalTarget: () => ({ nodeId: 'node', workspaceId: 'workspace' }),
    fileWriteEnabled: () => false,
    onPopupBlocked: () => {},
    target: () => ({ nodeId: 'n', workspaceId: 'w' }),
    prewarmEnabled: () => false,
    resolveRepositoryPath: () => undefined,
    reveal: async () => {},
    onOpenFailure: vi.fn(),
    onRevealFailure: vi.fn(),
    comparison: async () => undefined,
    page: () => ({
      cursorPosition: () => ({ line: 9, column: 4 }),
      navigateTo: vi.fn(),
      focusPage: vi.fn(() => true),
      requestCloseAll: async () => true,
      captureDirtyDrafts: () => [
        { tabIdentity: identity, path: 'a.ts', content: 'draft', expectedRevision: 'r1' }
      ],
      hasPendingSave: () => saving
    }),
    preview: { http, transfers: () => ({}), onFailure: vi.fn(), onWritten: vi.fn() },
    navigation: { http, onFileTarget: vi.fn(), onFailure: vi.fn() }
  });
  const fixtureTabs = createWorkspaceFileTabService();
  const tab = fixtureTabs.open({
    kind: 'WORKTREE_TEXT',
    nodeId: 'n',
    workspaceId: 'w',
    path: 'a.ts',
    repositoryPath: '',
    worktreePath: ''
  });
  identity = tab.identity;
  owner.restore({ fileTabs: fixtureTabs.snapshot(), dirtyTextDrafts: [] });
  expect(owner.suspendForHtml()).toBe(false);
  expect(owner.suspended.value).toBe(false);
  saving = false;
  expect(owner.suspendForHtml()).toBe(true);
  expect(owner.hasSuspendedDrafts()).toBe(true);
  expect(owner.snapshot().dirtyTextDrafts).toEqual([
    { tabIdentity: identity, path: 'a.ts', content: 'draft', expectedRevision: 'r1' }
  ]);
  expect(owner.snapshot().fileTabs.tabs[0]).toMatchObject({ targetLine: 9, targetColumn: 4 });
  owner.closeTabs([tab.id]);
  expect(owner.snapshot().dirtyTextDrafts).toEqual([]);
  expect(owner.hasSuspendedDrafts()).toBe(false);
});

it('commits confirmed closure of an unmounted dirty tab without retaining its draft', () => {
  const http = createScopedHttpService();
  const owner = createWorkspaceFileWorkbenchController({
    externalTarget: () => ({ nodeId: 'node', workspaceId: 'workspace' }),
    fileWriteEnabled: () => false,
    onPopupBlocked: () => {},
    target: () => undefined,
    prewarmEnabled: () => false,
    resolveRepositoryPath: () => undefined,
    reveal: async () => {},
    onOpenFailure: vi.fn(),
    onRevealFailure: vi.fn(),
    comparison: async () => undefined,
    page: () => undefined,
    preview: { http, transfers: () => ({}), onFailure: vi.fn(), onWritten: vi.fn() },
    navigation: { http, onFileTarget: vi.fn(), onFailure: vi.fn() }
  });
  const fixtureTabs = createWorkspaceFileTabService();
  const tab = fixtureTabs.open({
    kind: 'WORKTREE_TEXT',
    nodeId: 'n',
    workspaceId: 'w',
    path: 'a.ts',
    repositoryPath: '',
    worktreePath: ''
  });
  owner.restore({
    fileTabs: fixtureTabs.snapshot(),
    dirtyTextDrafts: [
      { tabIdentity: tab.identity, path: 'a.ts', content: 'draft', expectedRevision: 'r' }
    ],
    fileWindowSuspended: true
  });
  expect(owner.hasSuspendedDrafts()).toBe(true);
  owner.closeTabs([tab.id]);
  expect(owner.snapshot().dirtyTextDrafts).toEqual([]);
  expect(owner.snapshot().fileTabs.tabs).toEqual([]);
  expect(owner.hasSuspendedDrafts()).toBe(false);
});

it('restores before the page mounts and delivers only the latest ordinary open focus on registration', async () => {
  let ready = false;
  let port: import('../../src/model/workspace-file-workbench.js').WorkspaceFilePagePort | undefined;
  const http = createScopedHttpService();
  const owner = createWorkspaceFileWorkbenchController({
    externalTarget: () => ({ nodeId: 'node', workspaceId: 'workspace' }),
    fileWriteEnabled: () => false,
    onPopupBlocked: () => {},
    target: () => (ready ? { nodeId: 'n', workspaceId: 'w' } : undefined),
    prewarmEnabled: () => false,
    resolveRepositoryPath: () => undefined,
    reveal: async () => {},
    onOpenFailure: vi.fn(),
    onRevealFailure: vi.fn(),
    comparison: async () => undefined,
    page: () => port,
    preview: {
      http,
      transfers: () => ({
        directFileReadRange: async () => ({
          revision: 'r',
          size: 0,
          offset: 0,
          bytes: new Uint8Array(),
          nextOffset: null
        })
      }),
      onFailure: vi.fn(),
      onWritten: vi.fn()
    },
    navigation: { http, onFileTarget: vi.fn(), onFailure: vi.fn() }
  });
  const fixtureTabs = createWorkspaceFileTabService();
  const tab = fixtureTabs.open({
    kind: 'WORKTREE_TEXT',
    nodeId: 'n',
    workspaceId: 'w',
    path: 'draft.ts',
    repositoryPath: '',
    worktreePath: ''
  });
  const snapshot = {
    fileTabs: fixtureTabs.snapshot(),
    dirtyTextDrafts: [
      { tabIdentity: tab.identity, path: tab.path, content: 'dirty', expectedRevision: 'r' }
    ]
  };
  owner.restore(snapshot);
  await nextTick();
  expect(owner.snapshot().dirtyTextDrafts).toEqual(snapshot.dirtyTextDrafts);
  ready = true;
  owner.resumeRestoration();
  await owner.openFile('first.ts');
  await owner.openFile('latest.ts');
  await nextTick();
  const active = owner.activeTab.value;
  const focusPage = vi.fn(() => true);
  port = {
    requestCloseAll: async () => true,
    captureDirtyDrafts: () => [],
    hasPendingSave: () => false,
    cursorPosition: () => undefined,
    navigateTo: vi.fn(),
    focusPage
  };
  owner.pageReady();
  owner.pageReady();
  expect(active?.path).toBe('latest.ts');
  expect(focusPage).toHaveBeenCalledTimes(1);
  expect(focusPage).toHaveBeenCalledWith(active!.id);
  expect(owner.snapshot().dirtyTextDrafts).toEqual(snapshot.dirtyTextDrafts);
  owner.dispose();
});

it.each(['diff', 'scoped-file'] as const)(
  'delivers the current %s intent to a late page without focusing a superseded target',
  async (kind) => {
    let target = { nodeId: 'n', workspaceId: 'w' };
    let port:
      import('../../src/model/workspace-file-workbench.js').WorkspaceFilePagePort | undefined;
    const focusPage = vi.fn(() => true);
    const http = createScopedHttpService();
    const owner = createWorkspaceFileWorkbenchController({
      externalTarget: () => ({ nodeId: 'node', workspaceId: 'workspace' }),
      fileWriteEnabled: () => false,
      onPopupBlocked: () => {},
      target: () => target,
      page: () => port,
      prewarmEnabled: () => false,
      resolveRepositoryPath: () => undefined,
      reveal: async () => {},
      onOpenFailure: vi.fn(),
      onRevealFailure: vi.fn(),
      comparison: async () => undefined,
      preview: {
        http,
        transfers: () => ({
          directFileReadRange: async () => ({
            revision: 'r',
            size: 0,
            offset: 0,
            bytes: new Uint8Array(),
            nextOffset: null
          })
        }),
        onFailure: vi.fn(),
        onWritten: vi.fn()
      },
      navigation: { http, onFileTarget: vi.fn(), onFailure: vi.fn() }
    });
    const open = (path: string) =>
      kind === 'diff'
        ? owner.openTab({
            kind: 'WORKTREE_DIFF',
            ...target,
            path,
            repositoryPath: '',
            worktreePath: ''
          })
        : owner.openWorkspaceFile(path, undefined, '/linked');
    await open('first.ts');
    await open('latest.ts');
    await nextTick();
    const latest = owner.activeTab.value!;
    port = {
      requestCloseAll: async () => true,
      captureDirtyDrafts: () => [],
      hasPendingSave: () => false,
      cursorPosition: () => undefined,
      navigateTo: vi.fn(),
      focusPage
    };
    owner.pageReady();
    owner.pageReady();
    expect(focusPage).toHaveBeenCalledOnce();
    expect(focusPage).toHaveBeenCalledWith(latest.id);
    port = undefined;
    await open('obsolete.ts');
    target = { nodeId: 'n', workspaceId: 'other' };
    port = {
      requestCloseAll: async () => true,
      captureDirtyDrafts: () => [],
      hasPendingSave: () => false,
      cursorPosition: () => undefined,
      navigateTo: vi.fn(),
      focusPage
    };
    owner.pageReady();
    expect(focusPage).toHaveBeenCalledOnce();
    owner.dispose();
  }
);
