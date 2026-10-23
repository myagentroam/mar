import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, createSSRApp, h, nextTick, ref, ssrContextKey } from 'vue';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n, localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import WorkspaceInspector from '../../src/view/workspace/WorkspaceInspector.vue';
import WorkspaceGitChanges from '../../src/view/workspace/WorkspaceGitChanges.vue';
import WorkspaceGitHistory from '../../src/view/workspace/WorkspaceGitHistory.vue';
import {
  mergeWorkspaceWatchSnapshot,
  type WorkspaceWatchSnapshot
} from '../../src/service/WorkspaceRuntimeStateService.js';

type FakeView = {
  readonly props: Record<string, unknown>;
  readonly emit: (event: string, ...args: unknown[]) => void;
};

const fakeViews = vi.hoisted(() => ({
  textPages: [] as FakeView[],
  formatPages: [] as FakeView[],
  tabs: [] as FakeView[],
  focusPage: vi.fn(),
  cursorPosition: vi.fn(() => undefined),
  navigateTo: vi.fn()
}));

vi.mock('../../src/view/workspace/WorkspaceTextFilePage.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      name: 'FakeWorkspaceTextFilePage',
      props: [
        'file',
        'kind',
        'loading',
        'fullscreen',
        'downloading',
        'targetLine',
        'targetColumn',
        'markdown',
        'html',
        'renderMarkdown',
        'markdownResourceUrl',
        'writeEnabled',
        'saveFile',
        'codeNavigationEnabled',
        'active',
        'navigationLoading',
        'navigationTargets',
        'navigationNoDefinition',
        'editorIdentity',
        'tabIdentity',
        'initialDirtyDraft'
      ],
      emits: [
        'viewed',
        'close',
        'download',
        'open-markdown-preview',
        'open-html-preview',
        'open-markdown-file',
        'navigate-symbol',
        'navigate-file',
        'dismiss-navigation',
        'open-navigation-target',
        'reload',
        'dirty-draft-applied'
      ],
      setup(props, { emit }) {
        fakeViews.textPages.push({
          props: props as Record<string, unknown>,
          emit: emit as unknown as FakeView['emit']
        });
        return () =>
          h('fake-workspace-text-file-page', {
            'data-path': (props.file as { path?: string } | undefined)?.path
          });
      }
    })
  };
});

vi.mock('../../src/view/workspace/WorkspaceFormatFilePage.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      name: 'FakeWorkspaceFormatFilePage',
      props: ['file', 'contentUrl', 'kind', 'loading', 'fullscreen', 'downloading', 'active'],
      emits: ['close', 'download'],
      setup(props, { emit }) {
        fakeViews.formatPages.push({
          props: props as Record<string, unknown>,
          emit: emit as unknown as FakeView['emit']
        });
        return () =>
          h('fake-workspace-format-file-page', {
            'data-path': (props.file as { path?: string } | undefined)?.path
          });
      }
    })
  };
});

vi.mock('../../src/view/workspace/WorkspaceFileTabs.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      name: 'FakeWorkspaceFileTabs',
      props: ['tabs', 'activeTabId', 'canGoBack', 'canGoForward', 'canCloseUnmountedTab'],
      emits: ['activate', 'close', 'closeAll', 'closeLast', 'move', 'back', 'forward'],
      setup(props, { emit, expose, slots }) {
        fakeViews.tabs.push({
          props: props as Record<string, unknown>,
          emit: emit as unknown as FakeView['emit']
        });
        expose({
          captureDirtyDrafts: () => [],
          cursorPosition: fakeViews.cursorPosition,
          focusPage: fakeViews.focusPage,
          navigateTo: fakeViews.navigateTo,
          requestClose: (id: number) => emit('close', id),
          requestCloseAll: () =>
            emit(
              'closeAll',
              ((props.tabs as { id: number }[] | undefined) ?? []).map((tab) => tab.id)
            )
        });
        return () => {
          const tabs = (props.tabs as { id: number; kind: string }[] | undefined) ?? [];
          const pages = tabs.flatMap((tab) => {
            if (
              tab.kind === 'WORKTREE_DIFF' ||
              tab.kind === 'HISTORY_DIFF' ||
              tab.kind === 'TOOL_CHANGE_DIFF'
            )
              return [];
            const page = slots.default?.({
              tab,
              active: tab.id === props.activeTabId,
              registerPageHandle: () => undefined,
              requestClose: () => emit('close', tab.id)
            });
            return page === undefined ? [] : [page];
          });
          return h('fake-workspace-file-tabs', pages);
        };
      }
    })
  };
});

const originalLocale = localePreferenceService().locale.value;
const fetchRequest = vi.fn();
const hostNodes = new Set<TestHostNode>();
class TestHostNode {
  readonly props: Record<string, unknown> = {};
  readonly children: TestHostNode[] = [];
  readonly style: Record<string, string> = {};
  scrollTop = 0;
  clientHeight = 0;
  parent: TestHostNode | null = null;
  text = '';

  constructor(readonly type: string) {
    hostNodes.add(this);
  }

  closest(): null {
    return null;
  }
}
const testBody = new TestHostNode('body');

const testRenderer = createRenderer<TestHostNode, TestHostNode>({
  patchProp(node, key, _previous, next) {
    if (next === null || next === undefined) delete node.props[key];
    else node.props[key] = next;
  },
  insert(node, parent, anchor) {
    if (node.parent !== null) {
      const previousIndex = node.parent.children.indexOf(node);
      if (previousIndex >= 0) node.parent.children.splice(previousIndex, 1);
    }
    node.parent = parent;
    const index = anchor == null ? -1 : parent.children.indexOf(anchor);
    if (index < 0) parent.children.push(node);
    else parent.children.splice(index, 0, node);
  },
  remove(node) {
    if (node.parent === null) return;
    const index = node.parent.children.indexOf(node);
    if (index >= 0) node.parent.children.splice(index, 1);
    node.parent = null;
  },
  createElement: (type) => {
    return new TestHostNode(type);
  },
  createText: (text) => {
    const node = new TestHostNode('#text');
    node.text = text;
    return node;
  },
  createComment: (text) => {
    const node = new TestHostNode('#comment');
    node.text = text;
    return node;
  },
  querySelector: (selector) => (selector === 'body' ? testBody : null),
  setText(node, text) {
    node.text = text;
  },
  setElementText(node, text) {
    node.children.splice(0);
    node.text = text;
  },
  parentNode: (node) => node.parent,
  nextSibling: (node) => {
    if (node.parent === null) return null;
    return node.parent.children[node.parent.children.indexOf(node) + 1] ?? null;
  }
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

function clientComponent<T extends object>(component: T, sourceUrl: URL, id: string) {
  const filename = sourceUrl.pathname;
  const source = readFileSync(filename, 'utf8');
  const { descriptor, errors: parseErrors } = parse(source, { filename });
  if (parseErrors.length > 0 || descriptor.template === null)
    throw new Error(`Component SFC could not be parsed: ${filename}`);
  const script = compileScript(descriptor, { id });
  const template = compileTemplate({
    id,
    filename,
    source: descriptor.template.content,
    compilerOptions: {
      mode: 'function',
      ...(script.bindings === undefined ? {} : { bindingMetadata: script.bindings })
    }
  });
  if (template.errors.length > 0)
    throw new Error(`Component template could not compile: ${filename}`);
  return { ...component, render: new Function('Vue', template.code)(Vue) as Function };
}

const WorkspaceInspectorClient = clientComponent(
  WorkspaceInspector,
  new URL('../../src/view/workspace/WorkspaceInspector.vue', import.meta.url),
  'workspace-inspector-test'
);
const WorkspaceGitHistoryClient = clientComponent(
  WorkspaceGitHistory,
  new URL('../../src/view/workspace/WorkspaceGitHistory.vue', import.meta.url),
  'workspace-git-history-test'
);

async function render(props: Record<string, unknown> = {}): Promise<string> {
  const app = createSSRApp({
    render: () => h(WorkspaceInspector, { ...baseProps, ...props })
  });
  // Tooltip layout is browser-only; SSR has no tooltip output.
  app.directive('tooltip', {});
  app.use(i18n);
  app.use(ElementPlus);
  app.provide(ID_INJECTION_KEY, { prefix: 400, current: 0 });
  app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
  return renderToString(app);
}

type InspectorApi = {
  openWorkspaceFile(
    path: string,
    line?: number,
    worktreePath?: string,
    stacked?: boolean,
    column?: number,
    repositoryPath?: string
  ): Promise<void>;
  openWorkspaceFileTab(intent: Record<string, unknown>): void;
  openFile(path: string, line?: number, column?: number): Promise<void>;
  openChanges(): void;
  openSearch(): void;
  snapshot(): unknown;
  restore(value: unknown): void;
  restoreWorkspace(nodeId: string, workspaceId: string, value: unknown): void;
};

function mountInspector(
  props: Record<string, unknown> = {},
  reactiveProps: () => Record<string, unknown> = () => ({})
) {
  const inspector = ref<InspectorApi | null>(null);
  const app = testRenderer.createApp({
    render: () =>
      h(WorkspaceInspectorClient, { ...baseProps, ...props, ...reactiveProps(), ref: inspector })
  });
  app.use(i18n);
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.config.warnHandler = () => {};
  app.mount(new TestHostNode('container'));
  return { app, inspector };
}

function latestTextPage(path: string): FakeView | undefined {
  return [...fakeViews.textPages]
    .reverse()
    .find((view) => (view.props.file as { path?: string } | undefined)?.path === path);
}

function latestFormatPage(path: string): FakeView | undefined {
  return [...fakeViews.formatPages]
    .reverse()
    .find((view) => (view.props.file as { path?: string } | undefined)?.path === path);
}

function latestTabs(): FakeView | undefined {
  return fakeViews.tabs.at(-1);
}

beforeEach(() => {
  hostNodes.clear();
  hostNodes.add(testBody);
  testBody.children.splice(0);
  fakeViews.textPages.splice(0);
  fakeViews.formatPages.splice(0);
  fakeViews.tabs.splice(0);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal('document', {
    body: testBody,
    querySelector: (selector: string) => (selector === 'body' ? testBody : null),
    documentElement: {
      lang: '',
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
      classList: { add: vi.fn(), remove: vi.fn() }
    },
    visibilityState: 'visible',
    hasFocus: () => true,
    createElement: (type: string) => new TestHostNode(type)
  });
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    innerWidth: 1024,
    innerHeight: 768
  });
  vi.stubGlobal('Element', TestHostNode);
  vi.stubGlobal('HTMLElement', TestHostNode);
  vi.stubGlobal('Node', TestHostNode);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    }
  );
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
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
    const sources = [
      'WorkspaceInspector.vue',
      'WorkspaceGitChanges.vue',
      'WorkspaceGitHistory.vue'
    ].map((file) =>
      readFileSync(new URL(`../../src/view/workspace/${file}`, import.meta.url), 'utf8')
    );
    const keys = [
      ...new Set(
        [
          ...sources.flatMap((source) => [
            ...source.matchAll(
              /'((?:generated|gitWorktrees|gitSync|workspaceWatch|workspaceDisplayFilter)\.[\w.-]+)'/gu
            )
          ])
        ].map((match) => match[1]!)
      )
    ];
    expect(keys.length).toBeGreaterThan(100);
    for (const key of keys) expect(i18n.global.te(key, locale), key).toBe(true);
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

  it('renders Git worktree status in the selected locale', async () => {
    localePreferenceService().setLocale(locale);
    const service = {
      repositories: ref([
        {
          repositoryPath: '',
          repositoryName: 'project',
          source: 'ROOT',
          current: true,
          branch: 'main',
          locked: false,
          prunable: false,
          changes: []
        }
      ]),
      worktrees: ref([
        {
          directoryName: 'linked',
          branch: 'feature/test',
          head: 'a'.repeat(40),
          current: false,
          status: 'CLEAN',
          locked: false,
          prunable: false
        }
      ]),
      worktreesTruncated: ref(false),
      discoveryErrors: ref([]),
      changesRefreshing: ref(false),
      restoringPath: ref(undefined),
      loadChanges: vi.fn(async () => undefined)
    };
    const app = createSSRApp({
      render: () => h(WorkspaceGitChanges, { service: service as never, target: undefined })
    });
    app.directive('tooltip', {});
    app.use(i18n);
    app.use(ElementPlus);
    app.provide(ssrContextKey, { modules: new Set<string>() });
    app.provide(ID_INJECTION_KEY, { prefix: 400, current: 0 });
    app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
    const html = await renderToString(app);
    expect(html).toContain('linked');
    expect(html).toContain('feature/test');
    expect(html).toContain(i18n.global.t('gitWorktrees.title'));
    expect(html).toContain(i18n.global.t('gitWorktrees.clean'));
  });

  it.each([false, true])(
    'reports commit copy feedback from the rendered context menu (failure=%s)',
    async (fails) => {
      localePreferenceService().setLocale(locale);
      const commitHash = 'a'.repeat(40);
      const service = {
        historyRefs: ref([]),
        historyCommits: ref([
          {
            hash: commitHash,
            parents: [],
            subject: 'Update project',
            authorName: 'Developer',
            authorEmail: 'developer@example.test',
            committedAt: 1,
            refs: []
          }
        ]),
        historyNextCursor: ref(null),
        historyLoading: ref(false),
        historyFiles: ref({}),
        historyFilesLoading: ref([]),
        historyRepositoryPath: ref(''),
        selectedHistoryRefs: ref([]),
        historySource: ref({ repositoryPath: '', refs: [] }),
        repositories: ref([]),
        selectHistory: vi.fn(async () => undefined),
        loadHistoryFiles: vi.fn(async () => true),
        loadHistory: vi.fn(async () => undefined)
      };
      const failure = new Error('Clipboard access denied');
      const writeText = fails
        ? vi.fn().mockRejectedValue(failure)
        : vi.fn().mockResolvedValue(undefined);
      const notice = vi.fn();
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const app = testRenderer.createApp({
        render: () => h(WorkspaceGitHistoryClient, { service: service as never, onNotice: notice })
      });
      app.use(i18n);
      app.provide(ssrContextKey, { modules: new Set<string>() });
      app.provide(ID_INJECTION_KEY, { prefix: 400, current: 0 });
      app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
      app.config.warnHandler = () => {};
      app.mount(new TestHostNode('container'));
      try {
        const row = [...hostNodes].find(
          (node) =>
            node.type === 'button' && String(node.props.class).includes('history-commit-row')
        );
        expect(row).toBeDefined();
        const contextMenu = row?.props.onContextmenu as
          | ((event: { preventDefault(): void; clientX: number; clientY: number }) => void)
          | undefined;
        const preventDefault = vi.fn();
        contextMenu?.({ preventDefault, clientX: 40, clientY: 50 });
        expect(preventDefault).toHaveBeenCalledOnce();
        await nextTick();

        const menu = [...hostNodes].find((node) => node.props.class === 'history-context-menu');
        const menuItem = [...hostNodes].find((node) => node.props.role === 'menuitem');
        expect(menu?.props.role).toBe('menu');
        expect(menuItem).toBeDefined();
        expect(
          [...hostNodes].some((node) => String(node.props.class).includes('history-commit-more'))
        ).toBe(false);
        const click = menuItem?.props.onClick as (() => Promise<void>) | undefined;
        await click?.();
        expect(writeText).toHaveBeenCalledWith(commitHash);
        expect(notice).toHaveBeenCalledOnce();
        expect(notice.mock.calls[0]?.[1]).toBe(fails ? 'error' : 'info');
        if (fails) expect(notice.mock.calls[0]?.[2]).toBe(failure);
        await nextTick();
        expect(
          [...hostNodes].some((node) => node.parent && node.props.class === 'history-context-menu')
        ).toBe(false);
      } finally {
        app.unmount();
      }
    }
  );

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
    const response = (body: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    });
    fetchRequest.mockImplementation(async (request: string) => {
      const url = new URL(request, 'http://test.local');
      if (url.pathname.endsWith('/files')) return response({ error: code }, 404);
      return response({
        file: {
          path: url.searchParams.get('path') ?? 'missing/result.md',
          encoding: 'utf-8',
          content: 'safe',
          size: 4,
          nextOffset: null,
          revision: 'a'.repeat(64)
        }
      });
    });
    const notice = vi.fn();
    const { app, inspector } = mountInspector({ onNotice: notice });
    try {
      await inspector.value!.openFile('missing/result.md');
      await vi.waitFor(() =>
        expect(
          fetchRequest.mock.calls.some(([request]) =>
            new URL(String(request), 'http://test.local').pathname.endsWith('/files')
          )
        ).toBe(true)
      );
      if (code === 'PERMISSION_DENIED')
        await vi.waitFor(() => expect(notice).toHaveBeenCalledTimes(1));
      else expect(notice).not.toHaveBeenCalled();
      expect(latestTextPage('missing/result.md')?.props.file).toMatchObject({
        path: 'missing/result.md',
        content: 'safe'
      });

      notice.mockClear();
      fetchRequest.mockResolvedValue(response({ error: code }, 404));
      await inspector.value!.openWorkspaceFile('missing/failure.md');
      expect(notice).toHaveBeenCalledTimes(1);
      expect(notice.mock.calls[0]?.[0]).toContain(code);
    } finally {
      app.unmount();
    }
  }
);

it('opens previews before slow tree reveal and keeps the latest navigation active', async () => {
  let releaseRoot!: (response: unknown) => void;
  let releaseDeep!: (response: unknown) => void;
  let rootListStarted = false;
  let deepListStarted = false;
  const rootRequest = new Promise<unknown>((resolve) => {
    releaseRoot = resolve;
  });
  const deepRequest = new Promise<unknown>((resolve) => {
    releaseDeep = resolve;
  });
  const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  fetchRequest.mockImplementation((request: string) => {
    const url = new URL(request, 'http://test.local');
    if (url.pathname.endsWith('/files')) {
      if (url.searchParams.get('path') === '.') {
        rootListStarted = true;
        return rootRequest;
      }
      if (url.searchParams.get('path') === 'deep') {
        deepListStarted = true;
        return deepRequest;
      }
    }
    return Promise.resolve(
      response({
        file: {
          path: url.searchParams.get('path'),
          encoding: 'utf-8',
          content: 'safe',
          size: 4,
          nextOffset: null,
          revision: 'a'.repeat(64)
        }
      })
    );
  });
  const { app, inspector } = mountInspector();
  const api = inspector.value!;
  const successfulDirectoryPage = response({ files: { entries: [], nextCursor: null } });
  let first: Promise<void> | undefined;
  let last: Promise<void> | undefined;
  try {
    first = api.openFile('deep/A.ts', 2, 3);
    last = api.openFile('deep/B.ts', 4, 5);
    await vi.waitFor(() => {
      expect(latestTextPage('deep/A.ts')).toBeDefined();
      expect(latestTextPage('deep/B.ts')).toBeDefined();
    });
    const tabs = latestTabs()!.props;
    const tabEntries = tabs.tabs as { id: number; path: string }[];
    const tabA = tabEntries.find((tab) => tab.path === 'deep/A.ts')!;
    const tabB = tabEntries.find((tab) => tab.path === 'deep/B.ts')!;
    expect(tabs.activeTabId).toBe(tabB.id);

    await vi.waitFor(() => expect(rootListStarted).toBe(true));
    releaseRoot(successfulDirectoryPage);
    await vi.waitFor(() => expect(deepListStarted).toBe(true));
    const focusCount = fakeViews.focusPage.mock.calls.length;
    releaseDeep(successfulDirectoryPage);
    await Promise.all([first, last]);
    await vi.waitFor(() => expect(latestTabs()?.props.activeTabId).toBe(tabB.id));
    await nextTick();
    expect(fakeViews.focusPage.mock.calls.slice(focusCount).some(([id]) => id === tabA.id)).toBe(
      false
    );

    const requestCount = fetchRequest.mock.calls.length;
    await api.openFile('deep/A.ts', 6, 7);
    expect(fetchRequest).toHaveBeenCalledTimes(requestCount);
    expect(latestTabs()?.props.activeTabId).toBe(tabA.id);
    expect(latestTextPage('deep/A.ts')?.props.targetLine).toBe(6);
    expect(latestTextPage('deep/A.ts')?.props.targetColumn).toBe(7);
  } finally {
    releaseRoot(successfulDirectoryPage);
    releaseDeep(successfulDirectoryPage);
    await Promise.allSettled(
      [first, last].filter((value): value is Promise<void> => value !== undefined)
    );
    app.unmount();
  }
});

it('does not replay retained Changes metadata after the Workspace becomes a directory', async () => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('HTMLElement', TestHostNode);
  vi.stubGlobal('Node', TestHostNode);
  const workspaceKind = ref<'GIT_WORKSPACE' | 'DIRECTORY'>('GIT_WORKSPACE');
  const snapshot = ref<WorkspaceWatchSnapshot>();
  const onWorkspace = vi.fn((workspace: { kind: 'GIT_WORKSPACE' | 'DIRECTORY' }) => {
    workspaceKind.value = workspace.kind;
  });
  const app = testRenderer.createApp({
    render: () =>
      h(WorkspaceInspector, {
        ...baseProps,
        workspaceKind: workspaceKind.value,
        subscriptionSnapshot: snapshot.value,
        onWorkspace
      })
  });
  app.use(i18n);
  app.use(ElementPlus);
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.config.warnHandler = () => {};
  app.mount(new TestHostNode('container'));
  const workspace = { id: 'workspace-1', path: '/repo/child', kind: 'GIT_WORKSPACE' };
  try {
    snapshot.value = mergeWorkspaceWatchSnapshot(
      undefined,
      'node-1',
      'workspace-1',
      {
        changes: { workspace, changes: [], repositories: [] }
      },
      { topic: 'changes', revision: 1 }
    );
    await nextTick();
    snapshot.value = mergeWorkspaceWatchSnapshot(
      snapshot.value,
      'node-1',
      'workspace-1',
      {
        files: {
          files: { entries: [], nextCursor: null },
          workspace: { ...workspace, kind: 'DIRECTORY' }
        }
      },
      { topic: 'files', revision: 1 }
    );
    await nextTick();
    expect(workspaceKind.value).toBe('DIRECTORY');
    const count = onWorkspace.mock.calls.length;
    snapshot.value = mergeWorkspaceWatchSnapshot(
      snapshot.value,
      'node-1',
      'workspace-1',
      {},
      {
        topic: 'sessions',
        revision: 1
      }
    );
    await nextTick();
    expect(workspaceKind.value).toBe('DIRECTORY');
    expect(onWorkspace).toHaveBeenCalledTimes(count);
    snapshot.value = mergeWorkspaceWatchSnapshot(
      snapshot.value,
      'node-1',
      'workspace-1',
      {
        changes: { workspace: { ...workspace, kind: 'DIRECTORY' }, changes: [], repositories: [] }
      },
      { topic: 'changes', revision: 2 }
    );
    await nextTick();
    const directoryCount = onWorkspace.mock.calls.length;
    snapshot.value = mergeWorkspaceWatchSnapshot(
      snapshot.value,
      'node-1',
      'workspace-1',
      {},
      {
        topic: 'sessions',
        revision: 2
      }
    );
    await nextTick();
    expect(onWorkspace).toHaveBeenCalledTimes(directoryCount);
    snapshot.value = mergeWorkspaceWatchSnapshot(
      snapshot.value,
      'node-1',
      'workspace-1',
      {
        changes: { workspace, changes: [], repositories: [] }
      },
      { topic: 'changes', revision: 1 }
    );
    await nextTick();
    expect(workspaceKind.value).toBe('GIT_WORKSPACE');
  } finally {
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
    let complete!: () => void;
    const pending = new Promise<string>((resolve) => {
      complete = () => resolve('blob:complete-file');
    });
    const directFileObjectUrl = vi.fn(async () =>
      closeBeforeComplete ? pending : 'blob:complete-file'
    );
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const { app, inspector } = mountInspector({ directFileObjectUrl });
    try {
      const opening = inspector.value!.openFile(path);
      if (closeBeforeComplete) {
        await vi.waitFor(() => expect(directFileObjectUrl).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(latestTabs()).toBeDefined());
        const tabs = latestTabs()!;
        const tab = (tabs.props.tabs as { id: number; path: string }[]).find(
          (entry) => entry.path === path
        )!;
        tabs.emit('close', tab.id);
        complete();
        await opening;
        expect(revoke).toHaveBeenCalledWith('blob:complete-file');
        return;
      }
      await opening;
      const media = path.endsWith('.mp4') || path.endsWith('.mp3');
      expect(directFileObjectUrl).toHaveBeenCalledTimes(media ? 0 : 1);
      expect(latestFormatPage(path)?.props.contentUrl).toBe(
        media
          ? `/api/workspaces/workspace-1/files/content?nodeId=node-1&path=${path}`
          : 'blob:complete-file'
      );
      expect(latestFormatPage(path)?.props.loading).toBe(false);
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
  ['notes.custom', true, new Uint8Array([0xff]), 'base64'],
  ['same.txt', false, new TextEncoder().encode('parent content'), 'utf-8', ''],
  ['same.txt', true, new TextEncoder().encode('parent content'), 'utf-8', ''],
  ['readme.md', false, new TextEncoder().encode('# Parent content'), 'utf-8', '']
] as const)(
  'reads actual preview content for %s (direct: %s)',
  async (path, direct, bytes, encoding, repositoryPath?: string) => {
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
    const { app, inspector } = mountInspector({
      directFileReadRange,
      fileWriteEnabled: true,
      codeNavigationPrewarmEnabled: true
    });
    try {
      await inspector.value!.openWorkspaceFile(
        path,
        undefined,
        undefined,
        false,
        undefined,
        repositoryPath
      );
      const page = () => (encoding === 'utf-8' ? latestTextPage(path) : latestFormatPage(path));
      await vi.waitFor(() => expect(page()?.props.loading).toBe(false));
      const loadedPage = page();
      expect(loadedPage).toBeDefined();
      if (encoding === 'utf-8') {
        expect(loadedPage?.props.writeEnabled).toBe(repositoryPath === undefined);
        expect(loadedPage?.props.saveFile).toEqual(expect.any(Function));
      } else {
        expect(loadedPage?.props.saveFile).toBeUndefined();
      }
      expect(loadedPage?.props.loading).toBe(false);
      expect(directFileReadRange).toHaveBeenCalledWith(
        path,
        0,
        4096,
        undefined,
        undefined,
        repositoryPath
      );
      expect(directFileReadRange).toHaveBeenCalledTimes(bytes.length > 4096 ? 2 : 1);
      if (direct && bytes.length > 4096)
        expect(directFileReadRange).toHaveBeenLastCalledWith(
          path,
          0,
          512 * 1024,
          undefined,
          {
            revision: 'revision-1',
            size: bytes.length
          },
          repositoryPath
        );
      expect(loadedPage?.props.file).toMatchObject({
        encoding,
        content: encoding === 'utf-8' ? new TextDecoder().decode(bytes) : ''
      });
      expect(fetchRequest.mock.calls.some(([url]) => String(url).includes('/files/read?'))).toBe(
        !direct
      );
      expect(
        fetchRequest.mock.calls.some(([url]) => String(url).includes('/symbols/prepare?'))
      ).toBe(encoding === 'utf-8' && repositoryPath === undefined);
      if (!direct && repositoryPath !== undefined) {
        const [url] = fetchRequest.mock.calls.find(([url]) =>
          String(url).includes('/files/read?')
        )!;
        expect(new URL(String(url), 'http://test.local').searchParams.get('repositoryPath')).toBe(
          repositoryPath
        );
      }
    } finally {
      app.unmount();
    }
  }
);

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true]
])(
  'keeps navigation results per file tab (mobile=%s, history=%s)',
  async (mobileViewport, history) => {
    let finishOld: ((value: unknown) => void) | undefined;
    fetchRequest.mockImplementation(async (url: string) => {
      const parsed = new URL(url, 'http://test.local');
      if (parsed.pathname.endsWith('/files/read'))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            file: {
              path: parsed.searchParams.get('path'),
              encoding: 'utf-8',
              content: 'thing',
              size: 5,
              nextOffset: null,
              revision: 'a'.repeat(64)
            }
          })
        };
      if (parsed.searchParams.get('symbol') === 'pending')
        return new Promise((resolve) => {
          finishOld = resolve;
        });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          definition: {
            state: 'READY',
            targets: [{ path: 'target.ts', line: 3 }],
            truncated: false
          }
        })
      };
    });
    const { app, inspector } = mountInspector({ mobileViewport, codeNavigationEnabled: true });
    const api = inspector.value!;
    const commit = 'a'.repeat(40);
    const tabIntent = (path: string) => ({
      kind: history ? 'HISTORY_TEXT' : 'WORKTREE_TEXT',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      path,
      repositoryPath: '',
      worktreePath: '',
      ...(history ? { commit, refs: [] } : {})
    });
    api.openWorkspaceFileTab(tabIntent('first.ts'));
    api.openWorkspaceFileTab(tabIntent('second.ts'));
    api.restore(api.snapshot());
    try {
      await vi.waitFor(() => {
        expect(latestTextPage('first.ts')).toBeDefined();
        expect(latestTextPage('second.ts')).toBeDefined();
      });
      const entries = latestTabs()!.props.tabs as { id: number; path: string }[];
      const firstTab = entries.find((tab) => tab.path === 'first.ts')!;
      const secondTab = entries.find((tab) => tab.path === 'second.ts')!;
      latestTabs()!.emit('activate', firstTab.id);
      await nextTick();
      const first = latestTextPage('first.ts')!;
      expect(first.props.codeNavigationEnabled).toBe(true);
      first.emit('navigate-symbol', 'thing');
      await vi.waitFor(() =>
        expect(latestTextPage('first.ts')?.props.navigationTargets).toMatchObject([
          { path: 'target.ts', line: 3 }
        ])
      );

      latestTabs()!.emit('activate', secondTab.id);
      await nextTick();
      const second = latestTextPage('second.ts')!;
      expect(second.props.codeNavigationEnabled).toBe(true);
      second.emit('navigate-symbol', 'pending');
      await vi.waitFor(() =>
        expect(latestTextPage('second.ts')?.props.navigationLoading).toBe(true)
      );
      latestTabs()!.emit('activate', firstTab.id);
      await vi.waitFor(() =>
        expect(latestTextPage('second.ts')?.props.navigationLoading).toBe(false)
      );
      finishOld!({
        ok: true,
        status: 200,
        json: async () => ({
          definition: {
            state: 'READY',
            targets: [{ path: 'late.ts', line: 9 }],
            truncated: false
          }
        })
      });
      await nextTick();
      expect(latestTextPage('second.ts')?.props.navigationTargets).toEqual([]);
      expect(latestTextPage('first.ts')?.props.navigationTargets).toMatchObject([
        { path: 'target.ts', line: 3 }
      ]);
      latestTabs()!.emit('close', secondTab.id);
      await nextTick();
      expect(
        (latestTabs()?.props.tabs as { id: number }[]).some((tab) => tab.id === secondTab.id)
      ).toBe(false);
    } finally {
      app.unmount();
    }
  }
);

it('stops code navigation polling when the Inspector unmounts', async () => {
  vi.useFakeTimers();
  fetchRequest.mockImplementation(async (request: string) => {
    const url = new URL(request, 'http://test.local');
    if (url.pathname.endsWith('/files/read'))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          file: {
            path: 'sample.ts',
            encoding: 'utf-8',
            content: 'Thing',
            size: 5,
            nextOffset: null,
            revision: 'a'.repeat(64)
          }
        })
      };
    return {
      ok: true,
      status: 200,
      json: async () => ({ definition: { state: 'BUILDING', targets: [], truncated: false } })
    };
  });
  const { app, inspector } = mountInspector({ codeNavigationEnabled: true });
  try {
    await inspector.value!.openWorkspaceFile('sample.ts');
    const page = latestTextPage('sample.ts')!;
    expect(page.props.codeNavigationEnabled).toBe(true);
    page.emit('navigate-symbol', 'Thing');
    await vi.advanceTimersByTimeAsync(0);
    const definitionRequests = () =>
      fetchRequest.mock.calls.filter(([url]) => String(url).includes('/symbols/definition'));
    expect(definitionRequests()).toHaveLength(1);
    app.unmount();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(definitionRequests()).toHaveLength(1);
  } finally {
    app.unmount();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

it('opens an unknown-extension tab before its bounded content request completes', async () => {
  let finishRead!: (response: unknown) => void;
  const pendingRead = new Promise<unknown>((resolve) => {
    finishRead = resolve;
  });
  fetchRequest.mockImplementation((request: string) => {
    const url = new URL(request, 'http://test.local');
    if (url.pathname.endsWith('/files/read')) return pendingRead;
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  });
  const { app, inspector } = mountInspector();
  try {
    const opening = inspector.value!.openWorkspaceFile('draft.custom');
    await vi.waitFor(() => {
      const tabs = latestTabs()?.props.tabs as { path: string }[] | undefined;
      expect(tabs?.some((tab) => tab.path === 'draft.custom')).toBe(true);
    });
    await vi.waitFor(() => expect(latestTextPage('draft.custom')?.props.loading).toBe(true));

    finishRead({
      ok: true,
      status: 200,
      json: async () => ({
        file: {
          path: 'draft.custom',
          encoding: 'utf-8',
          content: 'plain text',
          size: 10,
          nextOffset: null,
          revision: 'a'.repeat(64)
        }
      })
    });
    await opening;
    await vi.waitFor(() => expect(latestTextPage('draft.custom')).toBeDefined());
    expect(latestTextPage('draft.custom')?.props.loading).toBe(false);
    expect(latestTextPage('draft.custom')?.props.file).toMatchObject({
      path: 'draft.custom',
      content: 'plain text'
    });
  } finally {
    app.unmount();
  }
});
