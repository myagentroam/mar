import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { createWorkbenchPageController } from '../../src/service/workbench-page-controller.js';
import { mergeWorkspaceWatchSnapshot } from '../../src/service/workspace-runtime-state-service.js';
import * as directCoordinator from '../../src/service/workbench-direct-transport-coordinator.js';
import * as directRead from '../../src/service/workspace-direct-file-read-service.js';
import * as directObject from '../../src/service/workspace-direct-object-url-service.js';
import * as directDownload from '../../src/service/workspace-direct-download-stream-service.js';
import { createWorkbenchNavigationService } from '../../src/service/workbench-navigation-service.js';
import type { WorkbenchView } from '../../src/util/workbench-route.js';
import type { SettingsSection } from '../../src/model/settings.js';
import type { createWorkbenchLiveService } from '../../src/service/workbench-live-service.js';
import type { createWorkspaceWatchService } from '../../src/service/workspace-watch-service.js';
import type { installWorkbenchPageLifecycle } from '../../src/service/workbench-page-lifecycle-service.js';
import type { createAdminAuthService } from '../../src/service/admin-auth-service.js';
import type { createWorkbenchNotificationService } from '../../src/service/workbench-notification-service.js';
import type {
  PwaApplicationService,
  PwaApplicationState
} from '../../src/service/pwa-application-service.js';
import { STANDALONE_FILE_OPEN_EVENT } from '../../src/service/standalone-file-window-service.js';
import { ElMessageBox } from '../../src/service/message-box-service.js';
import * as feedback from '../../src/service/message-feedback-service.js';
import { translate } from '../../src/service/locale-preference-service.js';
import type { NodeSummary } from '../../src/model/node.js';
import type { Session } from '../../src/model/workbench.js';
import { renderComponent, flushComponent } from './support/component-renderer.js';

const captured = vi.hoisted(() => ({
  live: undefined as Parameters<typeof createWorkbenchLiveService>[0] | undefined,
  workspaceWatch: undefined as Parameters<typeof createWorkspaceWatchService>[0] | undefined,
  lifecycle: undefined as Parameters<typeof installWorkbenchPageLifecycle>[0] | undefined,
  authenticated: undefined as
    Parameters<typeof createAdminAuthService>[0]['onAuthenticated'] | undefined,
  signedOut: undefined as Parameters<typeof createAdminAuthService>[0]['onSignedOut'] | undefined,
  notificationOptions: undefined as Parameters<typeof createWorkbenchNotificationService>[1],
  waitForReady: vi.fn(async () => true),
  startWorkspace: vi.fn(async () => undefined),
  restartWorkspace: vi.fn(async () => undefined)
}));
vi.mock('../../src/service/workbench-notification-service.js', async (original) => {
  const actual =
    await original<typeof import('../../src/service/workbench-notification-service.js')>();
  return {
    ...actual,
    createWorkbenchNotificationService: (
      ...args: Parameters<typeof actual.createWorkbenchNotificationService>
    ) => {
      captured.notificationOptions = args[1];
      return actual.createWorkbenchNotificationService(...args);
    }
  };
});
vi.mock('../../src/service/workspace-watch-service.js', async (original) => {
  const actual = await original<typeof import('../../src/service/workspace-watch-service.js')>();
  return {
    ...actual,
    createWorkspaceWatchService: (
      options: Parameters<typeof actual.createWorkspaceWatchService>[0]
    ) => {
      captured.workspaceWatch = options;
      return actual.createWorkspaceWatchService(options);
    }
  };
});
// The controller owns callback wiring; transport and watch execution have their own suites.
vi.mock('../../src/service/workbench-live-service.js', () => ({
  createWorkbenchLiveService: (options: Parameters<typeof createWorkbenchLiveService>[0]) => {
    captured.live = options;
    return {
      connected: ref(false),
      waitForReady: captured.waitForReady,
      restore: vi.fn(),
      connect: vi.fn(),
      reconnect: vi.fn(),
      close: vi.fn(),
      sendDirect: vi.fn(),
      sendTerminalDirect: vi.fn()
    };
  }
}));
vi.mock('../../src/service/workbench-page-lifecycle-service.js', () => ({
  installWorkbenchPageLifecycle: (options: Parameters<typeof installWorkbenchPageLifecycle>[0]) => {
    captured.lifecycle = options;
  }
}));
vi.mock('../../src/service/hosted-conversation-watch-coordinator.js', async (original) => {
  const actual =
    await original<typeof import('../../src/service/hosted-conversation-watch-coordinator.js')>();
  return {
    createHostedConversationWatchCoordinator: (
      ...args: Parameters<typeof actual.createHostedConversationWatchCoordinator>
    ) => ({
      ...actual.createHostedConversationWatchCoordinator(...args),
      startWorkspace: captured.startWorkspace,
      restartWorkspace: captured.restartWorkspace
    })
  };
});
vi.mock('../../src/service/admin-auth-service.js', async (original) => {
  const module = await original<typeof import('../../src/service/admin-auth-service.js')>();
  return {
    ...module,
    createAdminAuthService: (options: Parameters<typeof module.createAdminAuthService>[0]) => {
      captured.authenticated = options.onAuthenticated;
      captured.signedOut = options.onSignedOut;
      return module.createAdminAuthService(options);
    }
  };
});

const mounted: ReturnType<typeof renderComponent>[] = [];
const node: NodeSummary = {
  id: 'node-a',
  displayName: 'Fixture node',
  registeredAddress: 'fixture.invalid',
  platform: 'linux',
  architecture: 'x64',
  nodeAppVersion: '0.10.1',
  nodeVersion: '24',
  connected: true,
  disabled: false,
  capabilities: {}
};
beforeEach(() => {
  vi.clearAllMocks();
  captured.waitForReady.mockResolvedValue(true);
  const location = new URL('https://console.example.test/console');
  const storage = { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('sessionStorage', storage);
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', { state: null, replaceState: vi.fn() });
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      location,
      history,
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
    })
  );
  vi.stubGlobal(
    'document',
    Object.assign(new EventTarget(), {
      visibilityState: 'visible',
      hasFocus: () => true,
      documentElement: { dataset: {}, style: { setProperty() {} } }
    })
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(JSON.stringify({ nodes: [], notifications: [], recentRuns: [] }))
    )
  );
});
afterEach(() => {
  captured.lifecycle?.disposeWebVersionUpdateCheck();
  for (const view of mounted.splice(0)) view.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function controller(pwaApplication?: PwaApplicationService) {
  const navigation = createWorkbenchNavigationService<WorkbenchView, SettingsSection, string>({
    initialView: 'nodes',
    initialSettingsSection: 'account',
    initialManagementSection: 'custom-system',
    opensMobileSidebar: (view) => view !== 'conversations'
  });
  const management = {
    items: vi.fn(() => [{ id: 'custom-nodes', labelKey: 'navigation.nodeManagement' }])
  };
  let page!: ReturnType<typeof createWorkbenchPageController>;
  mounted.push(
    renderComponent(
      defineComponent({
        setup() {
          page = createWorkbenchPageController({
            navigation,
            management,
            systemManagementSection: 'custom-system',
            nodeManagementSection: 'custom-nodes',
            webVersion: '9.8.7-fixture',
            ...(pwaApplication === undefined ? {} : { pwaApplication })
          });
          return () => h('div');
        }
      })
    )
  );
  return { page, navigation, management };
}

describe('Workbench controller composition behavior', () => {
  it('leaves Changes loading to the visible tool lifecycle when selected by shortcut', async () => {
    const { page } = controller();
    const workspace = { id: 'workspace-a', path: '/project', kind: 'GIT_WORKSPACE' as const };
    const target = { nodeId: node.id, workspaceId: workspace.id };
    page.nodes.value = [node];
    page.workspaceTarget.value = target;
    await nextTick();
    page.workspaces.value = [workspace];
    page.nodeManifest.value = {
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null },
      files: { available: true, reasonCode: null }
    };
    await nextTick();
    page.selectAsideTool({ ...target, id: 'files' });
    const loadChanges = vi.spyOn(page.workspaceGit, 'loadChanges').mockResolvedValue();
    const shortcut = captured.lifecycle!.workspaceShortcuts.find(
      (binding) => binding.command === 'workspace.changes'
    );
    expect(shortcut).toBeDefined();
    expect(shortcut!.execute({} as KeyboardEvent)).toBe('HANDLED');
    await nextTick();
    expect(page.asideState.value?.active).toEqual({ kind: 'tool', id: 'changes' });
    expect(loadChanges).not.toHaveBeenCalled();
  });

  it('uses the current CSRF token and renews it for a Files mutation', async () => {
    Object.assign(window, { sessionStorage });
    const { page } = controller();
    const workspace = { id: 'workspace-a', path: '/project', kind: 'DIRECTORY' as const };
    page.nodes.value = [node];
    page.workspaceTarget.value = { nodeId: node.id, workspaceId: workspace.id };
    await nextTick();
    page.workspaces.value = [workspace];
    page.nodeManifest.value = {
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null },
      files: { available: true, reasonCode: null },
      sessionAside: { apiVersion: 1 }
    };
    page.csrfToken.value = 'updated-after-owner-creation';
    const writes: (string | undefined)[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/files/mutate')) {
        writes.push((init?.headers as Record<string, string>)['x-csrf-token']);
        return writes.length === 1
          ? new Response(JSON.stringify({ error: { code: 'CSRF_INVALID' } }), { status: 403 })
          : new Response(JSON.stringify({}));
      }
      if (path === '/api/auth/csrf') return new Response(JSON.stringify({ csrfToken: 'renewed' }));
      return new Response(JSON.stringify({ files: { entries: [], nextCursor: null } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const scope = page.workspaceFiles.captureTarget();
    expect(scope).toBeDefined();
    await page.workspaceFiles.mutate(scope!, 'DELETE', 'obsolete.txt');
    expect(writes).toEqual(['updated-after-owner-creation', 'renewed']);
    expect(page.csrfToken.value).toBe('renewed');
  });
  it('routes live file and Git transport capabilities through the root-owned file workbench', async () => {
    const createCoordinator = directCoordinator.createWorkbenchDirectTransportCoordinator;
    const coordinator = vi
      .spyOn(directCoordinator, 'createWorkbenchDirectTransportCoordinator')
      .mockImplementation((input) => ({ ...createCoordinator(input), isConnected: () => true }));
    const bytes = new TextEncoder().encode('direct text');
    const range = vi.spyOn(directRead, 'readWorkspaceDirectFileRange').mockResolvedValue({
      bytes,
      size: bytes.length,
      offset: 0,
      nextOffset: null,
      revision: 'a'.repeat(64)
    });
    const object = vi.spyOn(directObject, 'readWorkspaceDirectObjectUrl').mockResolvedValue({
      url: 'blob:fixture',
      size: 10,
      revision: 'a'.repeat(64)
    });
    const download = vi
      .spyOn(directDownload, 'downloadWorkspaceDirectFile')
      .mockResolvedValue('COMPLETED');
    const pwa = {
      state: ref({ offline: 'online', checked: false }),
      subscribe: () => () => {},
      activeWorker: () => undefined
    } as unknown as PwaApplicationService;
    const { page } = controller(pwa);
    const workspace = { id: 'workspace-a', path: '/project', kind: 'GIT_WORKSPACE' as const };
    page.nodes.value = [node];
    page.workspaceTarget.value = { nodeId: node.id, workspaceId: workspace.id };
    await nextTick();
    page.workspaces.value = [workspace];
    page.workspaceTreeService.cacheWorkspaces(node.id, [workspace]);
    const manifest = {
      manifestVersion: 1,
      observedAt: 1,
      nodeGeneration: 'generation-a',
      conversation: { available: true, reasonCode: null },
      files: { available: true, reasonCode: null },
      sessionAside: { apiVersion: 1 },
      directTransfer: { range: true, download: true, gitCommitBlob: true }
    } as unknown as NonNullable<typeof page.nodeManifest.value>;
    page.nodeManifest.value = manifest;
    expect(coordinator).toHaveBeenCalledTimes(1);
    await page.fileWorkbench.openFile('direct.txt');
    await page.fileWorkbench.openTab({
      kind: 'HISTORY_TEXT',
      nodeId: node.id,
      workspaceId: workspace.id,
      path: 'history.txt',
      repositoryPath: '',
      worktreePath: '',
      commit: 'b'.repeat(40),
      refs: ['main']
    });
    expect(range.mock.calls.map(([input]) => input.resource.kind)).toEqual([
      'WORKSPACE_FILE',
      'GIT_COMMIT_BLOB'
    ]);
    await page.fileWorkbench.openFile('photo.png');
    await page.fileWorkbench.openTab({
      kind: 'HISTORY_TEXT',
      nodeId: node.id,
      workspaceId: workspace.id,
      path: 'history.png',
      repositoryPath: '',
      worktreePath: '',
      commit: 'b'.repeat(40),
      refs: ['main']
    });
    expect(object.mock.calls.map(([input]) => input.resource.kind)).toEqual([
      'WORKSPACE_FILE',
      'GIT_COMMIT_BLOB'
    ]);
    await page.fileWorkbench.downloadTarget({
      ...page.workspaceTarget.value!,
      path: 'download.txt'
    });
    await page.fileWorkbench.downloadTarget({
      ...page.workspaceTarget.value!,
      path: 'history.txt',
      history: { commit: 'b'.repeat(40), repositoryPath: '', refs: ['main'] }
    });
    expect(download.mock.calls.map(([input]) => input.resource.kind)).toEqual([
      'WORKSPACE_FILE',
      'GIT_COMMIT_BLOB'
    ]);
    const directReadsBeforeCapabilityChange = range.mock.calls.length;
    page.nodeManifest.value = {
      ...manifest,
      directTransfer: {
        ...manifest.directTransfer!,
        range: false,
        download: false,
        gitCommitBlob: false
      }
    };
    await page.fileWorkbench.openFile('fallback.txt');
    expect(range).toHaveBeenCalledTimes(directReadsBeforeCapabilityChange);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/files/read?'))).toBe(
      true
    );
  });
  it.each(['FILE_NOT_FOUND', 'PERMISSION_DENIED'])(
    'keeps a successful preview independent of a directory %s failure',
    async (code) => {
      const show = vi.spyOn(feedback, 'showMessage').mockImplementation(() => {});
      const { page } = controller();
      const workspace = { id: 'workspace-a', path: '/project', kind: 'DIRECTORY' as const };
      page.nodes.value = [node];
      page.workspaceTarget.value = { nodeId: node.id, workspaceId: workspace.id };
      await flushComponent();
      page.workspaceTreeService.cacheWorkspaces(node.id, [workspace]);
      page.workspaces.value = [workspace];
      page.nodeManifest.value = {
        manifestVersion: 1,
        observedAt: 1,
        conversation: { available: true, reasonCode: null },
        files: { available: true, reasonCode: null },
        sessionAside: { apiVersion: 1 }
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (request: string | URL | Request) => {
          const url = new URL(String(request), 'https://console.example.test');
          return url.pathname.endsWith('/files/read')
            ? new Response(
                JSON.stringify({
                  file: {
                    path: 'missing/result.md',
                    content: 'safe',
                    encoding: 'utf-8',
                    size: 4,
                    nextOffset: null,
                    revision: 'a'.repeat(64)
                  }
                })
              )
            : new Response(JSON.stringify({ error: code }), { status: 404 });
        })
      );
      await page.fileWorkbench.openFile('missing/result.md');
      await flushComponent();
      expect(page.fileWorkbench.frames.value[0]?.fileContent.value).toMatchObject({
        path: 'missing/result.md',
        content: 'safe'
      });
      expect(show).toHaveBeenCalledTimes(code === 'PERMISSION_DENIED' ? 1 : 0);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ error: code }), { status: 404 }))
      );
      await page.fileWorkbench.openWorkspaceFile('missing/failure.md');
      expect(show).toHaveBeenCalledTimes(code === 'PERMISSION_DENIED' ? 2 : 1);
    }
  );

  it('keeps Git changes when a file read reports an unavailable capability', async () => {
    const show = vi.spyOn(feedback, 'showMessage').mockImplementation(() => {});
    const { page } = controller();
    const workspace = { id: 'workspace-a', path: '/project', kind: 'GIT_WORKSPACE' as const };
    page.nodes.value = [node];
    page.workspaceTarget.value = { nodeId: node.id, workspaceId: workspace.id };
    await flushComponent();
    page.workspaceTreeService.cacheWorkspaces(node.id, [workspace]);
    page.workspaces.value = [workspace];
    page.nodeManifest.value = {
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null },
      files: { available: true, reasonCode: null },
      sessionAside: { apiVersion: 1 }
    };
    const changes = { changes: [{ path: 'kept.txt' }] };
    page.workspaceGit.restore({ changes });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'CAPABILITY_UNAVAILABLE' }), { status: 403 })
      )
    );
    await page.fileWorkbench.openWorkspaceFile('missing.txt');
    expect(page.workspaceGit.snapshot().changes).toEqual(changes);
    expect(show).toHaveBeenCalledOnce();
  });

  it('does not reapply stale Git Watch metadata after Files changes the Workspace kind', async () => {
    const { page } = controller();
    const workspace = { id: 'workspace-a', path: '/project', kind: 'GIT_WORKSPACE' as const };
    page.nodes.value = [node];
    page.workspaces.value = [workspace];
    page.workspaceTarget.value = { nodeId: node.id, workspaceId: workspace.id };
    await flushComponent();
    page.workspaceTreeService.cacheWorkspaces(node.id, [workspace]);
    page.workspaces.value = [workspace];
    page.nodeManifest.value = {
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null },
      files: { available: true, reasonCode: null },
      sessionAside: { apiVersion: 1 }
    };
    const update = (
      data: { files?: unknown; changes?: unknown },
      topic: 'files' | 'changes' | 'sessions'
    ) => {
      page.workspaceWatchSnapshot.value = mergeWorkspaceWatchSnapshot(
        page.workspaceWatchSnapshot.value,
        node.id,
        workspace.id,
        data,
        { topic, revision: 1 }
      );
    };
    update({ changes: { workspace, changes: [], repositories: [] } }, 'changes');
    await nextTick();
    update(
      {
        files: {
          files: { entries: [], nextCursor: null },
          workspace: { ...workspace, kind: 'DIRECTORY' }
        }
      },
      'files'
    );
    await nextTick();
    expect(page.selectedWorkspace.value?.kind).toBe('DIRECTORY');
    update({}, 'sessions');
    await nextTick();
    expect(page.selectedWorkspace.value?.kind).toBe('DIRECTORY');
    update({ changes: { workspace, changes: [], repositories: [] } }, 'changes');
    await nextTick();
    expect(page.selectedWorkspace.value?.kind).toBe('GIT_WORKSPACE');
  });

  it('restores hidden Search drafts per Workspace and distinguishes an absent panel from clearing', async () => {
    const { page } = controller();
    page.nodes.value = [node];
    page.workspaces.value = [
      { id: 'a', path: '/a', kind: 'DIRECTORY' },
      { id: 'b', path: '/b', kind: 'DIRECTORY' }
    ];
    let draft = { contentQuery: '', contentUseRegex: false };
    const panel = {
      focus: async () => {},
      snapshot: () => ({ ...draft }),
      restore: (value: { contentQuery?: unknown; contentUseRegex?: unknown }) => {
        draft = {
          contentQuery: typeof value.contentQuery === 'string' ? value.contentQuery : '',
          contentUseRegex: value.contentUseRegex === true
        };
      }
    };
    expect(await page.openQuickWorkspace(node.id, 'a')).toBe(true);
    page.setWorkspaceSearchPanel(panel);
    draft = { contentQuery: 'needle', contentUseRegex: true };
    expect(await page.openQuickWorkspace(node.id, 'b')).toBe(true);
    expect(draft).toEqual({ contentQuery: '', contentUseRegex: false });
    page.setWorkspaceSearchPanel(null);
    expect(await page.openQuickWorkspace(node.id, 'a')).toBe(true);
    expect(await page.openQuickWorkspace(node.id, 'b')).toBe(true);
    expect(await page.openQuickWorkspace(node.id, 'a')).toBe(true);
    page.setWorkspaceSearchPanel(panel);
    expect(draft).toEqual({ contentQuery: 'needle', contentUseRegex: true });
    draft = { contentQuery: '', contentUseRegex: false };
    expect(await page.openQuickWorkspace(node.id, 'b')).toBe(true);
    expect(await page.openQuickWorkspace(node.id, 'a')).toBe(true);
    expect(draft).toEqual({ contentQuery: '', contentUseRegex: false });
  });

  it('retains browser targets across Workspace switches but clears them on actual tab close and LRU eviction', async () => {
    const { page } = controller();
    const a = { nodeId: node.id, workspaceId: 'a' };
    const b = { nodeId: node.id, workspaceId: 'b' };
    page.nodes.value = [node];
    page.workspaceTarget.value = a;
    page.nodeManifest.value = {
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null },
      files: { available: true, reasonCode: null }
    };
    await nextTick();
    page.workspaceTabService.remember(node.id, node, { id: 'a', path: '/a', kind: 'DIRECTORY' });
    page.openHtmlAside('a.html');
    page.selectAsideTool({ ...a, id: 'files' });
    page.selectAsideBrowser(b);
    expect(page.asideState.value?.active).toEqual({ kind: 'tool', id: 'files' });
    page.selectAsideBrowser(a);
    page.closeAsideBrowser(b);
    expect(page.asideState.value?.active).toEqual({ kind: 'browser' });
    expect(page.asideState.value?.htmlPath).toBe('a.html');
    page.workspaceTarget.value = b;
    await nextTick();
    expect(page.asideState.value?.htmlPath).toBeUndefined();
    page.openHtmlAside('b.html');
    page.workspaceTarget.value = a;
    await nextTick();
    expect(page.asideState.value?.htmlPath).toBe('a.html');
    page.workspaceTarget.value = b;
    await nextTick();
    page.closeWorkspaceTab(page.workspaceTabs.value.find((tab) => tab.workspaceId === 'a')!);
    page.workspaceTarget.value = a;
    await nextTick();
    expect(page.asideState.value?.htmlPath).toBeUndefined();
    page.openHtmlAside('again.html');
    page.closeAsideBrowser(a);
    expect(page.asideState.value?.htmlPath).toBeUndefined();
    expect(page.asideState.value?.active).toEqual({ kind: 'tool', id: 'files' });
    page.openHtmlAside('again.html');
    page.workspaceTabService.restore(
      Array.from({ length: 8 }, (_, index) => ({
        id: `${node.id}:${index === 0 ? 'a' : `other-${index}`}`,
        nodeId: node.id,
        workspaceId: index === 0 ? 'a' : `other-${index}`,
        label: String(index),
        lastActiveAt: index + 1
      }))
    );
    page.workspaceTabService.remember(node.id, node, {
      id: 'new',
      path: '/new',
      kind: 'DIRECTORY'
    });
    expect(page.asideState.value?.htmlPath).toBeUndefined();
  });

  it('clears browser metadata when its Node is removed and on account sign-out', async () => {
    const { page } = controller();
    const a = { nodeId: node.id, workspaceId: 'a' };
    page.nodes.value = [node];
    page.workspaceTarget.value = a;
    page.nodeManifest.value = {
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null },
      files: { available: true, reasonCode: null }
    };
    await nextTick();
    page.openHtmlAside('a.html');
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue(
      'confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>
    );
    await page.deleteNode(node);
    page.workspaceTarget.value = a;
    page.nodeManifest.value = {
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null },
      files: { available: true, reasonCode: null }
    };
    await nextTick();
    expect(page.asideState.value?.htmlPath).toBeUndefined();
    page.openHtmlAside('new.html');
    captured.signedOut!();
    page.workspaceTarget.value = a;
    await nextTick();
    expect(page.asideState.value?.htmlPath).toBeUndefined();
  });

  it('projects and closes the image preview from its owning Main or Aside pane', () => {
    const { page } = controller();
    const main = page.mainPaneController.images;
    const aside = page.asidePaneController.images;
    aside.open({ name: 'aside.png', previewUrl: '/api/aside-image' });
    expect(page.conversationImagePreviewOpen.value).toBe(true);
    expect(page.conversationImagePreview.value).toEqual({
      name: 'aside.png',
      url: '/api/aside-image'
    });
    page.conversationImagePreviewOpen.value = false;
    expect(aside.previewOpen.value).toBe(false);
    main.open({ name: 'main.png', previewUrl: '/api/main-image' });
    expect(page.conversationImagePreview.value?.name).toBe('main.png');
    aside.open({ name: 'aside-again.png', previewUrl: '/api/aside-image-2' });
    expect(main.previewOpen.value).toBe(false);
    expect(page.conversationImagePreview.value?.name).toBe('aside-again.png');
    page.conversationImagePreviewOpen.value = false;
    page.conversationImagePreview.value = undefined;
    expect(aside.previewOpen.value).toBe(false);
    expect(aside.preview.value).toBeUndefined();
  });

  it('routes preview load failures to the pane that opened the image', async () => {
    const { page } = controller();
    const aside = vi.spyOn(page.asidePaneController.images, 'previewFailed');
    const main = vi.spyOn(page.mainPaneController.images, 'previewFailed');
    page.asidePaneController.images.open({ name: 'aside.png', previewUrl: '/api/aside-image' });
    await page.handleConversationImagePreviewError('/api/aside-image');
    expect(aside).toHaveBeenCalledWith('/api/aside-image');
    expect(main).not.toHaveBeenCalled();
  });

  it('projects only actually visible Main and Aside sessions to the notification owner', async () => {
    const { page } = controller();
    const workspace = { nodeId: 'node-a', workspaceId: 'workspace-a' };
    page.nodes.value = [{ ...node, nodeAppVersion: '0.11.69' }];
    page.workspaceTarget.value = workspace;
    page.workspaces.value = [{ id: workspace.workspaceId, path: '/project', kind: 'DIRECTORY' }];
    page.nodeManifest.value = {
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null },
      files: { available: true, reasonCode: null },
      sessionAside: { apiVersion: 1 }
    };
    await nextTick();
    page.draftSessionOpen.value = false;
    page.selectedSessionId.value = 'main';
    page.setAsideSurfaceVisible(true);
    expect(page.openAsideSession({ ...workspace, sessionId: 'background' })).toBe(true);
    expect(page.openAsideSession({ ...workspace, sessionId: 'aside' })).toBe(true);
    page.mainPaneController.state.conversation.loadingInitial.value = false;
    page.asidePaneController.state.conversation.loadingInitial.value = false;
    const visible = () => captured.notificationOptions?.activeTargets?.();
    expect(visible()).toEqual([
      { targetType: 'WORKSPACE_SESSION', ...workspace, sessionId: 'main' },
      { targetType: 'WORKSPACE_SESSION', ...workspace, sessionId: 'aside' }
    ]);
    page.nodes.value = [{ ...page.nodes.value[0]!, connected: false }];
    expect(visible()).toEqual([]);
    page.nodes.value = [{ ...page.nodes.value[0]!, connected: true }];
    expect(visible()).toEqual([
      { targetType: 'WORKSPACE_SESSION', ...workspace, sessionId: 'main' },
      { targetType: 'WORKSPACE_SESSION', ...workspace, sessionId: 'aside' }
    ]);
    page.mobileViewport.value = true;
    page.mobileWorkspaceSurface.value = 'inspector';
    expect(visible()).toEqual([]);
    page.asidePaneController.state.conversation.loadingInitial.value = false;
    expect(visible()).toEqual([
      { targetType: 'WORKSPACE_SESSION', ...workspace, sessionId: 'aside' }
    ]);
    page.selectAsideTool({ ...workspace, id: 'files' });
    expect(visible()).toEqual([]);
    page.mobileWorkspaceSurface.value = 'conversation';
    expect(visible()).toEqual([
      { targetType: 'WORKSPACE_SESSION', ...workspace, sessionId: 'main' }
    ]);
    page.draftSessionOpen.value = true;
    expect(visible()).toEqual([]);
  });

  it('marks the newly loaded recent session read only after it becomes visible', async () => {
    const { page } = controller();
    const workspace = { nodeId: 'node-a', workspaceId: 'workspace-a' };
    const session: Session = {
      id: 'recent-session',
      workspaceId: workspace.workspaceId,
      runner: 'codex',
      externalSessionId: 'native-recent',
      activity: 'IDLE'
    };
    page.nodes.value = [node];
    page.workspaces.value = [{ id: workspace.workspaceId, path: '/project', kind: 'DIRECTORY' }];
    page.workspaceTarget.value = workspace;
    page.draftSessionOpen.value = false;
    page.sessions.value = [session];
    const marked = vi.spyOn(page.workbenchNotificationService, 'markSessionRead');
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith('/watch') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        queueMicrotask(() =>
          captured.live!.onWatchEvent?.({
            type: 'watch.session.snapshot',
            watchType: 'session',
            ...workspace,
            sessionId: session.id,
            workbenchConnectionId: 'connection-a',
            watchId: body.watchId,
            nodeGeneration: 'generation-a',
            payload: { unit: 'SEGMENT', segments: [], nextCursor: null }
          })
        );
        return new Response(
          JSON.stringify({ watchId: body.watchId, nodeGeneration: 'generation-a' })
        );
      }
      return new Response(
        JSON.stringify({ session, sessions: [session], notifications: [], recentRuns: [] })
      );
    });
    captured.live!.onReady?.('connection-a', true);
    await flushComponent();
    page.workbenchNotificationService.notifications.value = [
      {
        id: 'unread-recent',
        source: 'server',
        kind: 'run',
        title: 'Completed',
        message: '',
        target: { targetType: 'WORKSPACE_SESSION', ...workspace, sessionId: session.id },
        read: false,
        createdAt: 1,
        updatedAt: 1,
        expiresAt: Date.now() + 60_000
      }
    ];
    page.selectedSessionId.value = 'previous-session';
    const opening = page.openRecentRun({
      ...workspace,
      runId: 'recent-run',
      sessionId: session.id,
      sessionTitle: 'Recent',
      runner: 'codex',
      status: 'SUCCEEDED',
      createdAt: 1,
      startedAt: 1,
      completedAt: 2,
      sortAt: 2,
      updatedAt: 2,
      version: 1
    });
    await flushComponent();
    expect(marked).not.toHaveBeenCalled();
    await flushComponent();
    page.confirmConversationInitialRender(page.conversationInitialRenderVersion.value);
    await opening;
    expect(page.initialConversationLoadFailed.value).toBe(false);
    expect(marked).toHaveBeenCalledWith(workspace.nodeId, workspace.workspaceId, session.id);
    await vi.waitFor(() =>
      expect(page.workbenchNotificationService.notifications.value[0]?.read).toBe(true)
    );
  });

  it('opens a tool change with the pane’s full workspace and session identity', () => {
    const { page } = controller();
    const openWorkspaceFileTab = vi
      .spyOn(page.fileWorkbench, 'openTab')
      .mockResolvedValue(undefined);
    page.nodes.value = [node];
    page.workspaceTarget.value = { nodeId: 'node-a', workspaceId: 'workspace-a' };
    page.nodeManifest.value = {
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null }
    };
    page.draftSessionOpen.value = false;
    page.selectedSessionId.value = 'session-a';
    const entry = {
      path: 'src/file.ts',
      change: 'MODIFIED',
      status: 'Modified',
      changeId: 'change-a',
      diff: {
        status: 'available' as const,
        source: 'TOOL_CHANGE' as const,
        format: 'unified-diff' as const,
        resourceRef: 'resource-a',
        byteSize: 1,
        sha256: 'a'.repeat(64)
      }
    };
    page.mainPaneController.openFileChange(entry);
    expect(openWorkspaceFileTab).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'node-a',
        workspaceId: 'workspace-a',
        path: 'src/file.ts',
        toolChange: expect.objectContaining({ scope: 'SESSION', sessionId: 'session-a' })
      })
    );
    page.selectedSessionId.value = undefined;
    page.mainPaneController.openFileChange(entry);
    expect(openWorkspaceFileTab).toHaveBeenCalledTimes(1);
  });

  it('gates navigation and removes only missing Aside targets from the active workspace', () => {
    const { page } = controller();
    const workspace = { nodeId: 'node-a', workspaceId: 'workspace-a' };
    page.nodes.value = [{ ...node, nodeAppVersion: '0.10.1' }];
    page.workspaceTarget.value = workspace;
    page.nodeManifest.value = {
      manifestVersion: 1,
      observedAt: 1,
      sessionAside: { apiVersion: 1 },
      conversation: { available: true, reasonCode: null }
    };
    expect(captured.workspaceWatch?.sessionNavigation?.()).toBeUndefined();
    page.nodes.value = [{ ...node, nodeAppVersion: '0.11.69' }];
    page.nodeManifest.value = {
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null }
    };
    expect(captured.workspaceWatch?.sessionNavigation?.()).toBeUndefined();
    page.nodeManifest.value = { ...page.nodeManifest.value, sessionAside: { apiVersion: 1 } };
    page.draftSessionOpen.value = false;
    page.selectedSessionId.value = 'main';
    expect(page.openAsideSession({ ...workspace, sessionId: 'gone' })).toBe(true);
    expect(captured.workspaceWatch?.sessionNavigation?.()).toEqual({
      sessionIds: ['gone'],
      summaryAnchors: ['main', 'gone'],
      limit: 100
    });

    const payload = { sessions: [], summaries: [], tree: null, missingSessionIds: ['gone'] };
    const query = captured.workspaceWatch!.sessionNavigation!()!;
    captured.workspaceWatch?.onSnapshot(
      'node-b',
      'workspace-a',
      { sessionNavigation: payload },
      'sessionNavigation',
      1,
      query
    );
    expect(page.asideState.value?.sessions).toEqual(['gone']);
    captured.workspaceWatch?.onSnapshot(
      'node-a',
      'workspace-a',
      { sessionNavigation: payload },
      'sessionNavigation',
      1,
      query
    );
    expect(page.asideState.value?.sessions).toEqual([]);
    expect(page.sessionNavigationSnapshot.value).toBeUndefined();
    const updatedQuery = captured.workspaceWatch!.sessionNavigation!()!;
    captured.workspaceWatch?.onSnapshot(
      'node-a',
      'workspace-a',
      { sessionNavigation: payload },
      'sessionNavigation',
      2,
      query
    );
    expect(page.sessionNavigationSnapshot.value).toBeUndefined();
    const updatedPayload = { ...payload, missingSessionIds: [] };
    captured.workspaceWatch?.onSnapshot(
      'node-a',
      'workspace-a',
      { sessionNavigation: updatedPayload },
      'sessionNavigation',
      1,
      updatedQuery
    );
    expect(page.sessionNavigationSnapshot.value).toMatchObject({ ...workspace, ...updatedPayload });
    page.workspaceTarget.value = { nodeId: 'node-b', workspaceId: 'workspace-a' };
    expect(page.sessionNavigationSnapshot.value).toBeUndefined();
  });

  it('keeps an Aside title while the captured tree query changes without exposing the old tree', () => {
    const { page } = controller();
    const workspace = { nodeId: 'node-a', workspaceId: 'workspace-a' };
    page.nodes.value = [{ ...node, nodeAppVersion: '0.11.69' }];
    page.workspaceTarget.value = workspace;
    page.nodeManifest.value = {
      manifestVersion: 1,
      observedAt: 1,
      sessionAside: { apiVersion: 1 },
      conversation: { available: true, reasonCode: null }
    };
    page.draftSessionOpen.value = false;
    page.selectedSessionId.value = 'main';
    page.openAsideSession({ ...workspace, sessionId: 'child' });
    const query = captured.workspaceWatch!.sessionNavigation!()!;
    const child = {
      id: 'child',
      parentSessionId: 'main',
      title: 'Child title',
      runner: 'codex',
      activity: 'IDLE',
      status: 'IDLE',
      lastActivityAt: 0
    };
    captured.workspaceWatch?.onSnapshot(
      'node-a',
      'workspace-a',
      {
        sessionNavigation: { sessions: [child], summaries: [], tree: null, missingSessionIds: [] }
      },
      'sessionNavigation',
      1,
      query
    );
    expect(page.asideSessionMetadata.value).toEqual([child]);
    page.setSessionTreeAnchor('main');
    expect(page.sessionNavigationSnapshot.value).toBeUndefined();
    expect(page.asideSessionMetadata.value).toEqual([child]);
    page.workspaceTarget.value = { nodeId: 'node-b', workspaceId: 'workspace-a' };
    expect(page.asideSessionMetadata.value).toEqual([]);
  });

  it.each(['ready', 'changed-target', 'hidden', 'closed'] as const)(
    'waits for the live connection before opening session history (%s)',
    async (outcome) => {
      let resolveReady!: (ready: boolean) => void;
      captured.waitForReady.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            resolveReady = resolve;
          })
      );
      const { page } = controller();
      const session: Session = {
        id: 'session-a',
        workspaceId: 'workspace-a',
        runner: 'codex',
        externalSessionId: 'native-a',
        activity: 'IDLE'
      };
      page.workspaceTarget.value = { nodeId: 'node-a', workspaceId: 'workspace-a' };
      page.sessions.value = [session];
      const watchRequests: Record<string, unknown>[] = [];
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (String(input).endsWith('/watch') && init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          watchRequests.push(body);
          queueMicrotask(() =>
            captured.live!.onWatchEvent?.({
              type: 'watch.session.snapshot',
              watchType: 'session',
              nodeId: 'node-a',
              workspaceId: 'workspace-a',
              sessionId: session.id,
              workbenchConnectionId: 'connection-a',
              watchId: body.watchId,
              nodeGeneration: 'generation-a',
              payload: { unit: 'SEGMENT', segments: [], nextCursor: null }
            })
          );
          return new Response(
            JSON.stringify({ watchId: body.watchId, nodeGeneration: 'generation-a' })
          );
        }
        return new Response(JSON.stringify({ session }));
      });
      const opening = page.openSessionFromList(session.id);
      await flushComponent();
      expect(captured.waitForReady).toHaveBeenCalledOnce();
      expect(watchRequests).toEqual([]);
      expect(page.loadingInitialConversation.value).toBe(true);
      expect(page.initialConversationLoadFailed.value).toBe(false);
      if (outcome === 'changed-target')
        page.workspaceTarget.value = { nodeId: 'node-b', workspaceId: 'workspace-b' };
      if (outcome === 'hidden') Object.assign(document, { visibilityState: 'hidden' });
      if (outcome === 'ready' || outcome === 'hidden')
        captured.live!.onReady?.('connection-a', true);
      resolveReady(outcome !== 'closed');
      await flushComponent();
      page.confirmConversationInitialRender(page.conversationInitialRenderVersion.value);
      await opening;
      expect(watchRequests).toHaveLength(outcome === 'ready' ? 1 : 0);
      expect(page.initialConversationLoadFailed.value).toBe(false);
      if (outcome === 'ready') expect(page.conversationSyncPending.value).toBe(false);
    }
  );
  it.each(['CHILD', 'MAIN', undefined] as const)(
    'keeps a newly submitted main session reachable after opening New from %s',
    async (initialGroup) => {
      const { page } = controller();
      page.nodes.value = [{ ...node, nodeAppVersion: '0.11.19' }];
      page.nodeManifest.value = {
        manifestVersion: 1,
        observedAt: 1,
        ...(initialGroup === undefined ? {} : { sessionGroups: { apiVersion: 1 } }),
        conversation: { available: true, reasonCode: null }
      };
      page.workspaces.value = [{ id: 'workspace-a', path: '/project', kind: 'DIRECTORY' }];
      page.workspaceTarget.value = { nodeId: 'node-a', workspaceId: 'workspace-a' };
      let created = false;
      const main: Session = {
        id: 'created-main',
        workspaceId: 'workspace-a',
        runner: 'codex',
        externalSessionId: 'native-created',
        sessionGroup: 'MAIN',
        nativeControl: 'MAR_MANAGED',
        activity: 'IDLE'
      };
      const child: Session = { ...main, id: 'child', sessionGroup: 'CHILD' };
      const starts: Record<string, unknown>[] = [];
      let finishStart!: () => void;
      const pendingStart = new Promise<void>((resolve) => (finishStart = resolve));
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/agent-sessions/start') {
          starts.push(JSON.parse(String(init?.body)));
          await pendingStart;
          created = true;
          return new Response(
            JSON.stringify({
              session: main,
              run: {
                id: 'created-run',
                sessionId: main.id,
                workspaceId: main.workspaceId,
                status: 'COMPLETED',
                startedAt: 1,
                completedAt: 2
              },
              delivery: 'STARTED'
            })
          );
        }
        if (url.pathname === '/api/agent-sessions') {
          const group = url.searchParams.get('sessionGroup');
          return new Response(
            JSON.stringify({
              sessions: group === 'CHILD' ? [child] : created ? [main] : [],
              nextCursor: null
            })
          );
        }
        return new Response(JSON.stringify({ csrfToken: 'fixture', nodes: [], profiles: [] }));
      });
      if (initialGroup !== undefined) page.selectWorkspaceSessionGroup(initialGroup);
      await flushComponent();
      if (initialGroup === 'CHILD') {
        await page.refreshWorkspaceSessions();
        expect(page.visibleWorkspaceSessions.value).toEqual([child]);
      }

      page.openNewSessionComposer();
      await flushComponent();
      page.sessionInput.value = 'Start a main session';
      page.sendSessionMessage();
      try {
        await vi.waitFor(() => expect(starts).toHaveLength(1));
        await flushComponent();
        expect(page.draftSessionOpen.value).toBe(false);
        expect(page.selectedSessionId.value).toMatch(/^draft:/);
        expect(page.mainPaneController.configuration.selectedSession.value?.id).toBe(
          page.selectedSessionId.value
        );
        expect(page.mainPaneController.presentation.composerSessionOpen.value).toBe(true);
      } finally {
        finishStart();
      }
      await vi.waitFor(() => expect(page.selectedSessionId.value).toBe(main.id));
      // The Node's next authoritative directory page makes the created identity reachable.
      await page.refreshWorkspaceSessions();
      expect(page.workspaceSessionGroup.value).toBe(
        initialGroup === undefined ? undefined : 'MAIN'
      );
      expect(page.selectedSession.value?.id).toBe(main.id);
      expect(page.mainPane.run.runs.value.some((run) => run.id === 'created-run')).toBe(true);
      expect(page.visibleWorkspaceSessions.value.map((session) => session.id)).toContain(main.id);
      expect(page.sessions.value.some((session) => session.id.startsWith('draft:'))).toBe(false);
      expect(starts).toHaveLength(1);
      expect(starts[0]).not.toHaveProperty('parentSessionId');
      expect(starts[0]).not.toHaveProperty('sessionGroup');
    }
  );

  it('returns an already open draft to Main only on explicit New, preserving manual group changes', async () => {
    const { page } = controller();
    page.nodes.value = [{ ...node, nodeAppVersion: '0.11.19' }];
    page.nodeManifest.value = {
      manifestVersion: 1,
      observedAt: 1,
      sessionGroups: { apiVersion: 1 },
      conversation: { available: true, reasonCode: null }
    };
    page.workspaceTarget.value = { nodeId: 'node-a', workspaceId: 'workspace-a' };
    page.openNewSessionComposer();
    page.sessionInput.value = 'Keep this draft';
    page.selectWorkspaceSessionGroup('CHILD');
    await flushComponent();
    expect(page.draftSessionOpen.value).toBe(true);
    expect(page.sessionInput.value).toBe('Keep this draft');
    expect(page.workspaceSessionGroup.value).toBe('CHILD');

    page.openNewSessionComposer();
    expect(page.workspaceSessionGroup.value).toBe('MAIN');
    expect(page.sessionInput.value).toBe('Keep this draft');
  });

  it.each([
    ['quick', 'MAIN'],
    ['recent', 'MAIN'],
    ['explicit-target', 'MAIN'],
    ['quick', 'CHILD'],
    ['recent', 'CHILD'],
    ['explicit-target', 'CHILD']
  ] as const)(
    'aligns navigation through %s to %s while list selection stays unchanged',
    async (entry, targetGroup) => {
      const { page } = controller();
      const main = {
        id: 'existing-main',
        workspaceId: 'workspace-a',
        sessionGroup: targetGroup,
        runner: 'codex' as const,
        nativeControl: 'MAR_MANAGED' as const,
        externalSessionId: 'native-main',
        activity: 'IDLE' as const,
        control: { level: 'MANAGED' as const, capabilities: ['turn.start'] }
      };
      page.nodes.value = [{ ...node, nodeAppVersion: '0.11.19' }];
      page.nodeManifest.value = {
        manifestVersion: 1,
        observedAt: 1,
        sessionGroups: { apiVersion: 1 },
        conversation: { available: true, reasonCode: null }
      };
      page.workspaceTarget.value = { nodeId: 'node-a', workspaceId: 'workspace-a' };
      page.sessions.value = [main];
      const previousGroup = targetGroup === 'MAIN' ? 'CHILD' : 'MAIN';
      page.selectWorkspaceSessionGroup(previousGroup);
      const manifest = page.nodeManifest.value;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                session: main,
                sessions: [main],
                turns: [],
                nextCursor: null,
                profiles: [],
                manifest,
                workspaces: [{ id: 'workspace-a', path: '/project', kind: 'DIRECTORY' }]
              })
            )
        )
      );

      if (entry === 'quick') await page.openSessionFromList(main.id);
      else if (entry === 'explicit-target') {
        await flushComponent();
        vi.mocked(fetch).mockClear();
        const opening = page.openSessionGroupTarget({
          nodeId: 'node-a',
          workspaceId: 'workspace-a',
          sessionId: main.id
        });
        await flushComponent();
        page.confirmConversationInitialRender(page.conversationInitialRenderVersion.value);
        await opening;
        expect(
          vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith('/api/workspaces?'))
        ).toBe(false);
      } else {
        await flushComponent();
        vi.mocked(fetch).mockClear();
        await page.openRecentRun({
          nodeId: 'node-a',
          workspaceId: 'workspace-a',
          runId: 'recent-run',
          sessionId: main.id,
          sessionTitle: 'Existing main',
          runner: 'codex',
          status: 'SUCCEEDED',
          createdAt: 1,
          startedAt: 1,
          completedAt: 2,
          sortAt: 2,
          updatedAt: 2,
          version: 1
        });
        expect(
          vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith('/api/workspaces?'))
        ).toBe(false);
      }
      await flushComponent();
      expect(page.selectedSessionId.value).toBe(main.id);
      expect(page.workspaceSessionGroup.value).toBe(
        entry === 'quick' ? previousGroup : targetGroup
      );
    }
  );

  it('applies the navigated session group when the Node manifest arrives later', async () => {
    const { page } = controller();
    const session: Session = {
      id: 'child-session',
      workspaceId: 'workspace-a',
      sessionGroup: 'CHILD',
      runner: 'codex'
    };
    page.nodes.value = [{ ...node, nodeAppVersion: '0.11.19' }];
    page.workspaceTarget.value = { nodeId: 'node-a', workspaceId: 'workspace-a' };
    page.sessions.value = [session];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ session, sessions: [session], turns: [] })))
    );
    const opening = page.openSessionGroupTarget({
      nodeId: 'node-a',
      workspaceId: 'workspace-a',
      sessionId: session.id
    });
    await flushComponent();
    page.confirmConversationInitialRender(page.conversationInitialRenderVersion.value);
    await opening;
    expect(page.workspaceSessionGroup.value).toBeUndefined();
    page.nodeManifest.value = {
      manifestVersion: 1,
      observedAt: 1,
      sessionGroups: { apiVersion: 1 },
      conversation: { available: true, reasonCode: null }
    };
    expect(page.workspaceSessionGroup.value).toBe('CHILD');
  });

  it.each(['session list', 'session detail'] as const)(
    'preserves a later manual group choice while loading the %s',
    async (stage) => {
      const { page } = controller();
      const session: Session = {
        id: 'child-session',
        workspaceId: 'workspace-a',
        sessionGroup: 'CHILD',
        runner: 'codex'
      };
      page.nodes.value = [{ ...node, nodeAppVersion: '0.11.19' }];
      page.nodeManifest.value = {
        manifestVersion: 1,
        observedAt: 1,
        sessionGroups: { apiVersion: 1 },
        conversation: { available: true, reasonCode: null }
      };
      page.workspaceTarget.value = { nodeId: 'node-a', workspaceId: 'workspace-a' };
      page.sessions.value = stage === 'session list' ? [] : [session];
      let resolveDetail: (() => void) | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (
            resolveDetail === undefined &&
            (stage === 'session list'
              ? String(url).startsWith('/api/agent-sessions?')
              : String(url).startsWith('/api/agent-sessions/child-session?'))
          )
            await new Promise<void>((resolve) => (resolveDetail = resolve));
          return new Response(JSON.stringify({ session, sessions: [session], turns: [] }));
        })
      );
      const opening = page.openSessionGroupTarget({
        nodeId: 'node-a',
        workspaceId: 'workspace-a',
        sessionId: session.id
      });
      await vi.waitFor(() => expect(resolveDetail).toBeDefined());
      page.selectWorkspaceSessionGroup('CHILD');
      page.selectWorkspaceSessionGroup('MAIN');
      resolveDetail!();
      await flushComponent();
      page.confirmConversationInitialRender(page.conversationInitialRenderVersion.value);
      await opening;
      expect(page.workspaceSessionGroup.value).toBe('MAIN');
      expect(page.selectedSessionId.value).toBe(session.id);
    }
  );

  it('coordinates a group change only within the same Workspace', async () => {
    const { page } = controller();
    page.nodes.value = [{ ...node, nodeAppVersion: '0.11.19' }];
    page.nodeManifest.value = {
      manifestVersion: 1,
      observedAt: 1,
      sessionGroups: { apiVersion: 1 },
      conversation: { available: true, reasonCode: null }
    };
    page.workspaceTarget.value = { nodeId: 'node-a', workspaceId: 'workspace-a' };
    await flushComponent();
    captured.startWorkspace.mockClear();
    captured.restartWorkspace.mockClear();

    page.selectWorkspaceSessionGroup('CHILD');
    await flushComponent();
    expect(captured.startWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-a');
    expect(captured.restartWorkspace).not.toHaveBeenCalled();

    captured.startWorkspace.mockClear();
    page.workspaceTarget.value = { nodeId: 'node-a', workspaceId: 'workspace-b' };
    await flushComponent();
    expect(page.workspaceSessionGroup.value).toBe('MAIN');
    expect(captured.startWorkspace).not.toHaveBeenCalled();
    expect(captured.restartWorkspace).not.toHaveBeenCalled();

    page.selectWorkspaceSessionGroup('CHILD');
    await flushComponent();
    expect(captured.startWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-b');
    expect(captured.restartWorkspace).not.toHaveBeenCalled();
  });

  it('shows only sessions in the current group page while retaining the selected session body', async () => {
    const { page } = controller();
    page.nodes.value = [{ ...node, nodeAppVersion: '0.11.19' }];
    page.nodeManifest.value = {
      manifestVersion: 1,
      observedAt: 1,
      sessionGroups: { apiVersion: 1 },
      conversation: { available: true, reasonCode: null }
    };
    page.workspaceTarget.value = { nodeId: 'node-a', workspaceId: 'workspace-a' };
    page.selectedSessionId.value = 'body-session';
    page.sessions.value = [
      {
        id: 'body-session',
        workspaceId: 'workspace-a',
        runner: 'codex',
        externalSessionId: 'native-body',
        sessionGroup: 'MAIN'
      },
      {
        id: 'listed-main',
        workspaceId: 'workspace-a',
        runner: 'codex',
        externalSessionId: 'native-listed',
        sessionGroup: 'MAIN'
      },
      {
        id: 'cached-ghost',
        workspaceId: 'workspace-a',
        runner: 'codex',
        externalSessionId: 'native-ghost',
        sessionGroup: 'MAIN'
      }
    ];
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessions: [
            {
              id: 'listed-main',
              workspaceId: 'workspace-a',
              runner: 'codex',
              externalSessionId: 'native-listed',
              sessionGroup: 'MAIN'
            }
          ],
          nextCursor: null
        })
      )
    );

    await page.refreshWorkspaceSessions();

    expect(page.sessions.value.map((session) => session.id)).toContain('body-session');
    expect(page.sessions.value.map((session) => session.id)).toContain('cached-ghost');
    expect(page.visibleWorkspaceSessions.value.map((session) => session.id)).toEqual([
      'listed-main'
    ]);
  });

  it('does not project ordinary session broadcasts before a Session Watch initial', () => {
    const { page } = controller();
    page.workspaceTarget.value = { nodeId: 'node-a', workspaceId: 'workspace-a' };
    page.selectedSessionId.value = 'session-a';
    const session = {
      id: 'session-a',
      workspaceId: 'workspace-a',
      runner: 'codex' as const,
      externalSessionId: 'native-a',
      runnerTitle: 'Original title',
      activity: 'IDLE' as const
    };
    page.sessions.value = [session];
    captured.live!.onEvent({
      nodeId: 'node-a',
      sequence: 1,
      category: 'session',
      payload: {
        session: { ...session, runnerTitle: 'Broadcast title', activity: 'MANAGED_ACTIVE' }
      }
    });
    expect(page.sessions.value).toEqual([session]);
  });

  it('toggles active mobile top menus without changing their selected page', () => {
    const { page } = controller();
    page.mobileViewport.value = true;
    for (const view of ['nodes', 'settings', 'management'] as const) {
      page.selectNavigation(view);
      expect(page.view.value).toBe(view);
      expect(page.mobileSidebarOpen.value).toBe(true);
      page.selectNavigation(view);
      expect(page.view.value).toBe(view);
      expect(page.mobileSidebarOpen.value).toBe(false);
    }
    page.selectNavigation('conversations');
    expect(page.hostedConversationMobileHistoryOpen.value).toBe(false);
    page.selectNavigation('conversations');
    expect(page.hostedConversationMobileHistoryOpen.value).toBe(true);
    page.selectNavigation('conversations');
    expect(page.hostedConversationMobileHistoryOpen.value).toBe(false);
    page.selectNavigation('conversations');
    expect(page.hostedConversationMobileHistoryOpen.value).toBe(true);
  });

  it.each(['nodes', 'conversations'] as const)(
    'switches to mobile %s content without opening a menu or retaining another tool surface',
    (view) => {
      const { page } = controller();
      page.mobileViewport.value = true;
      page.selectNavigation(view === 'nodes' ? 'conversations' : 'nodes');
      page.openMobileWorkspaceSurface('terminal');
      page.selectNavigation(view);
      expect(page.view.value).toBe(view);
      expect(page.mobileSidebarOpen.value).toBe(false);
      expect(page.hostedConversationMobileHistoryOpen.value).toBe(false);
      expect(page.mobileUtilityPanel.value).toBeUndefined();
      expect(page.mobileWorkspaceSurface.value).toBe('conversation');

      page.selectNavigation(view);
      expect(page.mobileSidebarOpen.value).toBe(view === 'nodes');
      expect(page.hostedConversationMobileHistoryOpen.value).toBe(view === 'conversations');
      page.selectMobileUtilityPanel('activity');
      page.selectNavigation(view === 'nodes' ? 'conversations' : 'nodes');
      expect(page.mobileSidebarOpen.value).toBe(false);
      expect(page.hostedConversationMobileHistoryOpen.value).toBe(false);
      expect(page.mobileUtilityPanel.value).toBeUndefined();
    }
  );

  it('replaces hosted history and utility drawers when switching mobile menus', () => {
    const { page } = controller();
    page.mobileViewport.value = true;
    page.selectNavigation('conversations');
    page.selectNavigation('conversations');
    expect(page.hostedConversationMobileHistoryOpen.value).toBe(true);
    page.selectMobileUtilityPanel('activity');
    expect(page.hostedConversationMobileHistoryOpen.value).toBe(false);
    expect(page.mobileUtilityPanel.value).toBe('activity');
    page.selectNavigation('conversations');
    expect(page.mobileUtilityPanel.value).toBeUndefined();
    expect(page.hostedConversationMobileHistoryOpen.value).toBe(true);
    page.selectMobileUtilityPanel('activity');
    page.selectNavigation('settings');
    expect(page.mobileUtilityPanel.value).toBeUndefined();
    expect(page.mobileSidebarOpen.value).toBe(true);
  });

  it('replaces hosted related files with global navigation without retaining a hidden tool layer', () => {
    const { page } = controller();
    page.mobileViewport.value = true;
    page.selectNavigation('conversations');
    page.hostedConversationMobileFilesOpen.value = true;
    page.selectMobileUtilityPanel('activity');
    expect(page.hostedConversationMobileFilesOpen.value).toBe(false);
    expect(page.mobileUtilityPanel.value).toBe('activity');
    page.hostedConversationMobileFilesOpen.value = true;
    page.selectNavigation('nodes');
    expect(page.hostedConversationMobileFilesOpen.value).toBe(false);
    expect(page.mobileSidebarOpen.value).toBe(false);
  });

  it('replaces a mobile utility menu with the active Work resource menu', () => {
    const { page } = controller();
    page.mobileViewport.value = true;
    page.selectMobileUtilityPanel('activity');
    page.selectNavigation('nodes');
    expect(page.mobileUtilityPanel.value).toBeUndefined();
    expect(page.mobileSidebarOpen.value).toBe(true);
    page.selectNavigation('nodes');
    expect(page.mobileSidebarOpen.value).toBe(false);
  });

  it('consumes host navigation and version rather than recreating defaults', () => {
    const { page, navigation, management } = controller();
    expect(page.view).toBe(navigation.view);
    expect(page.webVersion).toBe('9.8.7-fixture');
    expect(page.managementSection.value).toBe('custom-system');
    expect(page.managementItems.value.map((item) => item.id)).toEqual(['custom-nodes']);
    expect(management.items).toHaveBeenCalledWith(page.admin.value);
  });
  it('ignores stale notifications and routes an existing notification through the service', async () => {
    const { page } = controller();
    page.view.value = 'settings';
    page.workbenchNotificationService.notify({
      id: 'upload-a',
      kind: 'upload',
      title: 'Upload done',
      message: 'Ready',
      target: { nodeId: 'node-a' }
    });
    const notification = page.workbenchNotificationService.notifications.value[0]!;
    page.workbenchNotificationService.notifications.value = [];
    await page.openWorkbenchNotification(notification);
    expect(page.view.value).toBe('settings');
    page.workbenchNotificationService.notifications.value = [notification];
    await page.openWorkbenchNotification(notification);
    expect(page.view.value).toBe('nodes');
    expect(page.workbenchNotificationService.notifications.value[0]!.read).toBe(true);
  });
  it('projects lifecycle updates once and clears the notification after alignment', async () => {
    let listener!: (state: PwaApplicationState) => void;
    const initial: PwaApplicationState = { offline: 'ready', checked: true };
    const applyUpdate = vi.fn().mockResolvedValue('APPLIED');
    const pwa = {
      state: ref(initial),
      applyUpdate,
      subscribe(callback: (state: PwaApplicationState) => void) {
        listener = callback;
        callback(initial);
        return () => undefined;
      }
    } as unknown as PwaApplicationService;
    const { page } = controller(pwa);
    await captured.authenticated!();
    expect(page.workbenchNotificationService.notifications.value).toEqual([]);
    listener({
      offline: 'ready',
      checked: true,
      update: { mode: 'worker', action: 'activate', version: '9.8.7', buildId: 'new-build' }
    });
    expect(page.workbenchNotificationService.notifications.value).toEqual([
      expect.objectContaining({ kind: 'web-update', action: 'RELOAD_PAGE' })
    ]);
    expect(applyUpdate).not.toHaveBeenCalled();
    await page.openWorkbenchNotification(page.workbenchNotificationService.notifications.value[0]!);
    expect(applyUpdate).toHaveBeenCalledOnce();
    expect(applyUpdate).toHaveBeenCalledWith();
    listener({
      offline: 'preparing',
      checked: true,
      reload: { mode: 'worker', action: 'reload', version: '9.8.7', buildId: 'new-build' }
    });
    expect(page.workbenchNotificationService.notifications.value).toEqual([
      expect.objectContaining({ kind: 'web-update', action: 'RELOAD_PAGE' })
    ]);
    listener(initial);
    expect(page.workbenchNotificationService.notifications.value).toEqual([]);
    listener({
      offline: 'preparing',
      checked: true,
      reload: { mode: 'worker', action: 'reload', version: '9.8.7', buildId: 'other-build' }
    });
    expect(page.workbenchNotificationService.notifications.value).toEqual([]);
  });
  it('reports an unavailable waiting update as a failed check, not the latest version', async () => {
    const failure = new Error('Waiting worker not ready');
    const pwa = {
      state: ref<PwaApplicationState>({ offline: 'ready', checked: true }),
      checkForUpdate: vi.fn().mockRejectedValue(failure)
    } as unknown as PwaApplicationService;
    const showMessage = vi.spyOn(feedback, 'showMessage').mockImplementation(() => undefined);
    const { page } = controller(pwa);
    await page.checkForUpdates();
    expect(showMessage).toHaveBeenCalledWith(translate('webUpdate.checkFailed'), 'error', failure);
    expect(showMessage).not.toHaveBeenCalledWith(translate('webUpdate.upToDate'), 'info');
  });
  it.each([true, false])(
    'refreshes restored Node state without duplicate workspace Watch (resumed=%s)',
    async (resumed) => {
      const { page } = controller();
      page.workspaceTarget.value = { nodeId: 'node-a', workspaceId: 'workspace-a' };
      page.nodes.value = [{ ...node, connected: false }];
      vi.mocked(fetch).mockImplementation(
        async () => new Response(JSON.stringify({ nodes: [node] }))
      );
      const recover = vi.spyOn(page.workbenchNotificationService, 'recover').mockResolvedValue();
      captured.live!.onConnectionRestored?.(resumed);
      captured.live!.onReady?.('connection-a', resumed);
      await flushComponent();
      expect(fetch).toHaveBeenCalledWith('/api/nodes', expect.anything());
      expect(recover).toHaveBeenCalledOnce();
      expect(captured.startWorkspace).toHaveBeenCalledTimes(resumed ? 0 : 1);
      expect(captured.restartWorkspace).not.toHaveBeenCalled();
    }
  );
  it.each([false, true])(
    'serializes pending file intents and recovers after the first open (failed=%s)',
    async (failed) => {
      const { page } = controller();
      page.admin.value = {
        authenticated: true,
        mustChangePassword: false,
        isAdmin: true,
        managementWritable: true
      };
      page.nodes.value = [node];
      page.workspaceTarget.value = { nodeId: node.id, workspaceId: 'workspace-a' };
      page.nodeManifest.value = {
        manifestVersion: 1,
        observedAt: 1,
        conversation: { available: true, reasonCode: null },
        files: { available: true, reasonCode: null }
      };
      let finish!: () => void;
      let reject!: (error: Error) => void;
      const first = new Promise<void>((resolve, fail) => {
        finish = resolve;
        reject = fail;
      });
      let finishSecond!: () => void;
      const second = new Promise<void>((resolve) => {
        finishSecond = resolve;
      });
      const openFile = vi
        .fn()
        .mockImplementationOnce(() => first)
        .mockImplementationOnce(() => second);
      vi.spyOn(page.fileWorkbench, 'openFile').mockImplementation(openFile);
      const open = (path: string) =>
        window.dispatchEvent(
          new CustomEvent(STANDALONE_FILE_OPEN_EVENT, {
            detail: {
              url: `/console?standaloneFile=1&nodeId=node-a&workspaceId=${page.workspaceTarget.value!.workspaceId}&path=${path}`
            }
          })
        );
      open('first.ts');
      await flushComponent();
      expect(openFile).toHaveBeenCalledTimes(1);
      vi.mocked(history.replaceState).mockClear();
      page.workspaceTarget.value = { nodeId: node.id, workspaceId: 'workspace-b' };
      open('second.ts');
      await flushComponent();
      expect(openFile).toHaveBeenCalledTimes(1);
      expect(page.standaloneFileLoading.value).toBe(true);
      if (failed) reject(new Error('First open failed'));
      else finish();
      await flushComponent();
      expect(openFile).toHaveBeenNthCalledWith(2, 'second.ts', undefined, undefined);
      expect(history.replaceState).not.toHaveBeenCalled();
      expect(page.standaloneFileError.value).toBe(false);
      expect(page.standaloneFileLoading.value).toBe(true);
      finishSecond();
      await flushComponent();
      expect(page.standaloneFileLoading.value).toBe(false);
      expect(page.standaloneFileError.value).toBe(false);
      expect(String(vi.mocked(history.replaceState).mock.lastCall?.[2])).toContain(
        'path=second.ts'
      );
      expect(page.workspaceTarget.value.workspaceId).toBe('workspace-b');
    }
  );
  it('waits for the manifest, reports unavailable files, and accepts a later retry', async () => {
    const { page } = controller();
    page.admin.value = {
      authenticated: true,
      mustChangePassword: false,
      isAdmin: true,
      managementWritable: true
    };
    page.nodes.value = [node];
    page.workspaceTarget.value = { nodeId: node.id, workspaceId: 'workspace-a' };
    page.nodeManifestLoading.value = true;
    const openFile = vi.fn(async () => undefined);
    vi.spyOn(page.fileWorkbench, 'openFile').mockImplementation(openFile);
    const open = () =>
      window.dispatchEvent(
        new CustomEvent(STANDALONE_FILE_OPEN_EVENT, {
          detail: {
            url: '/console?standaloneFile=1&nodeId=node-a&workspaceId=workspace-a&path=retry.ts'
          }
        })
      );
    open();
    await flushComponent();
    expect(openFile).not.toHaveBeenCalled();
    expect(page.standaloneFileLoading.value).toBe(true);
    expect(page.standaloneFileError.value).toBe(false);
    page.nodeManifestLoading.value = false;
    await flushComponent();
    expect(page.standaloneFileLoading.value).toBe(false);
    expect(page.standaloneFileError.value).toBe(true);
    page.nodeManifest.value = {
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null },
      files: { available: true, reasonCode: null }
    };
    open();
    await flushComponent();
    expect(openFile).toHaveBeenCalledWith('retry.ts', undefined, undefined);
    expect(page.standaloneFileLoading.value).toBe(false);
    expect(page.standaloneFileError.value).toBe(false);
  });
});
