import { readFileSync } from 'node:fs';
import { createRenderer, createSSRApp, h, ssrContextKey, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n, localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import type { WorkspaceFileTreeNode } from '../../src/service/WorkspaceFileTreeService.js';
import ComposerFileReferencePicker from '../../src/view/composer/ComposerFileReferencePicker.vue';
import QuickOpenDialog from '../../src/view/workspace/QuickOpenDialog.vue';
import {
  quickOpenScore,
  sortQuickOpenCandidates,
  type QuickOpenCandidate
} from '../../src/service/QuickOpenService.js';
import WorkspaceFileTree from '../../src/view/workspace/WorkspaceFileTree.vue';

async function render(component: Component, props: Record<string, unknown>): Promise<string> {
  const app = createSSRApp({ render: () => h(component, props) });
  app.use(i18n);
  app.use(ElementPlus);
  app.provide(ID_INJECTION_KEY, { prefix: 200, current: 0 });
  app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
  return renderToString(app);
}

function fileTreeNode(
  path: string,
  name: string,
  kind: 'FILE' | 'DIRECTORY',
  options: Partial<WorkspaceFileTreeNode> = {}
): WorkspaceFileTreeNode {
  return {
    path,
    name,
    kind,
    size: kind === 'FILE' ? 24 : null,
    children: [],
    expanded: false,
    loaded: true,
    loading: false,
    nextCursor: null,
    placeholder: false,
    ...options
  };
}

class TestHostNode {
  constructor(readonly type: string) {}
}

function createTestRenderer() {
  return createRenderer<TestHostNode, TestHostNode>({
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
}

function stubBrowserEnvironment(): {
  readonly storage: Map<string, string>;
  readonly getItem: ReturnType<typeof vi.fn>;
  readonly setItem: ReturnType<typeof vi.fn>;
} {
  const storage = new Map<string, string>();
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const getItem = vi.fn((key: string) => storage.get(key) ?? null);
  const setItem = vi.fn((key: string, value: string) => storage.set(key, value));
  vi.stubGlobal('localStorage', {
    getItem,
    setItem,
    removeItem: (key: string) => storage.delete(key)
  });
  vi.stubGlobal('document', {
    documentElement: {
      lang: '',
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
        contains: (name: string) => classes.has(name)
      },
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
      getAttribute: (name: string) => attributes.get(name) ?? null
    }
  });
  return { storage, getItem, setItem };
}

function colorFromIconMarkup(html: string): string | undefined {
  return /style="color:([^;"]+)/u.exec(html)?.[1];
}

async function renderFileTypeIcon(
  iconTheme: 'seti' | 'material',
  surfaceTheme: 'daylight' | 'vscode-dark-2026'
): Promise<string> {
  vi.resetModules();
  const { default: FileTypeIcon } = await import('../../src/view/workspace/FileTypeIcon.vue');
  const { iconThemePreferenceService } =
    await import('../../src/service/IconThemePreferenceService.js');
  const { themePreferenceService } = await import('../../src/service/ThemePreferenceService.js');
  iconThemePreferenceService().setTheme(iconTheme);
  themePreferenceService().setTheme(surfaceTheme);
  return render(FileTypeIcon, { name: 'unrecognized.fixture' });
}

const FILE_NAVIGATION_SOURCES = [
  '../../src/view/workspace/QuickOpenDialog.vue',
  '../../src/view/workspace/WorkspaceFileTree.vue',
  '../../src/view/composer/ComposerFileReferencePicker.vue'
] as const;

const requiredFileNavigationMessageKeys = [
  'settings.iconThemeSeti',
  'settings.iconThemeMaterial',
  'generated.quickOpenDialog.quickOpen',
  'generated.quickOpenDialog.resultTypes',
  'generated.quickOpenDialog.all',
  'generated.quickOpenDialog.workspace',
  'generated.quickOpenDialog.session',
  'generated.quickOpenDialog.symbol',
  'generated.quickOpenDialog.file',
  'generated.quickOpenDialog.definition',
  'generated.quickOpenDialog.reference',
  'generated.quickOpenDialog.enterANameOrPath',
  'generated.quickOpenDialog.searching',
  'generated.quickOpenDialog.noMatches',
  'generated.workspaceFileTree.fileTree',
  'generated.workspaceFileTree.moreActionsFor',
  'generated.workspaceFileTree.loadMore',
  'generated.workspaceFileTree.loading',
  'generated.composerFileReferencePicker.referenceAFileOrFolder',
  'generated.composerFileReferencePicker.searchingFilesAndFolders',
  'generated.composerFileReferencePicker.folder',
  'generated.composerFileReferencePicker.file',
  'generated.composerFileReferencePicker.noMatchingPaths',
  'workspaceDisplayFilter.empty'
] as const;

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('Quick Open candidate ranking', () => {
  const candidates: QuickOpenCandidate[] = [
    {
      kind: 'FILE',
      key: 'file',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      path: 'src/agent.ts',
      name: 'agent.ts',
      stableIndex: 0
    },
    {
      kind: 'SYMBOL',
      source: 'REFERENCE',
      key: 'symbol-reference',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      symbol: 'agent',
      path: 'src/use-agent.ts',
      line: 4,
      column: 8,
      stableIndex: 4
    },
    {
      kind: 'SYMBOL',
      source: 'DEFINITION',
      key: 'symbol-definition',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      symbol: 'agent',
      path: 'src/agent.ts',
      line: 1,
      stableIndex: 3
    },
    {
      kind: 'SESSION',
      key: 'session',
      sessionId: 'session-1',
      title: 'Agent session',
      runner: 'codex',
      stableIndex: 0
    },
    {
      kind: 'WORKSPACE',
      key: 'closed-workspace',
      nodeId: 'node-1',
      nodeLabel: 'Linux',
      workspaceId: 'workspace-2',
      workspaceLabel: 'Agent tools',
      path: '/work/agent-tools',
      stableIndex: 2
    },
    {
      kind: 'WORKSPACE',
      key: 'open-workspace',
      nodeId: 'node-1',
      nodeLabel: 'Linux',
      workspaceId: 'workspace-1',
      workspaceLabel: 'Main project',
      path: '/work/main',
      openTabIndex: 0,
      stableIndex: 1
    }
  ];

  it('scores exact, prefix, substring and subsequence matches in descending strength', () => {
    expect(quickOpenScore(['agent'], 'agent')).toBeGreaterThan(
      quickOpenScore(['agent-tools'], 'agent') ?? 0
    );
    expect(quickOpenScore(['my-agent-tools'], 'agent')).toBeGreaterThan(
      quickOpenScore(['an-example-new-tool'], 'agent') ?? 0
    );
    expect(quickOpenScore(['agent'], 'missing')).toBeUndefined();
  });

  it('uses Workspace, Session, File, Symbol priority for tied scores', () => {
    expect(sortQuickOpenCandidates(candidates, '').map((entry) => entry.key)).toEqual([
      'open-workspace',
      'closed-workspace',
      'session',
      'file',
      'symbol-definition',
      'symbol-reference'
    ]);
  });

  it('uses relevance before result type priority', () => {
    expect(sortQuickOpenCandidates(candidates, 'agent.ts').map((entry) => entry.key)).toEqual([
      'file',
      'symbol-definition',
      'symbol-reference'
    ]);
    expect(sortQuickOpenCandidates(candidates, 'agent').map((entry) => entry.key)).toEqual([
      'symbol-definition',
      'symbol-reference',
      'closed-workspace',
      'session',
      'file'
    ]);
  });

  it('matches Workspaces by display name only', () => {
    expect(sortQuickOpenCandidates(candidates, 'linux')).toEqual([]);
    expect(sortQuickOpenCandidates(candidates, '/work/main')).toEqual([]);
    expect(sortQuickOpenCandidates(candidates, 'main project').map((entry) => entry.key)).toEqual([
      'open-workspace'
    ]);
  });
});

describe('public file navigation components', () => {
  describe('icon theme preference and file type rendering', () => {
    it('reads browser preferences only when the shared icon theme service is first requested', async () => {
      const browser = stubBrowserEnvironment();
      browser.storage.set('mar.icon-theme', 'seti');
      vi.resetModules();

      const { iconThemePreferenceService } =
        await import('../../src/service/IconThemePreferenceService.js');

      expect(browser.getItem).not.toHaveBeenCalled();

      const shared = iconThemePreferenceService();
      expect(browser.getItem).toHaveBeenCalledTimes(1);
      expect(shared.theme.value).toBe('seti');
      expect(iconThemePreferenceService()).toBe(shared);

      expect(browser.getItem).toHaveBeenCalledTimes(1);
    });

    it.each(['seti', 'material'] as const)(
      'renders %s icons consistently for both console surface themes',
      async (iconTheme) => {
        const daylightBrowser = stubBrowserEnvironment();
        const daylight = await renderFileTypeIcon(iconTheme, 'daylight');
        expect(daylight).toContain(`${iconTheme}-file-icon`);
        expect(colorFromIconMarkup(daylight)).toBeDefined();

        vi.unstubAllGlobals();
        const darkBrowser = stubBrowserEnvironment();
        const dark = await renderFileTypeIcon(iconTheme, 'vscode-dark-2026');
        expect(dark).toContain(`${iconTheme}-file-icon`);
        expect(colorFromIconMarkup(dark)).toBeDefined();
        expect(colorFromIconMarkup(dark)).not.toBe(colorFromIconMarkup(daylight));
        expect(darkBrowser.storage.get('mar.icon-theme')).toBe(iconTheme);
        expect(daylightBrowser.storage.get('mar.icon-theme')).toBe(iconTheme);
      }
    );
  });

  describe.each(['zh-CN', 'en-US'] as const)('file navigation messages and SSR (%s)', (locale) => {
    beforeEach(() => {
      stubBrowserEnvironment();
      localePreferenceService().setLocale(locale);
    });

    it('registers every navigation message used by public components in the common catalog', () => {
      const componentKeys = FILE_NAVIGATION_SOURCES.flatMap((path) => {
        const source = readFileSync(new URL(path, import.meta.url), 'utf8');
        return [...source.matchAll(/'((?:generated|workspaceDisplayFilter)\.[\w.-]+)'/gu)].map(
          (match) => match[1]!
        );
      });
      const keys = [...new Set([...requiredFileNavigationMessageKeys, ...componentKeys])];

      for (const key of keys) expect(i18n.global.te(key, locale), key).toBe(true);
    });

    it('renders the quick-open dialog shell without issuing an SSR file search', async () => {
      const html = await render(QuickOpenDialog, {
        open: true,
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        filesReady: true,
        symbolsReady: true,
        nodes: [],
        sessions: [],
        sessionTitle: () => 'Session',
        openSession: vi.fn(async () => undefined),
        openWorkspace: vi.fn(async () => true),
        workspaceTabs: []
      });

      expect(html).toContain('role="dialog"');
      expect(html).toContain(i18n.global.t('generated.quickOpenDialog.quickOpen'));
      expect(html).not.toContain('generated.quickOpenDialog.');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('renders file-reference candidates, loading and empty states while preserving file names as text', async () => {
      const candidates = await render(ComposerFileReferencePicker, {
        open: true,
        entries: [
          { path: 'docs/<guide>.md', name: '<guide>.md', kind: 'FILE' },
          { path: 'docs', name: 'docs', kind: 'DIRECTORY' }
        ],
        activeIndex: 1,
        loading: false,
        query: 'doc'
      });
      const loading = await render(ComposerFileReferencePicker, {
        open: true,
        entries: [],
        activeIndex: 0,
        loading: true,
        query: 'doc'
      });
      const empty = await render(ComposerFileReferencePicker, {
        open: true,
        entries: [],
        activeIndex: 0,
        loading: false,
        query: 'missing'
      });

      expect(candidates).toContain('&lt;guide&gt;.md');
      expect(candidates).toContain('docs/&lt;guide&gt;.md');
      expect(candidates).toMatch(/aria-selected="true"/u);
      expect(candidates).toContain('entry-kind');
      expect(loading).toContain('file-reference-picker');
      expect(loading).toContain(
        i18n.global.t('generated.composerFileReferencePicker.searchingFilesAndFolders')
      );
      expect(loading).not.toContain('role="option"');
      expect(empty).toContain('file-reference-picker');
      expect(empty).toContain(
        i18n.global.t('generated.composerFileReferencePicker.noMatchingPaths')
      );
      expect(empty).not.toContain('role="option"');
      expect(loading).not.toMatch(/generated\.|composerFileReferencePicker\./u);
      expect(empty).not.toMatch(/generated\.|composerFileReferencePicker\./u);
    });

    it('keeps selected and disabled file rows within the virtual window and preserves directory/file semantics', async () => {
      const guide = fileTreeNode('docs/guide.md', 'guide.md', 'FILE');
      const docs = fileTreeNode('docs', 'docs', 'DIRECTORY', {
        expanded: true,
        children: [guide]
      });
      const root = fileTreeNode('.', 'workspace', 'DIRECTORY', {
        expanded: true,
        nextCursor: 'next-root-page',
        children: [
          docs,
          ...Array.from({ length: 32 }, (_, index) =>
            fileTreeNode(`generated/file-${index}.txt`, `file-${index}.txt`, 'FILE')
          )
        ]
      });
      const html = await render(WorkspaceFileTree, {
        root,
        filter: '',
        selectedPath: 'docs/guide.md',
        disabled: true,
        mutationsEnabled: false,
        mobileViewport: false
      });

      expect(html).toContain('role="tree"');
      expect(html).toContain('data-file-path="docs"');
      expect(html).toContain('data-file-path="docs/guide.md"');
      expect(html).toContain('aria-expanded="true"');
      expect(html).toContain('aria-selected="true"');
      expect(html).toContain('disabled');
      expect(html).toContain('aria-label="docs/guide.md"');
      expect(html).not.toContain('title="docs/guide.md"');
      expect(html).not.toContain('file-31.txt');
      expect(html).not.toMatch(/generated\.|workspaceFileTree\./u);
      const treeSource = readFileSync(
        new URL('../../src/view/workspace/WorkspaceFileTree.vue', import.meta.url),
        'utf8'
      );
      expect(treeSource).toMatch(
        /\.file-tree-row\s*\{[^}]*grid-template-columns:\s*0\.8rem 18px minmax\(0, 1fr\);[^}]*gap:\s*0;[^}]*flex:\s*1;[^}]*var\(--tree-depth\) \* 8px/u
      );
      expect(treeSource).toMatch(/\.tree-chevron\s*\{[^}]*font-size:\s*0\.6rem;[^}]*\}/u);
      expect(treeSource).toMatch(
        /\.workspace-file-tree\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/u
      );
      expect(treeSource).toMatch(
        /\.file-tree-virtual-space,[^}]*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/u
      );
      expect(treeSource).toMatch(/\.file-tree-more\s*\{[^}]*margin-left:\s*0;[^}]*\}/u);
      expect(treeSource).toMatch(
        /\.tree-name\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/u
      );
      expect(treeSource).not.toContain('virtualContentWidth');
      expect(treeSource).not.toMatch(/\.file-tree-more\s*\{[^}]*position:\s*sticky;[^}]*\}/u);
      expect(treeSource).toContain('@contextmenu="openNodeActions(row.node.path, $event)"');
      expect(treeSource).toContain('event.preventDefault();');
      expect(treeSource).toContain('v-if="nodeActionsVisible(row.node.path)"');
      expect(treeSource).toContain(
        '<span v-else class="file-tree-more" aria-hidden="true"></span>'
      );
      expect(html).not.toContain('el-dropdown');
      expect(treeSource).toContain('@visible-change="setActionMenuVisible($event, row.node.path)"');
      expect(treeSource).toMatch(
        /\.file-tree-more:not\(\.is-visible\)\s*\{\s*visibility:\s*hidden;/u
      );
      expect(treeSource).toContain('-webkit-touch-callout: none;');
      expect(treeSource).toContain('!props.mobileViewport');
      expect(treeSource).toContain(':draggable="fileMoveEnabled(row.node)"');
      const empty = await render(WorkspaceFileTree, {
        root,
        filter: 'no-file-matches-this-query',
        selectedPath: undefined,
        disabled: false,
        mutationsEnabled: false,
        mobileViewport: false
      });
      expect(empty).toContain(i18n.global.t('workspaceDisplayFilter.empty'));
      expect(empty).not.toContain('workspaceDisplayFilter.empty');
    });
  });

  describe('file tree action menu', () => {
    it('declares node, interaction, permission and locale changes as row render memo dependencies', () => {
      const source = readFileSync(
        new URL('../../src/view/workspace/WorkspaceFileTree.vue', import.meta.url),
        'utf8'
      );
      const dependencies = /v-memo="(\[[\s\S]*?\])"/u.exec(source)?.[1];
      expect(dependencies).toBeDefined();
      for (const dependency of [
        'row.node,',
        'row.node.name',
        'row.node.kind',
        'row.node.expanded',
        'row.node.loading',
        'row.depth',
        'row.loadMore',
        'selectedPath === row.node.path',
        'draggingPath === row.node.path',
        'focusedPath === row.node.path',
        'nodeActionsVisible(row.node.path)',
        'disabled',
        'mutationsEnabled',
        'mobileViewport',
        'locale'
      ])
        expect(dependencies).toContain(dependency);
    });

    it('keeps the opened row action visible after hover leaves and ignores another menu closing', () => {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          disconnect(): void {}
        }
      );
      vi.stubGlobal('HTMLElement', TestHostNode);
      vi.stubGlobal('Node', TestHostNode);
      const root = fileTreeNode('.', 'workspace', 'DIRECTORY', {
        expanded: true,
        children: [fileTreeNode('notes.txt', 'notes.txt', 'FILE')]
      });
      let setupState: Record<string, unknown> | undefined;
      const app = createTestRenderer().createApp({
        render: () =>
          h(WorkspaceFileTree, {
            root,
            filter: '',
            selectedPath: undefined,
            disabled: false,
            mutationsEnabled: true,
            mobileViewport: false,
            onVnodeMounted: (vnode) => {
              setupState = (
                vnode.component as unknown as {
                  readonly setupState: Record<string, unknown>;
                } | null
              )?.setupState;
            }
          })
      });
      app.provide(ssrContextKey, { modules: new Set<string>() });
      app.config.warnHandler = () => {};
      app.mount(new TestHostNode('container'));

      try {
        const isVisible = setupState?.['nodeActionsVisible'] as (path: string) => boolean;
        const setVisible = setupState?.['setActionMenuVisible'] as (
          visible: boolean,
          path: string
        ) => void;
        expect(isVisible('notes.txt')).toBe(false);
        setVisible(true, 'notes.txt');
        expect(isVisible('notes.txt')).toBe(true);
        setVisible(false, '.');
        expect(isVisible('notes.txt')).toBe(true);
        setVisible(false, 'notes.txt');
        expect(isVisible('notes.txt')).toBe(false);
      } finally {
        app.unmount();
      }
    });
  });

  describe('file tree drag expansion', () => {
    // Vitest compiles these SFCs for SSR, so mount setup handlers through a minimal renderer.
    beforeEach(() => {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          disconnect(): void {}
        }
      );
      vi.stubGlobal('HTMLElement', TestHostNode);
      vi.stubGlobal('Node', TestHostNode);
    });

    it('waits 500ms over upload targets, cancels on leave, and does not restart for repeated enter events', async () => {
      vi.useFakeTimers();
      const directory = fileTreeNode('docs', 'docs', 'DIRECTORY');
      const root = fileTreeNode('.', 'workspace', 'DIRECTORY', {
        expanded: true,
        children: [directory]
      });
      const toggled = vi.fn();
      let setupState: Record<string, unknown> | undefined;
      const app = createTestRenderer().createApp({
        render: () =>
          h(WorkspaceFileTree, {
            root,
            filter: '',
            selectedPath: undefined,
            disabled: false,
            mutationsEnabled: false,
            mobileViewport: false,
            onToggle: toggled,
            onVnodeMounted: (vnode) => {
              setupState = (
                vnode.component as unknown as {
                  readonly setupState: Record<string, unknown>;
                } | null
              )?.setupState;
            }
          })
      });
      app.provide(ssrContextKey, { modules: new Set<string>() });
      const container = new TestHostNode('container');
      app.config.warnHandler = () => {};
      app.mount(container);

      try {
        const enterDropTarget = setupState?.['enterDropTarget'] as
          ((event: DragEvent, node: WorkspaceFileTreeNode) => void) | undefined;
        const leaveDropTarget = setupState?.['leaveDropTarget'] as
          ((event: DragEvent, path: string) => void) | undefined;
        expect(enterDropTarget).toBeTypeOf('function');
        expect(leaveDropTarget).toBeTypeOf('function');
        const uploadTransfer = {
          types: ['Files'],
          items: [{ kind: 'file' }]
        } as unknown as DataTransfer;
        const enterEvent = {
          dataTransfer: uploadTransfer,
          stopPropagation: vi.fn(),
          preventDefault: vi.fn()
        } as unknown as DragEvent;

        enterDropTarget!(enterEvent, directory);
        await vi.advanceTimersByTimeAsync(200);
        leaveDropTarget!(
          {
            currentTarget: new TestHostNode('row'),
            relatedTarget: null
          } as unknown as DragEvent,
          'docs'
        );
        await vi.advanceTimersByTimeAsync(500);
        expect(toggled).not.toHaveBeenCalled();

        enterDropTarget!(enterEvent, directory);
        await vi.advanceTimersByTimeAsync(499);
        expect(toggled).not.toHaveBeenCalled();
        enterDropTarget!(enterEvent, directory);
        await vi.advanceTimersByTimeAsync(1);
        expect(toggled).toHaveBeenCalledTimes(1);
        expect(toggled).toHaveBeenCalledWith(directory);
      } finally {
        app.unmount();
      }
    });

    it('keeps internal file moves expanding a collapsed directory immediately', () => {
      const source = fileTreeNode('notes.txt', 'notes.txt', 'FILE');
      const directory = fileTreeNode('docs', 'docs', 'DIRECTORY');
      const root = fileTreeNode('.', 'workspace', 'DIRECTORY', {
        expanded: true,
        children: [source, directory]
      });
      const toggled = vi.fn();
      let setupState: Record<string, unknown> | undefined;
      const app = createTestRenderer().createApp({
        render: () =>
          h(WorkspaceFileTree, {
            root,
            filter: '',
            selectedPath: undefined,
            disabled: false,
            mutationsEnabled: true,
            mobileViewport: false,
            onToggle: toggled,
            onVnodeMounted: (vnode) => {
              setupState = (
                vnode.component as unknown as {
                  readonly setupState: Record<string, unknown>;
                } | null
              )?.setupState;
            }
          })
      });
      app.provide(ssrContextKey, { modules: new Set<string>() });
      const container = new TestHostNode('container');
      app.config.warnHandler = () => {};
      app.mount(container);

      try {
        const startMove = setupState?.['startMove'] as
          ((event: DragEvent, node: WorkspaceFileTreeNode) => void) | undefined;
        const enterDropTarget = setupState?.['enterDropTarget'] as
          ((event: DragEvent, node: WorkspaceFileTreeNode) => void) | undefined;
        expect(startMove).toBeTypeOf('function');
        expect(enterDropTarget).toBeTypeOf('function');
        startMove!(
          {
            dataTransfer: {
              setData: vi.fn(),
              effectAllowed: 'none'
            }
          } as unknown as DragEvent,
          source
        );
        enterDropTarget!(
          {
            dataTransfer: {
              types: ['application/x-mar-workspace-path'],
              items: []
            } as unknown as DataTransfer,
            stopPropagation: vi.fn(),
            preventDefault: vi.fn()
          } as unknown as DragEvent,
          directory
        );

        expect(toggled).toHaveBeenCalledTimes(1);
        expect(toggled).toHaveBeenCalledWith(directory);
      } finally {
        app.unmount();
      }
    });
  });
});
