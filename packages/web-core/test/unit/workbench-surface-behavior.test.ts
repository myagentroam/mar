import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { computed, createSSRApp, h, nextTick, shallowReactive, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus from 'element-plus';
import Surface from '../../src/view/workbench/WorkbenchSurface.vue?unit-render';
import SessionPane from '../../src/view/workbench/WorkspaceSessionPane.vue?unit-render';
import {
  flushComponent,
  renderComponent,
  textContent,
  trigger
} from './support/component-renderer.js';
import {
  i18n,
  localePreferenceService,
  translate
} from '../../src/service/locale-preference-service.js';
import { createConversationStateService } from '../../src/service/conversation-state-service.js';
import { createConversationScrollService } from '../../src/service/conversation-scroll-service.js';
import { createWorkspaceGitService } from '../../src/service/workspace-git-service.js';
import type { ScopedHttpService } from '../../src/service/scoped-http-service.js';
import { createWorkspaceContentSearchService } from '../../src/service/workspace-content-search-service.js';
import { createWorkspaceFilesController } from '../../src/service/workspace-files-controller.js';

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '28px' }));
});
afterAll(() => vi.unstubAllGlobals());

vi.mock('../../src/service/mobile-surface-focus-service.js', () => ({
  createMobileSurfaceFocusService: () => ({ dispose: vi.fn() })
}));

const lifetime = vi.hoisted(() => ({ mounted: 0, unmounted: 0 }));
vi.mock('../../src/view/settings/SettingsContent.vue?unit-render', async () => {
  const { defineComponent, h } = await import('vue');
  return { __esModule: true, default: defineComponent(() => () => h('settings-fixture')) };
});
vi.mock('../../src/view/conversation/HostedConversationWorkspacePage.vue?unit-render', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent(() => () => h('hosted-fixture')) };
});
vi.mock('../../src/service/management-composition.js', async () => {
  const { defineComponent, h } = await import('vue');
  const component = defineComponent({
    emits: ['extensionChanged'],
    setup:
      (_, { emit }) =>
      () =>
        h(
          'button',
          { 'data-testid': 'extension', onClick: () => emit('extensionChanged') },
          'Change extension'
        )
  });
  return {
    useManagementComposition: () => ({
      resolve: () => ({ id: 'system', component, props: () => ({}) })
    })
  };
});
vi.mock('../../src/view/workbench/WorkbenchHeader.vue?unit-render', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      setup:
        (_, { slots }) =>
        () =>
          h('header', slots['workspace-tabs']?.())
    })
  };
});
vi.mock('../../src/view/workspace/WorkspaceTabs.vue?unit-render', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      setup:
        (_, { attrs }) =>
        () =>
          h('tab-strip', attrs)
    })
  };
});
vi.mock('../../src/view/workspace/WorkspaceRegistrationPicker.vue?unit-render', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      props: ['nodeReady'],
      setup: (props) => () => h('registration-picker', props)
    })
  };
});
vi.mock('../../src/view/terminal/TerminalDock.vue?unit-render', async () => {
  const { defineComponent, h, onMounted, onUnmounted } = await import('vue');
  return {
    default: defineComponent({
      props: ['errorMessage'],
      setup: (props, { attrs }) => {
        onMounted(() => lifetime.mounted++);
        onUnmounted(() => lifetime.unmounted++);
        return () => h('terminal-fixture', { ...attrs, ...props });
      }
    })
  };
});

vi.mock('../../src/view/workspace/WorkspaceSessionList.vue?unit-render', () => ({
  default: { render: () => null }
}));
vi.mock('../../src/view/workspace/FileTypeIcon.vue?unit-render', () => ({
  default: { render: () => null }
}));
vi.mock('../../src/view/workspace/WorkspaceFileWorkbench.vue?unit-render', () => ({
  default: { render: () => null }
}));
vi.mock('../../src/view/conversation/ConversationHeader.vue?unit-render', () => ({
  default: { render: () => null }
}));
vi.mock('../../src/view/conversation/ConversationScroll.vue?unit-render', () => ({
  default: { render: () => null }
}));
vi.mock('../../src/view/composer/ConversationComposer.vue?unit-render', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      props: ['placeholder', 'readonly', 'loading', 'working'],
      setup: (props) => () => h('composer-fixture', { ...props })
    })
  };
});

function pageFixture() {
  const tabs = ['one', 'two'].map((id) => ({
    id,
    nodeId: 'node',
    workspaceId: id,
    label: id,
    lastActiveAt: 1
  }));
  // Preserve nested service refs: the production controller unwraps only its outer state.
  return shallowReactive({
    view: 'nodes',
    setAsideSurfaceVisible: vi.fn(),
    asideViewMode: () => 'compact' as const,
    asideWidth: () => 320,
    asideState: { tools: ['terminal'], sessions: [], active: { kind: 'tool', id: 'terminal' } },
    mobileViewport: false,
    sidebarCollapsed: false,
    settingsSection: 'account',
    settingsItems: [],
    loading: false,
    managementSection: 'overview',
    managementItems: [],
    hostedConversationWorkspace: {
      snapshot: ref(undefined),
      conversations: ref([]),
      selectedNodeId: ref(undefined),
      selectedConversationId: ref(undefined)
    },
    mainPane: {
      registerShortcuts: () => () => undefined,
      conversation: createConversationStateService(vi.fn()),
      scroll: createConversationScrollService(),
      draft: { input: ref(''), skillTokens: ref([]), references: ref([]) },
      attachments: { attachments: ref([]) },
      draggingAttachments: ref(false),
      queue: {
        startEditing: vi.fn(),
        finishEditing: vi.fn(),
        editingQueueItemId: ref(),
        editingContent: ref(''),
        draggingQueueItemId: ref()
      },
      setInputFocus: vi.fn(),
      setRangeEditor: vi.fn()
    },
    refreshAdmin: vi.fn(),
    workspaceHost: { connected: false },
    workspaceTarget: { nodeId: 'node', workspaceId: 'one' },
    selectedWorkspace: undefined as { kind: string } | undefined,
    workspaceTabs: tabs,
    activeWorkspaceTabId: 'one',
    nodeLabel: () => 'Node',
    workspaceTabNodeLabel: () => 'Node',
    workspaceDirectAvailable: () => false,
    workspaceDirectDescription: () => undefined,
    workspaceTabService: { move: vi.fn(), setPinned: vi.fn() },
    workbenchNotificationService: {
      hasActiveWorkspaceRun: () => false,
      hasUnreadWorkspace: () => false
    },
    terminalReady: true,
    terminalDocks: new Map(),
    nodes: [],
    workspaceRegistrationNodeId: undefined as string | undefined,
    workspaceRegistrationReady: false,
    mobileWorkspaceSurface: 'conversation',
    notice: vi.fn()
  });
}

function installMainPane(
  page: Pick<ReturnType<typeof pageFixture>, 'mainPane' | 'workspaceTarget'>
): void {
  Object.assign(page, {
    mainPaneController: {
      state: {
        ...page.mainPane,
        workspaceTarget: ref(page.workspaceTarget),
        skillTokens: { remove: vi.fn() }
      },
      presentation: { composerSessionOpen: ref(false) },
      configuration: {},
      runner: {},
      references: {},
      interactions: { registerShortcuts: () => () => undefined },
      currentSessionQueue: { items: [], paused: false },
      submitting: ref(false),
      canInterrupt: ref(false),
      performance: { current: ref(undefined) },
      conversationWindow: { paging: { olderHistoryError: ref(undefined) } },
      selectedSessionId: ref(undefined),
      draftOpen: ref(false),
      nodeManifest: ref(undefined),
      status: { manifestLoading: ref(false) },
      conversationSyncPending: ref(false),
      loading: ref(false),
      mobileViewport: ref(false),
      completion: ref(undefined),
      attachmentInput: {}
    }
  });
}

describe('Workbench surface composition behavior', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'shows the correct unavailable Files reason without requests in %s',
    async (locale) => {
      const preference = localePreferenceService();
      const previousLocale = preference.locale.value;
      preference.setLocale(locale);
      const list = vi.fn();
      const page = Object.assign(pageFixture(), {
        workspaceHost: { connected: false },
        selectedWorkspace: { kind: 'DIRECTORY' },
        filesReady: false,
        contentSearchReady: false,
        asideState: { tools: ['files'], sessions: [], active: { kind: 'tool', id: 'files' } },
        workspaceKindLabel: () => '',
        workspaceBranchLabel: () => '',
        nodeManifest: undefined as object | undefined,
        nodeManifestLoading: false,
        selectedWorkspaceBranch: undefined,
        workPromptCompletion: { enabled: false },
        workspaceFileWorkbench: {},
        workspaceWatchTopicStatus: {},
        setWorkspaceFilesPanel: vi.fn(),
        setWorkspaceSearchPanel: vi.fn(),
        workspaceSearch: createWorkspaceContentSearchService({
          http: { request: vi.fn() } as unknown as ScopedHttpService,
          onFailure: vi.fn()
        }),
        workspaceFiles: createWorkspaceFilesController({
          target: () => undefined,
          workspaceName: () => 'workspace',
          list,
          mutate: vi.fn(),
          revealLocal: vi.fn(),
          preflight: vi.fn(),
          queue: vi.fn(),
          onFailure: vi.fn(),
          onWorkspace: vi.fn(),
          onMutationFailure: vi.fn(),
          onDeletedSelection: vi.fn(),
          onRevealSelection: vi.fn()
        })
      });
      installMainPane(page);
      const savedWindow = globalThis.window;
      vi.stubGlobal('window', undefined);
      try {
        async function renderUnavailable() {
          const app = createSSRApp({ render: () => h(Surface, { page } as never) });
          app.use(i18n);
          app.use(ElementPlus);
          app.directive('tooltip', {});
          return renderToString(app);
        }
        const offline = await renderUnavailable();
        expect(offline).toContain(
          translate('generated.workspaceInspector.theNodeIsOfflineOrDoesNot')
        );
        expect(offline).not.toContain('role="tree"');
        page.workspaceHost = { connected: true };
        page.nodeManifestLoading = true;
        for (const tool of ['files', 'search', 'changes', 'history']) {
          page.asideState = { tools: [tool], sessions: [], active: { kind: 'tool', id: tool } };
          const loading = await renderUnavailable();
          expect(loading).toContain(translate('generated.workspaceInspector.loading'));
          expect(loading).toMatch(
            /<p[^>]*workspace-tool-loading[^>]*role="status"[^>]*>\s*<svg[^>]*data-mar-icon="loading-action"/u
          );
          expect(loading).not.toContain('role="tree"');
        }
        page.asideState = { tools: ['files'], sessions: [], active: { kind: 'tool', id: 'files' } };
        page.nodeManifestLoading = false;
        page.nodeManifest = {};
        const unsupported = await renderUnavailable();
        expect(unsupported).toContain(
          translate('generated.workspaceInspector.capabilityUnavailable')
        );
        page.workspaceHost = { connected: false };
        page.nodeManifest = undefined;
        expect(list).not.toHaveBeenCalled();
      } finally {
        vi.stubGlobal('window', savedWindow);
      }
      const view = renderComponent(Surface, { page });
      try {
        expect(textContent(view.root)).toContain(
          translate('generated.workspaceInspector.theNodeIsOfflineOrDoesNot')
        );
        page.workspaceHost = { connected: true };
        page.nodeManifestLoading = true;
        await nextTick();
        expect(textContent(view.root)).toContain(translate('generated.workspaceInspector.loading'));
        page.nodeManifestLoading = false;
        page.nodeManifest = {};
        await nextTick();
        expect(textContent(view.root)).toContain(
          translate('generated.workspaceInspector.capabilityUnavailable')
        );
        expect(view.findAll('tree')).toHaveLength(0);
        expect(list).not.toHaveBeenCalled();
      } finally {
        view.unmount();
        preference.setLocale(previousLocale);
      }
    }
  );
  it('applies Changes Watch data without rereading and refreshes Run invalidations', async () => {
    const page = Object.assign(pageFixture(), {
      workspaceHost: { connected: true },
      selectedWorkspace: { kind: 'GIT_WORKSPACE' },
      filesReady: true,
      historyReady: true,
      asideState: { tools: ['changes'], sessions: [], active: { kind: 'tool', id: 'changes' } },
      workspaceKindLabel: () => '',
      workspaceBranchLabel: () => '',
      nodeManifest: {},
      nodeManifestLoading: false,
      selectedWorkspaceBranch: undefined,
      workPromptCompletion: { enabled: false },
      workspaceFileWorkbench: {},
      workspaceWatchTopicStatus: {},
      workspaceChangesRevision: 0,
      workspaceGit: undefined as unknown as ReturnType<typeof createWorkspaceGitService>
    });
    installMainPane(page);
    let reads = 0;
    const http = {
      request: vi.fn(async (url: string) => {
        if (url.includes('/git/fetch')) return { fetchFailed: false, updated: false };
        reads += 1;
        return { branch: 'main', changes: [] };
      })
    } as unknown as ScopedHttpService;
    const onBranch = vi.fn(() => {
      if (reads < 5) page.selectedWorkspace = { ...page.selectedWorkspace! };
    });
    page.workspaceGit = createWorkspaceGitService({
      http,
      target: () => page.workspaceTarget,
      gitEnabled: () => true,
      historyEnabled: () => true,
      onWorkspace: vi.fn(),
      onBranch,
      onFailure: vi.fn()
    });
    const view = renderComponent(Surface, { page });
    try {
      await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
      await flushComponent();
      expect(reads).toBe(1);
      expect(onBranch).toHaveBeenCalledOnce();
      expect(page.workspaceGit.changesRefreshing.value).toBe(false);
      page.workspaceGit.applyWatch({ branch: 'watch/main', changes: [] }, 1);
      await flushComponent();
      expect(reads).toBe(1);
      expect(page.workspaceGit.changes.value).toEqual({ branch: 'watch/main', changes: [] });
      page.workspaceChangesRevision = 1;
      await flushComponent();
      expect(reads).toBe(2);
    } finally {
      view.unmount();
      page.workspaceGit.reset();
    }
  });
  it('releases a pending Changes batch timer when switching Workspace without resetting the Git owner', async () => {
    vi.useFakeTimers();
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    let intersection: IntersectionObserverCallback | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersection = callback;
        }
        observe = vi.fn();
        disconnect = disconnect;
      }
    );
    const page = Object.assign(pageFixture(), {
      workspaceHost: { connected: true },
      selectedWorkspace: { kind: 'GIT_WORKSPACE' },
      filesReady: true,
      historyReady: true,
      asideState: { tools: ['changes'], sessions: [], active: { kind: 'tool', id: 'changes' } },
      workspaceKindLabel: () => '',
      workspaceBranchLabel: () => '',
      nodeManifest: {},
      nodeManifestLoading: false,
      selectedWorkspaceBranch: undefined,
      workPromptCompletion: { enabled: false },
      workspaceFileWorkbench: {},
      workspaceWatchTopicStatus: {},
      workspaceGit: undefined as unknown as ReturnType<typeof createWorkspaceGitService>
    });
    installMainPane(page);
    const http = { request: () => new Promise(() => {}) } as ScopedHttpService;
    page.workspaceGit = createWorkspaceGitService({
      http,
      target: () => page.workspaceTarget,
      gitEnabled: () => true,
      historyEnabled: () => true,
      onWorkspace: vi.fn(),
      onBranch: vi.fn(),
      onFailure: vi.fn()
    });
    page.workspaceGit.applyWatch(
      {
        repositories: [
          {
            repositoryPath: '',
            source: 'ROOT',
            repositoryName: 'root',
            changes: Array.from({ length: 201 }, (_, i) => ({
              path: `f${i}.ts`,
              state: 'UNSTAGED',
              change: 'MODIFIED',
              diffAvailable: true
            }))
          }
        ]
      },
      1
    );
    const reset = vi.spyOn(page.workspaceGit, 'reset');
    const view = renderComponent(Surface, { page });
    const rows = () => view.findAll('li').filter((node) => node.props.class === 'change-entry');
    try {
      await nextTick();
      expect(rows()).toHaveLength(200);
      expect(intersection).toBeDefined();
      intersection!(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
      const timerIndex = setTimer.mock.calls.findIndex((call) => call[1] === 100);
      expect(timerIndex).toBeGreaterThanOrEqual(0);
      const batchTimer = setTimer.mock.results[timerIndex]!.value;
      await nextTick();
      page.workspaceTarget = { nodeId: 'node', workspaceId: 'two' };
      await nextTick();
      await vi.advanceTimersByTimeAsync(500);
      expect(rows()).toHaveLength(0);
      expect(disconnect).toHaveBeenCalled();
      expect(clearTimer).toHaveBeenCalledWith(batchTimer);
      expect(page.workspaceGit.changesRefreshing.value).toBe(true);
      expect(reset).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      page.workspaceGit.reset();
      clearTimer.mockRestore();
      setTimer.mockRestore();
      vi.useRealTimers();
      vi.stubGlobal('IntersectionObserver', undefined);
    }
  });
  it('releases the old History menu and listeners on a same-tool Workspace switch without resetting Git', async () => {
    const page = Object.assign(pageFixture(), {
      workspaceHost: { connected: true },
      selectedWorkspace: { kind: 'GIT_WORKSPACE' },
      filesReady: true,
      historyReady: true,
      asideState: { tools: ['history'], sessions: [], active: { kind: 'tool', id: 'history' } },
      workspaceKindLabel: () => '',
      workspaceBranchLabel: () => '',
      nodeManifest: {},
      nodeManifestLoading: false,
      selectedWorkspaceBranch: undefined,
      workPromptCompletion: { enabled: false },
      workspaceFileWorkbench: {},
      workspaceWatchTopicStatus: {},
      workspaceGit: undefined as unknown as ReturnType<typeof createWorkspaceGitService>
    });
    installMainPane(page);
    const http = { request: () => new Promise(() => {}) } as ScopedHttpService;
    page.workspaceGit = createWorkspaceGitService({
      http,
      target: () => page.workspaceTarget,
      gitEnabled: () => true,
      historyEnabled: () => true,
      onWorkspace: vi.fn(),
      onBranch: vi.fn(),
      onFailure: vi.fn()
    });
    page.workspaceGit.restore({
      changes: { repositories: [] },
      historyCommits: [
        {
          hash: 'a'.repeat(40),
          parents: [],
          subject: 'A',
          authorName: 'A',
          authorEmail: 'a@example.test',
          committedAt: 1,
          refs: []
        }
      ]
    });
    const reset = vi.spyOn(page.workspaceGit, 'reset');
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const view = renderComponent(Surface, { page });
    try {
      await nextTick();
      const row = view
        .findAll('button')
        .find((node) => String(node.props.class).includes('history-commit-row'))!;
      (
        row.props.onContextmenu as (event: {
          preventDefault(): void;
          clientX: number;
          clientY: number;
        }) => void
      )({ preventDefault() {}, clientX: 40, clientY: 50 });
      await nextTick();
      expect(view.findAll('div').some((node) => node.props.class === 'history-context-menu')).toBe(
        true
      );
      page.workspaceTarget = { nodeId: 'node', workspaceId: 'two' };
      await nextTick();
      expect(view.findAll('div').some((node) => node.props.class === 'history-context-menu')).toBe(
        false
      );
      expect(removeListener).toHaveBeenCalledWith('pointerdown', expect.any(Function));
      expect(reset).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      removeListener.mockRestore();
      page.workspaceGit.reset();
    }
  });
  it.each([
    ['search', 'aside', 'success'],
    ['search', 'aside', 'failure'],
    ['search', 'capability', 'success'],
    ['search', 'capability', 'failure'],
    ['search', 'enabled', 'success'],
    ['search', 'enabled', 'failure'],
    ['files', 'aside', 'success'],
    ['files', 'aside', 'failure'],
    ['files', 'enabled', 'success'],
    ['files', 'enabled', 'failure']
  ] as const)(
    'invalidates pending %s through the real Surface when %s changes before late %s',
    async (tool, cause, outcome) => {
      let resolve!: (value: never) => void;
      let reject!: (error: unknown) => void;
      const response = new Promise<never>((accept, fail) => {
        resolve = accept;
        reject = fail;
      });
      const failure = vi.fn();
      const page = shallowReactive({
        ...pageFixture(),
        workspaceHost: { connected: true },
        filesReady: true,
        contentSearchReady: true,
        selectedWorkspace: { id: 'one', kind: 'DIRECTORY' },
        workspaceWatchTopicStatus: { files: 'ready' },
        workspaceKindLabel: () => '',
        workspaceBranchLabel: () => '',
        workspaceTabLabel: () => 'Workspace',
        workPromptCompletion: { enabled: false },
        asideState: { tools: [tool], sessions: [], active: { kind: 'tool', id: tool as string } },
        setWorkspaceFilesPanel: vi.fn(),
        setWorkspaceSearchPanel: vi.fn(),
        reportWorkspaceFileFailure: failure,
        workspaceSearch: undefined as unknown as ReturnType<
          typeof createWorkspaceContentSearchService
        >,
        workspaceFiles: undefined as unknown as ReturnType<typeof createWorkspaceFilesController>
      });
      installMainPane(page);
      page.workspaceSearch = createWorkspaceContentSearchService({
        http: { request: () => response } as ScopedHttpService,
        onFailure: failure
      });
      page.workspaceFiles = createWorkspaceFilesController({
        target: () => (page.filesReady ? page.workspaceTarget : undefined),
        preflight: () => response,
        queue: vi.fn(),
        onFailure: failure,
        workspaceName: () => 'Workspace',
        list: async () => ({
          workspace: { id: 'one', kind: 'DIRECTORY', path: '/workspace' },
          entries: [],
          nextCursor: null
        }),
        onWorkspace: vi.fn(),
        mutate: async () => undefined,
        revealLocal: async () => {},
        onDeletedSelection: vi.fn(),
        onRevealSelection: vi.fn(async () => {}),
        onMutationFailure: vi.fn()
      });
      const view = renderComponent(Surface, { page });
      try {
        await flushComponent();
        const pending =
          tool === 'search'
            ? page.workspaceSearch.search({
                ...page.workspaceTarget,
                query: 'old',
                useRegex: false
              })
            : page.workspaceFiles.preflight([{ name: 'old.txt' } as File], '.');
        expect(
          tool === 'search'
            ? page.workspaceSearch.loading.value
            : page.workspaceFiles.preparing.value
        ).toBe(true);
        if (cause === 'aside')
          page.asideState = { ...page.asideState, active: { kind: 'tool', id: 'terminal' } };
        else if (cause === 'enabled') page.filesReady = false;
        else page.contentSearchReady = false;
        await nextTick();
        expect(
          tool === 'search'
            ? page.workspaceSearch.loading.value
            : page.workspaceFiles.preparing.value
        ).toBe(false);
        if (outcome === 'failure') reject(new Error('late failure'));
        else
          resolve(
            (tool === 'search'
              ? {
                  search: {
                    matches: [{ path: 'old.txt', line: 1, column: 1, preview: 'old' }],
                    truncated: false
                  }
                }
              : [{ status: 'READY', path: 'old.txt' }]) as never
          );
        await pending;
        expect(page.workspaceSearch.matches.value).toEqual([]);
        expect(page.workspaceSearch.error.value).toBeUndefined();
        expect(failure).not.toHaveBeenCalled();
      } finally {
        view.unmount();
      }
    }
  );
  it.each(['hidden', 'capability'] as const)(
    'invalidates the initial History bootstrap when %s while Changes is pending',
    async (reason) => {
      let finish!: (value: unknown) => void;
      const pending = new Promise<unknown>((resolve) => {
        finish = resolve;
      });
      const requests: string[] = [];
      const request = vi.fn((path: string) => {
        requests.push(path);
        return pending;
      });
      const failure = vi.fn();
      const page = shallowReactive({
        ...pageFixture(),
        workspaceHost: { connected: true },
        filesReady: true,
        selectedWorkspace: { kind: 'GIT_WORKSPACE' } as { kind: string } | undefined,
        nodeManifest: { git: { supportsHistory: true } } as { git: { supportsHistory: boolean } },
        workspaceWatchTopicStatus: {},
        workspaceKindLabel: () => '',
        workspaceBranchLabel: () => '',
        workspaceTabLabel: () => 'Workspace',
        workPromptCompletion: { enabled: false },
        asideState: { tools: ['history'], sessions: [], active: { kind: 'tool', id: 'history' } },
        workspaceGit: undefined as unknown as ReturnType<typeof createWorkspaceGitService>
      });
      installMainPane(page);
      page.workspaceGit = createWorkspaceGitService({
        http: { request } as ScopedHttpService,
        target: () => page.workspaceTarget,
        gitEnabled: () => page.selectedWorkspace?.kind === 'GIT_WORKSPACE',
        historyEnabled: () => page.nodeManifest.git.supportsHistory,
        onFailure: failure,
        onWorkspace: vi.fn(),
        onBranch: vi.fn()
      });
      const view = renderComponent(Surface, { page });
      try {
        await flushComponent();
        expect(requests).toHaveLength(1);
        expect(requests[0]).toContain('/workspaces/one/changes');
        if (reason === 'hidden')
          page.asideState = { ...page.asideState, active: { kind: 'tool', id: 'terminal' } };
        else page.nodeManifest = { git: { supportsHistory: false } };
        finish({
          changes: {
            workspace: { id: 'one', kind: 'GIT_WORKSPACE' },
            changes: [],
            repositories: []
          }
        });
        await flushComponent();
        expect(requests).toHaveLength(1);
        expect(page.workspaceGit.historyLoading.value).toBe(false);
        expect(page.workspaceGit.historyError.value).toBeUndefined();
        expect(failure).not.toHaveBeenCalled();
      } finally {
        view.unmount();
        page.workspaceGit.reset();
      }
    }
  );
  it.each(['zh-CN', 'en-US'] as const)(
    'renders Workspace recovery without an empty illustration and retries in %s',
    async (locale) => {
      const preference = localePreferenceService();
      const previousLocale = preference.locale.value;
      preference.setLocale(locale);
      const retry = vi.fn(() => {
        page.workspaceSelectionLoading = true;
      });
      const page = shallowReactive({
        ...pageFixture(),
        workspaceHost: { connected: true },
        workspaceSelectionLoading: false,
        retryWorkspaceSelection: retry
      });
      const view = renderComponent(Surface, { page });
      try {
        expect(view.findAll('ElEmpty')).toHaveLength(0);
        expect(textContent(view.root)).toContain(
          translate('generated.workbenchSurface.workspaceMetadataUnavailable')
        );
        const button = view
          .findAll('ElButton')
          .find((node) => textContent(node).includes(translate('common.loadFailedRetry')))!;
        await trigger(button, 'onClick');
        expect(retry).toHaveBeenCalledTimes(1);
        expect(view.findAll('ElButton')).toHaveLength(0);
        expect(view.findAll('div').some((node) => node.props['role'] === 'status')).toBe(true);
        expect(textContent(view.root)).not.toContain(
          translate('generated.workbenchSurface.workspaceMetadataUnavailable')
        );
        page.workspaceSelectionLoading = false;
        await flushComponent();
        expect(textContent(view.root)).toContain(translate('common.loadFailedRetry'));
        page.workspaceHost = { connected: false };
        await flushComponent();
        expect(textContent(view.root)).not.toContain(translate('common.loadFailedRetry'));
      } finally {
        view.unmount();
        preference.setLocale(previousLocale);
      }
    }
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'never labels a temporarily disabled Codex Composer as read-only in %s',
    async (locale) => {
      const preference = localePreferenceService();
      const previousLocale = preference.locale.value;
      preference.setLocale(locale);
      const page = shallowReactive({
        ...pageFixture(),
        selectedWorkspace: { id: 'one', kind: 'DIRECTORY', path: '/workspace' },
        workspaceHost: { connected: true, disabled: false },
        workspaceWatchTopicStatus: {},
        workspaceKindLabel: () => '',
        workspaceBranchLabel: () => '',
        workspaceTabLabel: () => 'Workspace',
        composerSessionOpen: true,
        composerRunner: 'codex',
        composerInputDisabled: true,
        composerWorking: false,
        nodeManifest: { manifestVersion: 1 } as object | undefined,
        nodeManifestLoading: false,
        conversationTurns: [],
        workPromptCompletion: { enabled: false }
      });
      const paneController = {
        state: {
          ...page.mainPane,
          workspaceTarget: ref(page.workspaceTarget),
          skillTokens: { remove: vi.fn() }
        },
        presentation: {
          composerSessionOpen: computed(() => page.composerSessionOpen),
          workspaceHost: computed(() => page.workspaceHost),
          composerWorking: computed(() => page.composerWorking),
          composerInputDisabled: computed(() => page.composerInputDisabled)
        },
        configuration: { activeRunner: computed(() => page.composerRunner) },
        runner: {},
        references: {},
        interactions: { registerShortcuts: () => () => undefined },
        currentSessionQueue: { items: [], paused: false },
        submitting: ref(false),
        canInterrupt: ref(false),
        performance: { current: ref(undefined) },
        filesReady: ref(false),
        terminalReady: ref(false),
        conversationWindow: { paging: { olderHistoryError: ref(undefined) } },
        selectedSessionId: ref(undefined),
        draftOpen: ref(false),
        nodeManifest: computed(() => page.nodeManifest),
        status: {
          manifestLoading: computed(() => page.nodeManifestLoading),
          connected: () => true,
          initialContentLoading: () => false
        },
        conversationSyncPending: ref(false),
        loading: ref(false),
        mobileViewport: ref(false),
        completion: ref(undefined),
        attachmentInput: {}
      };
      const view = renderComponent(SessionPane, { controller: paneController });
      try {
        const composer = () => view.findAll('composer-fixture')[0]!.props;
        expect(page.mainPane.setInputFocus).toHaveBeenCalledOnce();
        expect(page.mainPane.setRangeEditor).toHaveBeenCalledOnce();
        const guidance = translate(
          'generated.workbenchSurface.typeForCommandsToReferenceWorkspaceFiles',
          { value0: 'Codex' }
        );
        expect(composer()).toMatchObject({ placeholder: guidance, readonly: true, working: false });
        page.composerWorking = true;
        await flushComponent();
        expect(composer()).toMatchObject({ placeholder: guidance, readonly: true, working: true });
        page.composerInputDisabled = false;
        await flushComponent();
        expect(composer()).toMatchObject({ placeholder: guidance, readonly: false, working: true });
        page.composerInputDisabled = true;
        page.nodeManifest = undefined;
        page.nodeManifestLoading = true;
        await flushComponent();
        expect(composer()).toMatchObject({
          placeholder: translate('generated.workspaceInspector.loading'),
          readonly: true
        });
        page.nodeManifestLoading = false;
        await flushComponent();
        expect(composer()).toMatchObject({
          placeholder: translate(
            'generated.workbenchSurface.nodeWorkbenchCapabilitiesAreUnavailable'
          ),
          readonly: true
        });
      } finally {
        view.unmount();
        expect(page.mainPane.setInputFocus).toHaveBeenCalledTimes(2);
        expect(page.mainPane.setRangeEditor).toHaveBeenCalledTimes(2);
        preference.setLocale(previousLocale);
      }
    }
  );

  it('refreshes the host after the active management extension changes', async () => {
    const page = pageFixture();
    page.view = 'management';
    const view = renderComponent(Surface, { page });
    try {
      await trigger(
        view.findAll('button').find((node) => node.props['data-testid'] === 'extension')!,
        'onClick'
      );
      expect(page.refreshAdmin).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
    }
  });
  it('passes live registration readiness to the picker', async () => {
    const page = pageFixture();
    page.workspaceRegistrationNodeId = 'node';
    const view = renderComponent(Surface, { page });
    try {
      for (const allowed of [false, true]) {
        page.workspaceRegistrationReady = allowed;
        await flushComponent();
        expect(view.findAll('registration-picker')[0]?.props).toMatchObject({ nodeReady: allowed });
      }
    } finally {
      view.unmount();
    }
  });
  it('keeps cached terminal instances alive while switching tabs and hiding unavailable terminals', async () => {
    lifetime.mounted = 0;
    lifetime.unmounted = 0;
    const page = pageFixture();
    const view = renderComponent(Surface, { page });
    try {
      expect(lifetime.mounted).toBe(2);
      const docks = () => view.findAll('terminal-fixture');
      const formatError = docks()[0]!.props.errorMessage as (error: unknown) => string;
      expect(formatError(new Error('Fixture diagnostic'))).toContain('Fixture diagnostic');
      expect(docks().map((node) => node.props.enabled)).toEqual([true, false]);
      page.activeWorkspaceTabId = 'two';
      await flushComponent();
      expect(docks().map((node) => node.props.visible)).toEqual([false, true]);
      page.terminalReady = false;
      await flushComponent();
      expect(
        docks().every((node) => node.props.enabled === false && node.props.visible === false)
      ).toBe(true);
      expect(docks().every((node) => node.parent?.style.display === 'none')).toBe(true);
      expect(lifetime).toEqual({ mounted: 2, unmounted: 0 });
      page.workspaceTabs = page.workspaceTabs.slice(1);
      await flushComponent();
      expect(lifetime.unmounted).toBe(1);
    } finally {
      view.unmount();
    }
    expect(lifetime.unmounted).toBe(2);
  });

  it('keeps Dock ownership across temporary top-level views and destroys only removed tabs', async () => {
    lifetime.mounted = 0;
    lifetime.unmounted = 0;
    const page = pageFixture();
    const view = renderComponent(Surface, { page });
    try {
      const instances = [...page.terminalDocks.values()];
      expect(instances).toHaveLength(2);
      for (const target of ['settings', 'conversations', 'management']) {
        page.view = target;
        await flushComponent();
        expect(lifetime).toEqual({ mounted: 2, unmounted: 0 });
        expect([...page.terminalDocks.values()][0]).toBe(instances[0]);
        expect(view.findAll('terminal-fixture')).toHaveLength(2);
        expect(
          view
            .findAll('terminal-fixture')
            .every(
              (node) =>
                node.props.active === false &&
                node.props.enabled === false &&
                node.props.visible === false
            )
        ).toBe(true);
        page.view = 'nodes';
        await flushComponent();
        expect(lifetime).toEqual({ mounted: 2, unmounted: 0 });
        expect(view.findAll('terminal-fixture')[0]?.props.visible).toBe(true);
      }
      page.view = 'settings';
      page.workspaceTabs = page.workspaceTabs.slice(1);
      await flushComponent();
      expect(lifetime).toEqual({ mounted: 2, unmounted: 1 });
    } finally {
      view.unmount();
    }
    expect(lifetime).toEqual({ mounted: 2, unmounted: 2 });
  });

  it('mounts exactly one workspace tab strip at the placement selected by the viewport', async () => {
    const page = pageFixture();
    const view = renderComponent(Surface, { page });
    try {
      expect(view.findAll('tab-strip').map((node) => node.props.placement)).toEqual(['header']);
      page.mobileViewport = true;
      await flushComponent();
      expect(view.findAll('tab-strip').map((node) => node.props.placement)).toEqual(['body']);
      page.mobileViewport = false;
      await flushComponent();
      expect(view.findAll('tab-strip').map((node) => node.props.placement)).toEqual(['header']);
    } finally {
      view.unmount();
    }
  });
});
