import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { createWorkbenchPageController } from '../../src/service/workbench-page-controller.js';
import { createWorkbenchNavigationService } from '../../src/service/workbench-navigation-service.js';
import type { WorkbenchView } from '../../src/util/workbench-route.js';
import type { SettingsSection } from '../../src/model/settings.js';
import type { createWorkbenchLiveService } from '../../src/service/workbench-live-service.js';
import type { installWorkbenchPageLifecycle } from '../../src/service/workbench-page-lifecycle-service.js';
import { STANDALONE_FILE_OPEN_EVENT } from '../../src/service/standalone-file-window-service.js';
import type { NodeSummary } from '../../src/model/node.js';
import { renderComponent, flushComponent } from './support/component-renderer.js';

const captured = vi.hoisted(() => ({
  live: undefined as Parameters<typeof createWorkbenchLiveService>[0] | undefined,
  lifecycle: undefined as Parameters<typeof installWorkbenchPageLifecycle>[0] | undefined,
  checkVersion: undefined as (() => Promise<void>) | undefined,
  startWorkspace: vi.fn(async () => undefined),
  restartWorkspace: vi.fn(async () => undefined)
}));
// The controller owns callback wiring; transport and watch execution have their own suites.
vi.mock('../../src/service/workbench-live-service.js', () => ({
  createWorkbenchLiveService: (options: Parameters<typeof createWorkbenchLiveService>[0]) => {
    captured.live = options;
    return {
      connected: ref(false),
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
vi.mock('../../src/service/web-version-update-service.js', async (original) => {
  const module = await original<typeof import('../../src/service/web-version-update-service.js')>();
  return {
    ...module,
    createWebVersionUpdateService: (
      ...args: Parameters<typeof module.createWebVersionUpdateService>
    ) => {
      const service = module.createWebVersionUpdateService(...args);
      captured.checkVersion = service.check;
      return service;
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

function controller() {
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
            webBuildHash: 'fixture-build'
          });
          return () => h('div');
        }
      })
    )
  );
  return { page, navigation, management };
}

describe('Workbench controller composition behavior', () => {
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
    captured.restartWorkspace.mockClear();

    page.selectWorkspaceSessionGroup('CHILD');
    await flushComponent();
    expect(captured.restartWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-a');

    captured.restartWorkspace.mockClear();
    page.workspaceTarget.value = { nodeId: 'node-a', workspaceId: 'workspace-b' };
    await flushComponent();
    expect(page.workspaceSessionGroup.value).toBe('MAIN');
    expect(captured.restartWorkspace).not.toHaveBeenCalled();

    page.selectWorkspaceSessionGroup('CHILD');
    await flushComponent();
    expect(captured.restartWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-b');
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
      page.selectMobileUtilityPanel('notifications');
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
    page.selectMobileUtilityPanel('recent-sessions');
    expect(page.hostedConversationMobileHistoryOpen.value).toBe(false);
    expect(page.mobileUtilityPanel.value).toBe('recent-sessions');
    page.selectNavigation('conversations');
    expect(page.mobileUtilityPanel.value).toBeUndefined();
    expect(page.hostedConversationMobileHistoryOpen.value).toBe(true);
    page.selectMobileUtilityPanel('notifications');
    page.selectNavigation('settings');
    expect(page.mobileUtilityPanel.value).toBeUndefined();
    expect(page.mobileSidebarOpen.value).toBe(true);
  });

  it('replaces hosted related files with global navigation without retaining a hidden tool layer', () => {
    const { page } = controller();
    page.mobileViewport.value = true;
    page.selectNavigation('conversations');
    page.hostedConversationMobileFilesOpen.value = true;
    page.selectMobileUtilityPanel('notifications');
    expect(page.hostedConversationMobileFilesOpen.value).toBe(false);
    expect(page.mobileUtilityPanel.value).toBe('notifications');
    page.hostedConversationMobileFilesOpen.value = true;
    page.selectNavigation('nodes');
    expect(page.hostedConversationMobileFilesOpen.value).toBe(false);
    expect(page.mobileSidebarOpen.value).toBe(false);
  });

  it('replaces a mobile utility menu with the active Work resource menu', () => {
    const { page } = controller();
    page.mobileViewport.value = true;
    page.selectMobileUtilityPanel('notifications');
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
  it('compares version manifests against the supplied build hash', async () => {
    const { page } = controller();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ version: '9.8.7-fixture', hash: 'fixture-build' }))
    );
    await captured.checkVersion!();
    expect(page.workbenchNotificationService.notifications.value).toEqual([]);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ version: '9.8.7-fixture', hash: 'new-build' }))
    );
    await captured.checkVersion!();
    expect(page.workbenchNotificationService.notifications.value).toEqual([
      expect.objectContaining({ kind: 'web-update', action: 'RELOAD_PAGE' })
    ]);
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
      const openFile = vi
        .fn()
        .mockImplementationOnce(() => first)
        .mockResolvedValue(undefined);
      page.workspaceInspector.value = { openFile } as unknown as NonNullable<
        typeof page.workspaceInspector.value
      >;
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
      page.workspaceTarget.value = { nodeId: node.id, workspaceId: 'workspace-b' };
      open('second.ts');
      await flushComponent();
      expect(openFile).toHaveBeenCalledTimes(1);
      expect(page.standaloneFileLoading.value).toBe(true);
      if (failed) reject(new Error('First open failed'));
      else finish();
      await flushComponent();
      expect(openFile).toHaveBeenNthCalledWith(2, 'second.ts', undefined, undefined);
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
    page.workspaceInspector.value = { openFile } as unknown as NonNullable<
      typeof page.workspaceInspector.value
    >;
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
