import { readFileSync } from 'node:fs';
import { createRenderer, createSSRApp, h, ref, ssrContextKey, type Ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n, localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import WorkspaceInspector from '../../src/view/workspace/WorkspaceInspector.vue';

const originalLocale = localePreferenceService().locale.value;
const fetchRequest = vi.fn();
class TestHostNode {
  constructor(readonly type: string) {}
}

const testRenderer = createRenderer<TestHostNode, TestHostNode>({
  patchProp() {},
  insert() {},
  remove() {},
  createElement: (type) => new TestHostNode(type),
  createText: () => new TestHostNode('#text'),
  createComment: () => new TestHostNode('#comment'),
  setText() {},
  setElementText() {},
  parentNode: () => null,
  nextSibling: () => null
});
const baseProps = {
  nodeId: 'node-1',
  workspaceId: 'workspace-1',
  workspaceName: 'project',
  workspaceKind: 'DIRECTORY' as const,
  csrfToken: 'test-csrf',
  renewCsrfToken: async () => 'test-csrf',
  enabled: true,
  mobileViewport: false,
  contentSearchEnabled: false,
  codeNavigationEnabled: false,
  codeNavigationPrewarmEnabled: false,
  filesWatchStatus: 'idle' as const,
  changesWatchStatus: 'idle' as const,
  historyCapability: false,
  fileWriteEnabled: false
};

async function render(props: Record<string, unknown> = {}): Promise<string> {
  const app = createSSRApp({
    render: () => h(WorkspaceInspector, { ...baseProps, ...props })
  });
  app.use(i18n);
  app.use(ElementPlus);
  app.provide(ID_INJECTION_KEY, { prefix: 400, current: 0 });
  app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
  return renderToString(app);
}

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal('document', {
    documentElement: {
      lang: '',
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
      classList: { add: vi.fn(), remove: vi.fn() }
    }
  });
  vi.stubGlobal('fetch', fetchRequest);
});

afterEach(() => {
  localePreferenceService().setLocale(originalLocale);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe.each(['zh-CN', 'en-US'] as const)('shared Workspace Inspector (%s)', (locale) => {
  it('resolves every fixed Inspector message from the public catalog', () => {
    localePreferenceService().setLocale(locale);
    const source = readFileSync(
      new URL('../../src/view/workspace/WorkspaceInspector.vue', import.meta.url),
      'utf8'
    );
    const keys = [
      ...new Set(
        [
          ...source.matchAll(
            /'((?:generated|gitWorktrees|gitSync|workspaceWatch|workspaceDisplayFilter)\.[\w.-]+)'/gu
          )
        ].map((match) => match[1]!)
      )
    ];
    expect(keys.length).toBeGreaterThan(100);
    for (const key of keys) expect(i18n.global.te(key, locale), key).toBe(true);
  });

  it('requests the shared 512 KiB text preview range', () => {
    const source = readFileSync(
      new URL('../../src/view/workspace/WorkspaceInspector.vue', import.meta.url),
      'utf8'
    );
    expect(source).toContain('TEXT_FILE_PREVIEW_LIMIT_BYTES,');
    expect(source).toContain(
      'return await open(entry, targetLine, worktreePath, true, stacked, preview, targetColumn)'
    );
    expect(source).not.toContain("limit: '65536'");
    expect(source).not.toContain('props.fileWriteEnabled ||');
  });

  it('passes Node-confirmed file sizes into the shared preview shell', () => {
    const source = readFileSync(
      new URL('../../src/view/workspace/WorkspaceInspector.vue', import.meta.url),
      'utf8'
    );
    expect(source).toContain('size: read.size,');
    expect(source).toContain('...(entry.size === null ? {} : { size: entry.size }),');
    expect(source).toContain('size: range.size,');
  });

  it('prewarms code navigation on text previews and passes each tab page its own navigation state', () => {
    const source = readFileSync(
      new URL('../../src/view/workspace/WorkspaceInspector.vue', import.meta.url),
      'utf8'
    );
    expect(source).toContain('for (let attempt = 0; attempt < 120; attempt += 1)');
    expect(source).toContain("{ path, symbol, references: '0' }");
    expect(source).toContain("{ path: input.path, symbol: input.symbol, references: '1' }");
    expect(source).toContain('void loadSymbolReferences({');
    expect(source).toContain('preview.navigationLoading.value = false;');
    expect(source).toContain('queryUrl(`${requestBase}/symbols/prepare`, { path }, requestNodeId)');
    expect(source).toContain("if (encoding === 'utf-8' && worktreePath === undefined)");
    expect(source).toContain("if (parsed.data.state === 'BUILDING')");
    expect(source).toContain('void openFile(target.path, target.line, target.column)');
    expect(source).toContain('openFile(match.path, match.line, match.column)');
    expect(source).toContain('defineExpose({');
    expect(source).toContain('refreshVisibleSection,\n  snapshot,');
    expect(source).toContain(
      '[() => props.nodeId, () => props.workspaceId, () => props.workspaceKind]'
    );
    expect(source).toContain('nodeId !== previousNodeId || workspaceId !== previousWorkspaceId');
    expect(source).toContain('openFile,');
    expect(source).toContain('const filePageFrames = shallowRef<readonly PreviewFrame[]>([])');
    expect(source).toContain('const activePreview = computed(');
    expect(source).toContain('<WorkspaceFileTabs');
    expect(source).toContain('@close-last="closeStandaloneFileWindow"');
    expect(source).toContain('v-slot="{ tab, active, registerPageHandle, requestClose }"');
    expect(source).toContain(':ref="registerPageHandle"');
    expect(source).toContain(':navigation-loading="preview.navigationLoading.value"');
    expect(source).toContain('@navigate-symbol="navigateSymbol"');
    expect(source).toContain('@dismiss-navigation="clearCodeNavigation(preview)"');
  });

  it('renders the offline fallback without file controls or requests during SSR', async () => {
    localePreferenceService().setLocale(locale);
    const html = await render({ enabled: false });
    expect(html).toContain(i18n.global.t('generated.workspaceInspector.theNodeIsOfflineOrDoesNot'));
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tree"');
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it('shows a neutral loading state while an uncached Node manifest is pending', async () => {
    localePreferenceService().setLocale(locale);
    const html = await render({ enabled: false, capabilityLoading: true });
    expect(html).toContain(i18n.global.t('generated.workspaceInspector.loading'));
    expect(html).not.toContain(
      i18n.global.t('generated.workspaceInspector.theNodeIsOfflineOrDoesNot')
    );
    expect(html).not.toContain('role="tree"');
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it('reports unavailable capabilities rather than offline when the Node is online', async () => {
    localePreferenceService().setLocale(locale);
    const html = await render({ enabled: false, nodeOnline: true });
    expect(html).toContain(i18n.global.t('generated.workspaceInspector.capabilityUnavailable'));
    expect(html).not.toContain(
      i18n.global.t('generated.workspaceInspector.theNodeIsOfflineOrDoesNot')
    );
  });

  it('keeps search and Git tabs gated by the supplied capabilities', async () => {
    localePreferenceService().setLocale(locale);
    const directory = await render();
    expect(directory.match(/role="tab"/gu)).toHaveLength(1);
    const git = await render({
      workspaceKind: 'GIT_WORKSPACE',
      contentSearchEnabled: true,
      historyCapability: true
    });
    expect(git.match(/role="tab"/gu)).toHaveLength(4);
    expect(git).toContain(i18n.global.t('generated.workspaceInspector.gitHistory'));
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it('keeps Inspector tabs horizontally scrollable without shrinking labels or the tab strip', () => {
    const source = readFileSync(
      new URL('../../src/view/workspace/WorkspaceInspector.vue', import.meta.url),
      'utf8'
    );
    const stripStyle = source.match(/\.inspector-tabs\s*\{([^}]+)\}/u)?.[1];
    const tabStyle = source.match(/\.inspector-tabs button\s*\{([^}]+)\}/u)?.[1];
    expect(stripStyle).toMatch(/overflow-x:\s*auto\s*;/u);
    expect(stripStyle).toMatch(/overflow-y:\s*hidden\s*;/u);
    expect(stripStyle).toMatch(/flex-shrink:\s*0\s*;/u);
    expect(tabStyle).toMatch(/flex-shrink:\s*0\s*;/u);
  });

  it('opens commit actions from the context menu without rendering a more button', () => {
    const source = readFileSync(
      new URL('../../src/view/workspace/WorkspaceInspector.vue', import.meta.url),
      'utf8'
    );
    expect(source).toContain('@contextmenu="openHistoryContextMenu(commit, $event)"');
    expect(source).toContain('navigator.clipboard.writeText(commit.hash)');
    expect(source).toContain("translate('generated.workspaceInspector.copyCommitId')");
    expect(source).not.toContain('history-commit-more');
  });

  it('renders per-topic loading and failure status from the host instead of fetching its own initial data', async () => {
    localePreferenceService().setLocale(locale);
    const loading = await render({ filesWatchStatus: 'loading' });
    expect(loading).toContain(i18n.global.t('workspaceWatch.loadingFiles'));
    expect(loading).not.toContain(i18n.global.t('workspaceWatch.filesFailed'));
    const failed = await render({ filesWatchStatus: 'failed' });
    expect(failed).toContain(i18n.global.t('workspaceWatch.filesFailed'));
    expect(fetchRequest).not.toHaveBeenCalled();
  });
});

it.each(['FILE_NOT_FOUND', 'PERMISSION_DENIED'])(
  'handles directory %s separately from file preview failures',
  async (code) => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('HTMLElement', TestHostNode);
    vi.stubGlobal('Node', TestHostNode);
    fetchRequest.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: code })
    });
    const notice = vi.fn();
    let setup: Record<string, unknown> | undefined;
    const app = testRenderer.createApp({
      render: () =>
        h(WorkspaceInspector, {
          ...baseProps,
          onNotice: notice,
          onVnodeMounted: (vnode) => {
            setup = (vnode.component as unknown as { setupState: Record<string, unknown> })
              .setupState;
          }
        })
    });
    app.use(i18n);
    app.use(ElementPlus);
    app.provide(ssrContextKey, { modules: new Set<string>() });
    app.config.warnHandler = () => {};
    app.mount(new TestHostNode('container'));
    const state = setup as {
      listTreeDirectory(path: string): Promise<unknown>;
      openWorkspaceFile(path: string): Promise<void>;
      filePageFrames: { fileContent: Ref<{ path: string }> }[];
    };
    try {
      await expect(state.listTreeDirectory('missing')).rejects.toMatchObject({ code });
      expect(notice).toHaveBeenCalledTimes(code === 'FILE_NOT_FOUND' ? 0 : 1);
      notice.mockClear();
      await state.openWorkspaceFile('missing/result.md');
      expect(notice).toHaveBeenCalledTimes(1);
      expect(notice.mock.calls[0]?.[0]).toContain(code);
      expect(state.filePageFrames.map((frame) => frame.fileContent.value.path)).toEqual([
        'missing/result.md'
      ]);
    } finally {
      app.unmount();
    }
  }
);

it('opens previews before slow tree reveal and keeps the latest navigation active', async () => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('HTMLElement', TestHostNode);
  vi.stubGlobal('Node', TestHostNode);
  fetchRequest.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      file: {
        encoding: 'utf-8',
        content: 'safe',
        size: 4,
        nextOffset: null,
        revision: 'a'.repeat(64)
      }
    })
  });
  let setup: Record<string, unknown> | undefined;
  const app = testRenderer.createApp({
    render: () =>
      h(WorkspaceInspector, {
        ...baseProps,
        onVnodeMounted: (vnode) => {
          setup = (vnode.component as unknown as { setupState: Record<string, unknown> })
            .setupState;
        }
      })
  });
  app.use(i18n);
  app.use(ElementPlus);
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.config.warnHandler = () => {};
  app.mount(new TestHostNode('container'));
  const state = setup as {
    openFile(path: string, line?: number, column?: number): Promise<void>;
    fileTree: { reveal(path: string): Promise<void>; selectPath(path: string): void };
    filePageFrames: {
      id: number;
      fileContent: Ref<{ path: string }>;
      targetLine: Ref<number | undefined>;
      targetColumn: Ref<number | undefined>;
    }[];
    workspaceFileTabService: { activeTabId: ReturnType<typeof ref> };
  };
  let releaseA!: () => void;
  let releaseB!: () => void;
  const a = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const b = new Promise<void>((resolve) => {
    releaseB = resolve;
  });
  state.fileTree.reveal = vi.fn(async (path) => (path === 'deep/A.ts' ? a : b));
  state.fileTree.selectPath = vi.fn();
  const first = state.openFile('deep/A.ts', 2, 3);
  const last = state.openFile('deep/B.ts', 4, 5);
  try {
    expect(state.filePageFrames.map((frame) => frame.fileContent.value.path)).toEqual([
      'deep/A.ts',
      'deep/B.ts'
    ]);
    await Promise.all([first, last]);
    const active = () =>
      state.filePageFrames.find(
        (frame) => frame.id === state.workspaceFileTabService.activeTabId.value
      )!;
    expect(active().fileContent.value.path).toBe('deep/B.ts');
    releaseA();
    await Promise.resolve();
    await Promise.resolve();
    expect(state.fileTree.selectPath).not.toHaveBeenCalledWith('deep/A.ts');
    releaseB();
    await Promise.resolve();
    await Promise.resolve();
    expect(active().targetLine.value).toBe(4);
    expect(active().targetColumn.value).toBe(5);
    const requests = fetchRequest.mock.calls.length;
    await state.openFile('deep/A.ts', 6, 7);
    expect(active().fileContent.value.path).toBe('deep/A.ts');
    expect(fetchRequest).toHaveBeenCalledTimes(requests);
  } finally {
    releaseA();
    releaseB();
    await Promise.allSettled([first, last]);
    app.unmount();
  }
});

it.each([
  ['clip.mp4', false],
  ['sound.mp3', false],
  ['photo.png', false],
  ['manual.pdf', false],
  ['photo.png', true],
  ['manual.pdf', true]
] as const)(
  'selects the preview transport for %s and discards closed previews (%s)',
  async (path, closeBeforeComplete) => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('HTMLElement', TestHostNode);
    vi.stubGlobal('Node', TestHostNode);
    let complete!: () => void;
    const pending = new Promise<string>((resolve) => {
      complete = () => resolve('blob:complete-file');
    });
    const directFileObjectUrl = vi.fn(async () =>
      closeBeforeComplete ? pending : 'blob:complete-file'
    );
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    let setup: Record<string, unknown> | undefined;
    const app = testRenderer.createApp({
      render: () =>
        h(WorkspaceInspector, {
          ...baseProps,
          directFileObjectUrl,
          onVnodeMounted: (vnode) => {
            setup = (vnode.component as unknown as { setupState: Record<string, unknown> })
              .setupState;
          }
        })
    });
    app.use(i18n);
    app.use(ElementPlus);
    app.provide(ssrContextKey, { modules: new Set<string>() });
    app.config.warnHandler = () => {};
    app.mount(new TestHostNode('container'));
    const state = setup as {
      openFile(path: string): Promise<void>;
      fileTree: { reveal(path: string): Promise<void>; selectPath(path: string): void };
      filePageFrames: { contentUrl: Ref<string>; loading: Ref<boolean> }[];
      closeFilePreview(preview: { contentUrl: Ref<string>; loading: Ref<boolean> }): void;
    };
    state.fileTree.reveal = vi.fn(async () => undefined);
    state.fileTree.selectPath = vi.fn();
    try {
      const opening = state.openFile(path);
      if (closeBeforeComplete) {
        await vi.waitFor(() => expect(directFileObjectUrl).toHaveBeenCalledTimes(1));
        const preview = state.filePageFrames[0]!;
        state.closeFilePreview(preview);
        complete();
        await opening;
        expect(preview.contentUrl.value).toBeUndefined();
        expect(revoke).toHaveBeenCalledWith('blob:complete-file');
        expect(state.filePageFrames).toHaveLength(0);
        return;
      }
      await opening;
      const media = path.endsWith('.mp4') || path.endsWith('.mp3');
      expect(directFileObjectUrl).toHaveBeenCalledTimes(media ? 0 : 1);
      expect(state.filePageFrames[0]?.contentUrl.value).toBe(
        media
          ? `/api/workspaces/workspace-1/files/content?nodeId=node-1&path=${path}`
          : 'blob:complete-file'
      );
      expect(state.filePageFrames[0]?.loading.value).toBe(false);
    } finally {
      app.unmount();
      revoke.mockRestore();
    }
  }
);

it.each([
  ['schedule-real-verify.mts', false, new TextEncoder().encode('export const value = 1;'), 'utf-8'],
  ['notes.custom', false, new TextEncoder().encode('plain text'), 'utf-8'],
  ['LICENSE', false, new Uint8Array(), 'utf-8'],
  ['archive.custom', false, new Uint8Array([0xff]), 'base64'],
  ['script.mts', true, new TextEncoder().encode('export const value = 1;'), 'utf-8'],
  ['large.mts', true, new TextEncoder().encode('a'.repeat(4095) + '中文'), 'utf-8'],
  ['large.custom', false, new TextEncoder().encode('a'.repeat(5000)), 'utf-8'],
  ['notes.txt', true, new Uint8Array([65, 0, 66]), 'base64'],
  ['notes.custom', true, new Uint8Array([0xff]), 'base64']
] as const)(
  'reads actual preview content for %s (direct: %s)',
  async (path, direct, bytes, encoding) => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('HTMLElement', TestHostNode);
    vi.stubGlobal('Node', TestHostNode);
    fetchRequest.mockImplementation(async (url: string) => {
      const limit = Number(new URL(url, 'http://test.local').searchParams.get('limit')) || 4096;
      const slice = bytes.subarray(0, limit);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          file: {
            path,
            encoding,
            content:
              encoding === 'utf-8'
                ? new TextDecoder().decode(slice, { stream: slice.length < bytes.length })
                : '',
            size: bytes.length,
            nextOffset: slice.length < bytes.length ? slice.length : null
          }
        })
      };
    });
    const directFileReadRange = vi.fn(async (_path: string, offset: number, limit: number) =>
      direct
        ? {
            bytes: bytes.subarray(0, limit),
            offset,
            size: bytes.length,
            revision: 'revision-1',
            nextOffset: limit < bytes.length ? limit : null
          }
        : undefined
    );
    let setup: Record<string, unknown> | undefined;
    const app = testRenderer.createApp({
      render: () =>
        h(WorkspaceInspector, {
          ...baseProps,
          directFileReadRange,
          codeNavigationPrewarmEnabled: true,
          onVnodeMounted: (vnode) => {
            setup = (vnode.component as unknown as { setupState: Record<string, unknown> })
              .setupState;
          }
        })
    });
    app.use(i18n);
    app.use(ElementPlus);
    app.provide(ssrContextKey, { modules: new Set<string>() });
    app.config.warnHandler = () => {};
    app.mount(new TestHostNode('container'));
    const state = setup as {
      openFile(path: string): Promise<void>;
      fileTree: { reveal(path: string): Promise<void>; selectPath(path: string): void };
      filePageFrames: {
        fileContent: Ref<{ encoding: string; content: string }>;
        loading: Ref<boolean>;
      }[];
    };
    state.fileTree.reveal = vi.fn(async () => undefined);
    state.fileTree.selectPath = vi.fn();
    try {
      await state.openFile(path);
      expect(directFileReadRange).toHaveBeenCalledWith(path, 0, 4096, undefined, undefined);
      expect(directFileReadRange).toHaveBeenCalledTimes(bytes.length > 4096 ? 2 : 1);
      if (direct && bytes.length > 4096)
        expect(directFileReadRange).toHaveBeenLastCalledWith(path, 0, 512 * 1024, undefined, {
          revision: 'revision-1',
          size: bytes.length
        });
      expect(state.filePageFrames[0]?.fileContent.value).toMatchObject({
        encoding,
        content: encoding === 'utf-8' ? new TextDecoder().decode(bytes) : ''
      });
      expect(state.filePageFrames[0]?.loading.value).toBe(false);
      expect(fetchRequest.mock.calls.some(([url]) => String(url).includes('/files/read?'))).toBe(
        !direct
      );
      expect(
        fetchRequest.mock.calls.some(([url]) => String(url).includes('/symbols/prepare?'))
      ).toBe(encoding === 'utf-8');
    } finally {
      app.unmount();
    }
  }
);

it('stops code navigation polling when the Inspector unmounts', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  });
  vi.stubGlobal('HTMLElement', TestHostNode);
  vi.stubGlobal('Node', TestHostNode);
  fetchRequest.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ definition: { state: 'BUILDING', targets: [], truncated: false } })
  });
  let setupState: Record<string, unknown> | undefined;
  const app = testRenderer.createApp({
    render: () =>
      h(WorkspaceInspector, {
        ...baseProps,
        codeNavigationEnabled: true,
        onVnodeMounted: (vnode) => {
          setupState = (
            vnode.component as unknown as {
              readonly setupState: Record<string, unknown>;
            } | null
          )?.setupState;
        }
      })
  });
  app.use(i18n);
  app.use(ElementPlus);
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.config.warnHandler = () => {};
  app.mount(new TestHostNode('container'));
  try {
    const state = setupState as {
      filePageFrames: { id: number; fileContent: ReturnType<typeof ref> }[];
      workspaceFileTabService: {
        open(input: Record<string, unknown>): { id: number };
      };
      createPreviewFrame(id: number): { id: number; fileContent: ReturnType<typeof ref> };
      navigateSymbol(symbol: string): Promise<void>;
    };
    const tab = state.workspaceFileTabService.open({
      kind: 'WORKTREE_TEXT',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      path: 'sample.ts',
      repositoryPath: '',
      worktreePath: ''
    });
    const preview = state.createPreviewFrame(tab.id);
    preview.fileContent.value = { path: 'sample.ts', encoding: 'utf-8', content: 'Thing' };
    state.filePageFrames.push(preview);
    expect((state as unknown as { activePreview: unknown }).activePreview).toBe(preview);
    const navigating = state.navigateSymbol('Thing');
    await vi.advanceTimersByTimeAsync(0);
    const definitionRequests = () =>
      fetchRequest.mock.calls.filter(([url]) => String(url).includes('/symbols/definition'));
    expect(definitionRequests()).toHaveLength(1);
    app.unmount();
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(definitionRequests()).toHaveLength(1);
    } finally {
      (state as unknown as { clearCodeNavigation(): void }).clearCodeNavigation();
      await vi.runOnlyPendingTimersAsync();
      await navigating;
    }
  } finally {
    app.unmount();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

it('ignores Git repository groups without a valid source and keeps top-level worktrees', () => {
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  });
  vi.stubGlobal('HTMLElement', TestHostNode);
  vi.stubGlobal('Node', TestHostNode);
  let setupState: Record<string, unknown> | undefined;
  const app = testRenderer.createApp({
    render: () =>
      h(WorkspaceInspector, {
        ...baseProps,
        workspaceKind: 'GIT_WORKSPACE',
        enabled: false,
        onVnodeMounted: (vnode) => {
          setupState = (
            vnode.component as unknown as {
              readonly setupState: Record<string, unknown>;
            } | null
          )?.setupState;
        }
      })
  });
  app.use(i18n);
  app.use(ElementPlus);
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.provide(ID_INJECTION_KEY, { prefix: 400, current: 0 });
  app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
  app.config.warnHandler = () => {};
  app.mount(new TestHostNode('container'));
  try {
    const state = setupState as {
      changes: unknown;
      visibleChangeRepositories: readonly unknown[];
      visibleChanges: readonly unknown[];
      visibleGitWorktrees: readonly unknown[];
      gitWorktreesTruncated: boolean;
    };
    state.changes = {
      repositories: [
        { repositoryPath: '', changes: [{ path: 'inferred-root.txt' }] },
        {
          repositoryPath: 'packages/child',
          source: 'INVALID',
          changes: [{ path: 'inferred-submodule.txt' }]
        }
      ],
      worktrees: [
        {
          directoryName: 'linked',
          branch: 'feature',
          head: 'a'.repeat(40),
          current: false,
          status: 'CLEAN',
          locked: false,
          prunable: false
        }
      ],
      worktreesTruncated: true
    };

    expect(state.visibleChangeRepositories).toEqual([]);
    expect(state.visibleChanges).toEqual([]);
    expect(state.visibleGitWorktrees).toHaveLength(1);
    expect(state.gitWorktreesTruncated).toBe(true);

    state.changes = { branch: 'main', changes: [{ path: 'legacy-root.txt' }] };
    expect(state.visibleChangeRepositories).toEqual([]);
    expect(state.visibleChanges).toEqual([]);
  } finally {
    app.unmount();
  }
});

it('keeps standalone binary Server fallback URL-backed without aggregating a Blob', () => {
  const source = readFileSync(
    new URL('../../src/view/workspace/StandaloneFilePreviewPage.vue', import.meta.url),
    'utf8'
  );
  expect(source).toContain('contentUrl.value = rawContentUrl(nodeId, workspaceId, path)');
  expect(source).not.toContain('const chunks: BlobPart[]');
  expect(source).not.toContain('new Blob(chunks');
});

it('opens preview shells before probing content even for unknown extensions', () => {
  const inspector = readFileSync(
    new URL('../../src/view/workspace/WorkspaceInspector.vue', import.meta.url),
    'utf8'
  );
  const standalone = readFileSync(
    new URL('../../src/view/workspace/StandaloneFilePreviewPage.vue', import.meta.url),
    'utf8'
  );

  for (const source of [inspector, standalone]) {
    expect(source).toContain('const textPreview = shouldReadTextFilePreview(');
    expect(source).toContain('decodeFilePreviewText(');
  }
  expect(
    inspector.indexOf('filePageFrames.value = [...filePageFrames.value, preview];')
  ).toBeLessThan(inspector.indexOf('await nextTick();'));
  expect(inspector).toContain('preview.loading.value = true;');
  expect(inspector).toContain("if (binaryKind === 'unsupported')");
  expect(inspector).toContain('preview.loading.value = textPreview || binaryKind');
  expect(standalone).not.toContain("if (binaryKind === 'unsupported' && !textPreview)");
  expect(standalone).toContain("if (filePreviewKind(path, 'base64') === 'unsupported') return;");
  expect(standalone).toContain(':loading="loading"');
  expect(standalone).toContain('truncated: first.nextOffset !== null');
  expect(standalone).not.toContain('writeEnabled ||');
});
