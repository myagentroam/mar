import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { createWorkbenchPageController } from '../../src/service/workbench-page-controller.js';
import { createWorkbenchNavigationService } from '../../src/service/workbench-navigation-service.js';
import type { WorkbenchView } from '../../src/util/workbench-route.js';
import type { SettingsSection } from '../../src/model/settings.js';
import type { createWorkbenchLiveService } from '../../src/service/workbench-live-service.js';
import type { installWorkbenchPageLifecycle } from '../../src/service/workbench-page-lifecycle-service.js';
import type { createAdminAuthService } from '../../src/service/admin-auth-service.js';
import type {
  PwaApplicationService,
  PwaApplicationState
} from '../../src/service/pwa-application-service.js';
import { STANDALONE_FILE_OPEN_EVENT } from '../../src/service/standalone-file-window-service.js';
import * as feedback from '../../src/service/message-feedback-service.js';
import { translate } from '../../src/service/locale-preference-service.js';
import type { NodeSummary } from '../../src/model/node.js';
import type { Session } from '../../src/model/workbench.js';
import { renderComponent, flushComponent } from './support/component-renderer.js';

const captured = vi.hoisted(() => ({
  live: undefined as Parameters<typeof createWorkbenchLiveService>[0] | undefined,
  lifecycle: undefined as Parameters<typeof installWorkbenchPageLifecycle>[0] | undefined,
  authenticated: undefined as
    Parameters<typeof createAdminAuthService>[0]['onAuthenticated'] | undefined,
  waitForReady: vi.fn(async () => true),
  startWorkspace: vi.fn(async () => undefined),
  restartWorkspace: vi.fn(async () => undefined)
}));
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
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/agent-sessions/start') {
          starts.push(JSON.parse(String(init?.body)));
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
      await vi.waitFor(() => expect(page.selectedSessionId.value).toBe(main.id));
      // The Node's next authoritative directory page makes the created identity reachable.
      await page.refreshWorkspaceSessions();
      expect(page.workspaceSessionGroup.value).toBe(
        initialGroup === undefined ? undefined : 'MAIN'
      );
      expect(page.selectedSession.value?.id).toBe(main.id);
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
    const pwa = {
      state: ref(initial),
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
