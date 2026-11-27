import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { createWorkbenchPageController } from '../../src/service/workbench-page-controller.js';
import * as directCoordinator from '../../src/service/workbench-direct-transport-coordinator.js';
import * as snapshotRefresh from '../../src/service/session-snapshot-refresh-service.js';
import * as directRead from '../../src/service/workspace-direct-file-read-service.js';
import * as directObject from '../../src/service/workspace-direct-object-url-service.js';
import * as directDownload from '../../src/service/workspace-direct-download-stream-service.js';
import * as fileStreamClient from '../../src/service/workspace-file-stream-client.js';
import * as draftOwner from '../../src/service/session-draft-service.js';
import { createAccountStorage } from '../../src/service/account-storage-service.js';
import * as attachmentOwner from '../../src/service/composer-attachment-service.js';
import * as hostedSelectionOwner from '../../src/service/hosted-conversation-selection-service.js';
import { createWorkbenchNavigationService } from '../../src/service/workbench-navigation-service.js';
import { createWorkspaceFileTabService } from '../../src/service/workspace-file-tab-service.js';
import type { WorkbenchView } from '../../src/util/workbench-route.js';
import type { SettingsSection } from '../../src/model/settings.js';
import type { createWorkbenchLiveService } from '../../src/service/workbench-live-service.js';
import type { createWorkspaceWatchService } from '../../src/service/workspace-watch-service.js';
import type { WorkspaceSessionPaneServices } from '../../src/service/workspace-session-pane-controller.js';
import type { installWorkbenchPageLifecycle } from '../../src/service/workbench-page-lifecycle-service.js';
import type { createAdminAuthService } from '../../src/service/admin-auth-service.js';
import type { createWorkbenchNotificationService } from '../../src/service/workbench-notification-service.js';
import type {
  PwaApplicationService,
  PwaApplicationState
} from '../../src/service/pwa-application-service.js';
import { STANDALONE_FILE_OPEN_EVENT } from '../../src/service/standalone-file-window-service.js';
import { MarMessageBox } from '../../src/service/message-box-service.js';
import * as feedback from '../../src/service/message-feedback-service.js';
import { translate } from '../../src/service/locale-preference-service.js';
import type { NodeSummary } from '../../src/model/node.js';
import type {
  NodeWorkbenchManifest,
  Session,
  Workspace,
  WorkspaceTarget
} from '../../src/model/workbench.js';
import { renderComponent, flushComponent } from './support/component-renderer.js';

vi.mock('@novnc/novnc', () => ({ default: class extends EventTarget {} }));

const captured = vi.hoisted(() => ({
  paneConstruction: [] as {
    workspace: Workspace | undefined;
    ready: boolean;
    revision: number;
    connected: boolean;
  }[],
  live: undefined as Parameters<typeof createWorkbenchLiveService>[0] | undefined,
  liveConnection: undefined as ReturnType<typeof createWorkbenchLiveService> | undefined,
  useRealWatches: false,
  workspaceWatch: undefined as Parameters<typeof createWorkspaceWatchService>[0] | undefined,
  lifecycle: undefined as Parameters<typeof installWorkbenchPageLifecycle>[0] | undefined,
  authenticated: undefined as
    Parameters<typeof createAdminAuthService>[0]['onAuthenticated'] | undefined,
  signedOut: undefined as Parameters<typeof createAdminAuthService>[0]['onSignedOut'] | undefined,
  accountChanged: undefined as Parameters<typeof createAdminAuthService>[0]['onAccountChanged'],
  notificationOptions: undefined as Parameters<typeof createWorkbenchNotificationService>[1],
  waitForReady: vi.fn(async () => true),
  connectLive: vi.fn(),
  startWorkspace: vi.fn(async () => undefined),
  restartWorkspace: vi.fn(async () => undefined),
  seedNodes: undefined as ((nodes: NodeSummary[]) => Promise<void>) | undefined,
  seedManifest: undefined as ((manifest: NodeWorkbenchManifest) => Promise<void>) | undefined,
  setTarget: undefined as ((target: WorkspaceTarget | undefined) => void) | undefined,
  setSession: undefined as ((id: string | undefined) => void) | undefined,
  setDraft: undefined as ((open: boolean) => void) | undefined,
  setSessions: undefined as ((sessions: readonly Session[]) => void) | undefined,
  setWorkspaces: undefined as ((workspaces: readonly Workspace[]) => void) | undefined,
  workspaceSelection: undefined as
    | ReturnType<
        typeof import('../../src/service/workbench-workspace-selection-service.js').createWorkbenchWorkspaceSelectionService
      >
    | undefined,
  capability: undefined as
    | ReturnType<
        typeof import('../../src/service/workbench-capability-service.js').createWorkbenchCapabilityService
      >
    | undefined,
  notificationService: undefined as
    ReturnType<typeof createWorkbenchNotificationService> | undefined,
  tree: undefined as
    | ReturnType<
        typeof import('../../src/service/workspace-tree-service.js').createWorkspaceTreeService
      >
    | undefined,
  tabs: undefined as
    | ReturnType<
        typeof import('../../src/service/workspace-tab-service.js').createWorkspaceTabService
      >
    | undefined,
  tools: undefined as
    | ReturnType<
        typeof import('../../src/service/workspace-file-tools-controller.js').createWorkspaceFileToolsController
      >
    | undefined,
  entities: undefined as
    | ReturnType<
        typeof import('../../src/service/workbench-entity-controller.js').createWorkbenchEntityController
      >
    | undefined,
  standaloneOpen: undefined as
    | ((
        intent: import('../../src/service/standalone-file-window-service.js').StandaloneFileOpenIntent
      ) => Promise<void>)
    | undefined,
  histories: [] as ReturnType<
    typeof import('../../src/service/workbench-session-history-mutation-service.js').createWorkbenchSessionHistoryMutationService
  >[],
  submissionAvailable: [] as (() => boolean)[]
}));
vi.mock('../../src/service/workspace-session-pane-controller.js', async (original) => {
  const module =
    await original<typeof import('../../src/service/workspace-session-pane-controller.js')>();
  return {
    ...module,
    createWorkspaceSessionPane: (...args: Parameters<typeof module.createWorkspaceSessionPane>) => {
      const owner = module.createWorkspaceSessionPane(...args);
      return {
        ...owner,
        connect: (
          services: WorkspaceSessionPaneServices,
          location: Parameters<typeof owner.connect>[1]
        ) => {
          // Constructors may inspect supplied state, without reading later page aggregates.
          captured.paneConstruction.push({
            workspace: services.selectedWorkspace.value,
            ready: services.completion.ready.value,
            revision: services.workspaceRevision(),
            connected: services.watchConnection.connected()
          });
          void services.completion.host.value;
          return owner.connect(services, location);
        }
      };
    }
  };
});
vi.mock('../../src/service/workbench-session-message-service.js', async (original) => {
  const module =
    await original<typeof import('../../src/service/workbench-session-message-service.js')>();
  return {
    ...module,
    createWorkbenchSessionMessageService: (
      options: Parameters<typeof module.createWorkbenchSessionMessageService>[0]
    ) => {
      captured.submissionAvailable.push(options.submissionAvailable!);
      return module.createWorkbenchSessionMessageService(options);
    }
  };
});
vi.mock('../../src/service/workbench-session-history-mutation-service.js', async (original) => {
  const module =
    await original<
      typeof import('../../src/service/workbench-session-history-mutation-service.js')
    >();
  return {
    ...module,
    createWorkbenchSessionHistoryMutationService: (
      ...args: Parameters<typeof module.createWorkbenchSessionHistoryMutationService>
    ) => {
      const history = module.createWorkbenchSessionHistoryMutationService(...args);
      captured.histories.push(history);
      return history;
    }
  };
});
vi.mock('../../src/service/standalone-file-bootstrap-controller.js', async (original) => {
  const module =
    await original<typeof import('../../src/service/standalone-file-bootstrap-controller.js')>();
  return {
    ...module,
    createStandaloneFileBootstrapController: (
      input: Parameters<typeof module.createStandaloneFileBootstrapController>[0]
    ) =>
      module.createStandaloneFileBootstrapController({
        ...input,
        open: (intent) => captured.standaloneOpen?.(intent) ?? input.open(intent)
      })
  };
});
vi.mock('../../src/service/workspace-tree-service.js', async (original) => {
  const module = await original<typeof import('../../src/service/workspace-tree-service.js')>();
  return {
    ...module,
    createWorkspaceTreeService: (...args: Parameters<typeof module.createWorkspaceTreeService>) =>
      (captured.tree = module.createWorkspaceTreeService(...args))
  };
});
vi.mock('../../src/service/workspace-tab-service.js', async (original) => {
  const module = await original<typeof import('../../src/service/workspace-tab-service.js')>();
  return {
    ...module,
    createWorkspaceTabService: (...args: Parameters<typeof module.createWorkspaceTabService>) =>
      (captured.tabs = module.createWorkspaceTabService(...args))
  };
});
vi.mock('../../src/service/workspace-file-tools-controller.js', async (original) => {
  const module =
    await original<typeof import('../../src/service/workspace-file-tools-controller.js')>();
  return {
    ...module,
    createWorkspaceFileToolsController: (
      ...args: Parameters<typeof module.createWorkspaceFileToolsController>
    ) => (captured.tools = module.createWorkspaceFileToolsController(...args))
  };
});
vi.mock('../../src/service/workbench-entity-controller.js', async (original) => {
  const module =
    await original<typeof import('../../src/service/workbench-entity-controller.js')>();
  return {
    ...module,
    createWorkbenchEntityController: (
      ...args: Parameters<typeof module.createWorkbenchEntityController>
    ) => (captured.entities = module.createWorkbenchEntityController(...args))
  };
});
vi.mock('../../src/service/workbench-capability-service.js', async (original) => {
  const module =
    await original<typeof import('../../src/service/workbench-capability-service.js')>();
  return {
    ...module,
    createWorkbenchCapabilityService: (
      options: Parameters<typeof module.createWorkbenchCapabilityService>[0]
    ) => {
      let nodes: NodeSummary[] | undefined;
      let manifest: NodeWorkbenchManifest | undefined;
      const service = module.createWorkbenchCapabilityService({
        ...options,
        request: async <T>(path: string, init?: RequestInit): Promise<T> => {
          if (path === '/api/nodes' && nodes !== undefined) return { nodes } as T;
          if (path.endsWith('/workbench-capabilities') && manifest !== undefined)
            return { manifest } as T;
          return options.request<T>(path, init);
        }
      });
      captured.capability = service;
      captured.seedNodes = async (value) => {
        nodes = value;
        try {
          await service.refreshNodes();
        } finally {
          nodes = undefined;
        }
      };
      captured.seedManifest = async (value) => {
        manifest = value;
        try {
          await service.refreshNodeManifest(options.workspaceTarget.value?.nodeId ?? 'node-a');
        } finally {
          manifest = undefined;
        }
      };
      captured.setWorkspaces = service.replaceWorkspaces;
      return service;
    }
  };
});
vi.mock('../../src/service/workbench-workspace-selection-service.js', async (original) => {
  const module =
    await original<typeof import('../../src/service/workbench-workspace-selection-service.js')>();
  return {
    ...module,
    createWorkbenchWorkspaceSelection: () => {
      const state = module.createWorkbenchWorkspaceSelectionState();
      captured.setTarget = (target) => {
        state.setTarget(target);
        captured.capability?.selectNode(target?.nodeId);
      };
      return {
        target: state.target,
        currentSelectionRevision: state.currentSelectionRevision,
        connect: (options: Parameters<typeof module.createWorkbenchWorkspaceSelectionService>[0]) =>
          (captured.workspaceSelection = module.createWorkbenchWorkspaceSelectionService(
            {
              ...options,
              workspaceTarget: state.target,
              setWorkspaceTarget: state.setTarget
            },
            state
          ))
      };
    }
  };
});
vi.mock('../../src/service/workbench-session-selection-service.js', async (original) => {
  const module =
    await original<typeof import('../../src/service/workbench-session-selection-service.js')>();
  return {
    ...module,
    createWorkbenchSessionSelection: (
      ...args: Parameters<typeof module.createWorkbenchSessionSelection>
    ) => {
      const selection = module.createWorkbenchSessionSelection(...args);
      captured.setSession = selection.setSession;
      captured.setDraft = selection.setDraftOpen;
      return selection;
    }
  };
});
vi.mock('../../src/service/workspace-session-service.js', async (original) => {
  const module = await original<typeof import('../../src/service/workspace-session-service.js')>();
  return {
    ...module,
    createWorkspaceSessionService: (
      ...args: Parameters<typeof module.createWorkspaceSessionService>
    ) => {
      const discovery = module.createWorkspaceSessionService(...args);
      captured.setSessions = discovery.projection.replaceAll;
      return discovery;
    }
  };
});
vi.mock('../../src/service/workbench-notification-service.js', async (original) => {
  const actual =
    await original<typeof import('../../src/service/workbench-notification-service.js')>();
  return {
    ...actual,
    createWorkbenchNotificationService: (
      ...args: Parameters<typeof actual.createWorkbenchNotificationService>
    ) => {
      captured.notificationOptions = args[1];
      const service = actual.createWorkbenchNotificationService(...args);
      captured.notificationService = service;
      return service;
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
vi.mock('../../src/service/workbench-live-service.js', async (original) => {
  const actual = await original<typeof import('../../src/service/workbench-live-service.js')>();
  return {
    createWorkbenchLiveService: (options: Parameters<typeof createWorkbenchLiveService>[0]) => {
      captured.live = options;
      if (captured.useRealWatches) {
        return (captured.liveConnection = actual.createWorkbenchLiveService({
          ...options,
          canConnect: () => true
        }));
      }
      return {
        connected: ref(false),
        waitForReady: captured.waitForReady,
        restore: vi.fn(),
        connect: captured.connectLive,
        reconnect: vi.fn(),
        close: vi.fn(),
        sendDirect: vi.fn(),
        sendTerminalDirect: vi.fn()
      };
    }
  };
});
vi.mock('../../src/service/workbench-page-lifecycle-service.js', () => ({
  installWorkbenchPageLifecycle: (options: Parameters<typeof installWorkbenchPageLifecycle>[0]) => {
    captured.lifecycle = options;
  }
}));
vi.mock('../../src/service/hosted-conversation-watch-coordinator.js', async (original) => {
  const actual =
    await original<typeof import('../../src/service/hosted-conversation-watch-coordinator.js')>();
  return {
    ...actual,
    createHostedConversationWatchCoordinator: (
      ...args: Parameters<typeof actual.createHostedConversationWatchCoordinator>
    ) => {
      const coordinator = actual.createHostedConversationWatchCoordinator(...args);
      return captured.useRealWatches
        ? coordinator
        : {
            ...coordinator,
            startWorkspace: captured.startWorkspace,
            restartWorkspace: captured.restartWorkspace
          };
    }
  };
});
vi.mock('../../src/service/admin-auth-service.js', async (original) => {
  const module = await original<typeof import('../../src/service/admin-auth-service.js')>();
  return {
    ...module,
    createAdminAuthService: (options: Parameters<typeof module.createAdminAuthService>[0]) => {
      captured.authenticated = options.onAuthenticated;
      captured.signedOut = options.onSignedOut;
      captured.accountChanged = options.onAccountChanged;
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
  captured.standaloneOpen = undefined;
  captured.histories.length = 0;
  captured.submissionAvailable.length = 0;
  captured.paneConstruction.length = 0;
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
      get localStorage() {
        return globalThis.localStorage;
      },
      get sessionStorage() {
        return globalThis.sessionStorage;
      },
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
  captured.liveConnection?.close();
  captured.liveConnection = undefined;
  captured.useRealWatches = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function controller(pwaApplication?: PwaApplicationService, initialView: WorkbenchView = 'nodes') {
  const navigation = createWorkbenchNavigationService<WorkbenchView, SettingsSection, string>({
    initialView,
    initialSettingsSection: 'account',
    initialManagementSection: 'custom-system',
    opensMobileSidebar: (view) => view !== 'conversations'
  });
  const management = {
    items: vi.fn(() => [
      { id: 'custom-nodes', labelKey: 'navigation.nodeManagement', icon: 'node' as const }
    ])
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
  captured.accountChanged?.(1);
  return { page, navigation, management };
}

describe('Workbench controller composition behavior', () => {
  it('starts realtime and restores the hosted deep link while the initial Node list is still pending', async () => {
    window.location.search = '?view=conversations&node=host-node&conversation=old-conversation';
    const { page } = controller(undefined, 'conversations');
    let finishNodes!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(async (path) =>
      path === '/api/nodes'
        ? new Promise<Response>((resolve) => (finishNodes = resolve))
        : new Response(JSON.stringify({ notifications: [], recentRuns: [] }))
    );

    const restoring = captured.authenticated!();
    await flushComponent();
    expect(captured.connectLive).toHaveBeenCalledOnce();
    expect(page.hosted.hostedConversationWorkspace.selectedConversationId.value).toBe(
      'old-conversation'
    );
    expect(page.hosted.restoringHostedConversationRoute).toBe(false);
    finishNodes(new Response(JSON.stringify({ nodes: [] })));
    await restoring;
  });

  it.each([true, false])(
    'does not let a late hosted deep link replace a newer selection (ready=%s)',
    async (ready) => {
      window.location.search = '?view=conversations&node=host-node&conversation=old-conversation';
      let finishLive!: (ready: boolean) => void;
      captured.waitForReady.mockReturnValue(new Promise((resolve) => (finishLive = resolve)));
      const { page } = controller(undefined, 'conversations');
      const restoring = captured.authenticated!();
      await flushComponent();
      expect(captured.waitForReady).toHaveBeenCalledOnce();
      await page.hosted.selectHostedConversation({
        nodeId: 'host-node',
        id: 'new-conversation'
      } as Parameters<typeof page.hosted.selectHostedConversation>[0]);
      finishLive(ready);
      await restoring;
      expect(page.hosted.hostedConversationWorkspace.selectedConversationId.value).toBe(
        'new-conversation'
      );
      expect(page.hosted.restoringHostedConversationRoute).toBe(false);
    }
  );

  it('does not queue a hidden mobile Work drawer during startup or failure', async () => {
    const { page } = controller();
    page.layout.mobileViewport = true;
    page.application.selectNavigation('nodes');
    expect(page.layout.mobileSidebarOpen).toBe(false);

    vi.mocked(fetch).mockImplementation(async (path) =>
      path === '/api/nodes'
        ? new Response('{}', { status: 503 })
        : new Response(JSON.stringify({ notifications: [], recentRuns: [] }))
    );
    await captured.authenticated!();
    expect(page.selection.workspaceStartupStatus).toBe('failed');
    page.application.selectNavigation('nodes');
    expect(page.layout.mobileSidebarOpen).toBe(false);

    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ nodes: [] })));
    page.selection.retryWorkspaceStartup();
    await flushComponent();
    expect(page.selection.workspaceStartupStatus).toBe('ready');
    expect(page.layout.mobileSidebarOpen).toBe(false);
    page.application.selectNavigation('nodes');
    expect(page.layout.mobileSidebarOpen).toBe(true);
  });

  it('does not reopen a hosted deep link after a newer selection is cleared', async () => {
    window.location.search = '?view=conversations&node=host-node&conversation=old-conversation';
    let finishLive!: (ready: boolean) => void;
    captured.waitForReady.mockReturnValue(new Promise((resolve) => (finishLive = resolve)));
    const { page } = controller(undefined, 'conversations');
    const restoring = captured.authenticated!();
    page.hosted.clearHostedConversation();
    finishLive(true);
    await restoring;
    expect(page.hosted.hostedConversationWorkspace.selectedConversationId.value).toBeUndefined();
    expect(page.hosted.restoringHostedConversationRoute).toBe(false);
  });

  it('restores the cached Workspace without waiting for realtime readiness', async () => {
    const workspace = { nodeId: node.id, workspaceId: 'workspace-a' };
    vi.spyOn(localStorage, 'getItem').mockImplementation((key) =>
      key.endsWith('mar.workbench.selection.v1') ? JSON.stringify({ workspace }) : null
    );
    captured.waitForReady.mockReturnValue(new Promise(() => {}));
    const { page } = controller();
    vi.mocked(fetch).mockImplementation(
      async (path) =>
        new Response(
          JSON.stringify(
            path === '/api/nodes'
              ? { nodes: [{ ...node, connected: false }] }
              : { notifications: [], recentRuns: [] }
          )
        )
    );

    expect(page.selection.workspaceStartupStatus).toBe('loading');
    await captured.authenticated!();
    expect(page.selection.workspaceStartupStatus).toBe('ready');
    expect(page.selection.workspaceTarget).toEqual(workspace);
    expect(captured.waitForReady).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'notifies Browser when the control socket is ready (resumed=%s)',
    (resumed) => {
      const { page } = controller();
      const controlReady = vi.spyOn(page.browser, 'controlReady');

      captured.live!.onReady!('browser-control-connection', resumed);

      expect(controlReady).toHaveBeenCalledOnce();
    }
  );

  it.each(['nodes', 'conversations'] as const)(
    'recovers only the active %s Watch after fresh and resumed readiness and a matching Node gap',
    async (view) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      captured.useRealWatches = true;
      const sockets: FakeSocket[] = [];
      class FakeSocket extends EventTarget {
        static readonly OPEN = 1;
        readonly readyState = FakeSocket.OPEN;
        readonly send = vi.fn();
        constructor() {
          super();
          sockets.push(this);
        }
        close(): void {
          this.dispatchEvent(new Event('close'));
        }
        frame(message: object): void {
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
        }
      }
      vi.stubGlobal('WebSocket', FakeSocket);
      const { page } = controller(undefined, view);
      const workspace = { nodeId: node.id, workspaceId: 'workspace-a' };
      await captured.seedNodes!([node]);
      captured.setWorkspaces!([{ id: workspace.workspaceId, path: '/project', kind: 'DIRECTORY' }]);
      captured.setTarget!(workspace);
      const hosted = page.hosted.hostedConversationWorkspace;
      hosted.selectConversation(node.id, 'conversation-a');
      const operations: Array<{
        path: string;
        method: string;
        body: { nodeId?: string; workbenchConnectionId: string; watchId: string; mode?: string };
      }> = [];
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const path = String(input);
        const method = init?.method ?? 'GET';
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (path.endsWith('/watch') || path.endsWith('/workbench-capabilities'))
          operations.push({ path, method, body });
        return new Response(
          JSON.stringify({
            nodes: [node],
            accepted: true,
            watchId: body.watchId,
            expiresAt: Date.now() + 30_000,
            nodeGeneration: 'generation-a'
          })
        );
      });
      const initials = () => operations.filter(({ body }) => body.mode === 'initial');
      const ready = (socket: FakeSocket, connection: string, resumed: boolean) =>
        socket.frame({
          type: 'workbench.ready',
          workbenchConnectionId: connection,
          workbenchResumeToken: `token-${connection}`,
          resumed
        });
      const watchPath =
        view === 'nodes'
          ? '/api/workspaces/workspace-a/watch'
          : '/api/nodes/node-a/hosted-conversations/conversation-a/watch';
      const expectInitials = (connections: string[]) => {
        expect(initials().map(({ path, body }) => [path, body.workbenchConnectionId])).toEqual(
          connections.map((connection) => [watchPath, connection])
        );
        const ids = initials().map(({ body }) => body.watchId);
        expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
        expect(new Set(ids).size).toBe(connections.length);
        if (view === 'nodes')
          expect(initials().every(({ body }) => body.nodeId === workspace.nodeId)).toBe(true);
      };
      const snapshot = (subscription: (typeof operations)[number]['body']) => {
        const identity = {
          workbenchConnectionId: subscription.workbenchConnectionId,
          watchId: subscription.watchId,
          nodeId: node.id,
          nodeGeneration: 'generation-a',
          revision: 1
        };
        return {
          type: 'watch.event',
          event:
            view === 'nodes'
              ? {
                  ...identity,
                  type: 'watch.workspace.snapshot',
                  workspaceId: workspace.workspaceId,
                  topic: 'sessions',
                  payload: { sessions: [] }
                }
              : {
                  ...identity,
                  type: 'watch.hosted-conversation.snapshot',
                  conversationId: 'conversation-a',
                  snapshotSequence: 1,
                  expiresAt: Date.now() + 30_000,
                  payload: {
                    conversation: {
                      id: 'conversation-a',
                      nodeId: node.id,
                      sessionId: 'hosted-session',
                      templateId: 'template-a',
                      templateName: 'Template',
                      activeVersionId: 'version-a',
                      title: 'Conversation',
                      titleSource: 'CUSTOM',
                      pinnedAt: null,
                      status: 'ACTIVE',
                      modelId: 'model-a',
                      createdAt: 1,
                      updatedAt: 1,
                      lastActivityAt: 1
                    },
                    template: {
                      id: 'template-a',
                      nodeId: node.id,
                      name: 'Template',
                      description: '',
                      status: 'ACTIVE',
                      currentVersionId: 'version-a',
                      available: true,
                      createdAt: 1,
                      updatedAt: 1
                    },
                    run: null,
                    turns: [],
                    historyNextCursor: null,
                    files: [],
                    models: [],
                    error: null,
                    snapshotSequence: 1
                  }
                }
        };
      };
      const watchReady = () =>
        view === 'nodes'
          ? page.application.workspaceWatchTopicStatus.sessions === 'ready'
          : hosted.watchReady.value;
      const confirm = async (socket: FakeSocket, index: number) => {
        expect(watchReady()).toBe(false);
        if (index > 0) {
          socket.frame(snapshot(initials()[index - 1]!.body));
          await flushComponent();
          expect(watchReady()).toBe(false);
        }
        socket.frame(snapshot(initials()[index]!.body));
        await flushComponent();
        expect(watchReady()).toBe(true);
      };

      captured.liveConnection!.connect();
      sockets[0]!.dispatchEvent(new Event('open'));
      expectInitials([]);
      ready(sockets[0]!, 'connection-original', false);
      await flushComponent();
      expectInitials(['connection-original']);
      await confirm(sockets[0]!, 0);

      sockets[0]!.close();
      await vi.advanceTimersByTimeAsync(500);
      sockets[1]!.dispatchEvent(new Event('open'));
      expectInitials(['connection-original']);
      ready(sockets[1]!, 'connection-fresh', false);
      await flushComponent();
      expectInitials(['connection-original', 'connection-fresh']);
      await confirm(sockets[1]!, 1);

      sockets[1]!.close();
      await vi.advanceTimersByTimeAsync(500);
      sockets[2]!.dispatchEvent(new Event('open'));
      expectInitials(['connection-original', 'connection-fresh']);
      ready(sockets[2]!, 'connection-fresh', true);
      await flushComponent();
      const connections = ['connection-original', 'connection-fresh', 'connection-fresh'];
      expectInitials(connections);
      if (view === 'conversations') await confirm(sockets[2]!, 2);

      sockets[2]!.frame({ type: 'resync-required', nodeId: 'other-node' });
      await flushComponent();
      expectInitials(connections);
      const recoveryStart = operations.length;
      sockets[2]!.frame({ type: 'resync-required', nodeId: node.id });
      await flushComponent();
      expectInitials([...connections, 'connection-fresh']);
      const recovery = operations.slice(recoveryStart);
      if (view === 'nodes') {
        expect(recovery[0]?.path).toBe('/api/nodes/node-a/workbench-capabilities');
      } else {
        expect(recovery.map(({ path, method }) => [path, method])).toEqual([
          [watchPath, 'DELETE'],
          [watchPath, 'POST']
        ]);
        expect(recovery[0]?.body).toEqual({
          watchId: initials()[2]!.body.watchId,
          workbenchConnectionId: 'connection-fresh'
        });
        await confirm(sockets[2]!, 3);
      }
    }
  );

  it('finishes hosted route restoration when navigation leaves conversations before readiness', async () => {
    window.location.search = '?view=conversations&node=host-node&conversation=old-conversation';
    const { page, navigation } = controller(undefined, 'conversations');
    expect(page.hosted.restoringHostedConversationRoute).toBe(true);
    navigation.selectView('settings');
    await captured.authenticated!();
    expect(page.hosted.restoringHostedConversationRoute).toBe(false);
    navigation.selectView('conversations');
    expect(page.hosted.restoringHostedConversationRoute).toBe(false);
  });

  it('restarts hosted route restoration for a new account and ignores the previous settlement', async () => {
    window.location.search = '?view=conversations&node=host-node&conversation=old-conversation';
    let finishPrevious!: () => void;
    let finishCurrent!: () => void;
    const previous = new Promise<void>((resolve) => {
      finishPrevious = resolve;
    });
    const current = new Promise<void>((resolve) => {
      finishCurrent = resolve;
    });
    const restoreTarget = vi.fn().mockReturnValueOnce(previous).mockReturnValueOnce(current);
    const clear = vi.fn();
    const createSelection = hostedSelectionOwner.createHostedConversationSelectionService;
    vi.spyOn(hostedSelectionOwner, 'createHostedConversationSelectionService').mockImplementation(
      (options) => {
        const owner = createSelection(options);
        clear.mockImplementation(owner.clear);
        return { ...owner, clear, restoreTarget };
      }
    );
    const { page } = controller(undefined, 'conversations');
    const previousRestoration = captured.authenticated!();
    await vi.waitFor(() => expect(restoreTarget).toHaveBeenCalledTimes(1));
    captured.signedOut!();
    captured.accountChanged!(2);
    expect(clear).toHaveBeenCalledOnce();
    expect(page.hosted.restoringHostedConversationRoute).toBe(true);
    const currentRestoration = captured.authenticated!();
    await vi.waitFor(() => expect(restoreTarget).toHaveBeenCalledTimes(2));
    finishPrevious();
    await previousRestoration;
    expect(page.hosted.restoringHostedConversationRoute).toBe(true);
    finishCurrent();
    await currentRestoration;
    expect(page.hosted.restoringHostedConversationRoute).toBe(false);
    captured.accountChanged!(2);
    expect(page.hosted.restoringHostedConversationRoute).toBe(false);
  });

  it('hands the same Node and Workspace to the next account without drafts, attachments or late upload side effects', async () => {
    function storage(): Storage {
      const values = new Map<string, string>();
      return {
        get length() {
          return values.size;
        },
        key: (index) => [...values.keys()][index] ?? null,
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
        removeItem: (key) => {
          values.delete(key);
        },
        clear: () => values.clear()
      };
    }
    const local = storage();
    const session = storage();
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', session);
    let release!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sendBody = vi.fn<
      ReturnType<typeof fileStreamClient.createWorkspaceFileStreamClient>['upload']
    >(() => uploadGate);
    vi.spyOn(fileStreamClient, 'createWorkspaceFileStreamClient').mockReturnValue({
      upload: sendBody,
      download: vi.fn()
    });
    const paths: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      paths.push(path);
      if (path === '/api/auth/login') {
        const { username } = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            authenticated: true,
            userId: username === 'first' ? 1 : 2,
            username,
            mustChangePassword: false,
            csrfToken: `csrf-${username}`
          })
        );
      }
      return new Response(
        JSON.stringify({
          nodes: [],
          workspaces: [],
          sessions: [],
          notifications: [],
          recentRuns: []
        })
      );
    });
    const attachments = vi.spyOn(attachmentOwner, 'createComposerAttachmentService');
    const created = vi.spyOn(draftOwner, 'createSessionDraftService');
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:first-account');
    const { page } = controller();
    const drafts = created.mock.results[0]!.value as ReturnType<
      typeof draftOwner.createSessionDraftService
    >;
    const owner = attachments.mock.results[0]!.value as ReturnType<
      typeof attachmentOwner.createComposerAttachmentService
    >;
    const target = { kind: 'workspace' as const, nodeId: node.id, workspaceId: 'shared-workspace' };
    await page.identity.login({ username: 'first', password: 'password' });
    const firstKey = page.identity.accountKey;
    const slot = drafts.forTarget(target);
    slot.input.value = 'Private first-account question';
    slot.persist();
    const pane = owner.forTarget(() => target);
    pane.add([new File(['image'], 'private.png', { type: 'image/png' })]);
    owner.openPreview(pane.attachments.value[0]!);
    await vi.waitFor(() => expect(sendBody).toHaveBeenCalledOnce());
    expect(paths.some((path) => path.endsWith('/uploads'))).toBe(false);
    expect(
      session.getItem('mar.account.v1.1.mar.workbench.draft.node-a.shared-workspace')
    ).not.toBeNull();
    try {
      await page.identity.login({ username: 'second', password: 'password' });
      expect(page.identity.admin.userId).toBe(2);
      expect(page.identity.accountKey).not.toBe(firstKey);
      expect(sendBody.mock.calls[0]?.[0].signal?.aborted).toBe(true);
      expect(pane.attachments.value).toEqual([]);
      expect(owner.preview.value).toBeUndefined();
      expect(revoked).toHaveBeenCalledWith('blob:first-account');
      expect(drafts.forTarget(target).input.value).toBe('');
      expect(
        session.getItem('mar.account.v1.1.mar.workbench.draft.node-a.shared-workspace')
      ).toBeNull();
      release();
      await flushComponent();
      expect(page.identity.admin.userId).toBe(2);
      expect(paths.some((path) => /\/(cancel|complete)$/.test(path))).toBe(false);
      expect(
        session.getItem('mar.account.v1.2.mar.workbench.draft.node-a.shared-workspace')
      ).toBeNull();
    } finally {
      release();
    }
  });

  it.each(
    (
      [
        'node-missing',
        'workspace-missing',
        'FORBIDDEN',
        'NODE_NOT_FOUND',
        'WORKSPACE_NOT_FOUND',
        '403',
        '404',
        'NODE_OFFLINE',
        'disconnected',
        'network',
        '500'
      ] as const
    ).flatMap((reason) =>
      (['message', 'queue'] as const).map((submission) => ({ reason, submission }))
    )
  )(
    'settles pending $submission according to actual Workspace selection invalidation: $reason',
    async ({ reason, submission }) => {
      const values = new Map<string, string>();
      const storage = {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => void values.set(key, value)),
        removeItem: vi.fn((key: string) => void values.delete(key)),
        clear: vi.fn(() => values.clear()),
        get length() {
          return values.size;
        },
        key: (index: number) => [...values.keys()][index] ?? null
      };
      vi.stubGlobal('sessionStorage', storage);
      const created = vi.spyOn(draftOwner, 'createSessionDraftService');
      const { page } = controller();
      const drafts = created.mock.results[0]!.value as ReturnType<
        typeof draftOwner.createSessionDraftService
      >;
      const workspace: Workspace = { id: 'workspace-a', path: '/project', kind: 'DIRECTORY' };
      const session: Session = {
        id: 'session-a',
        workspaceId: workspace.id,
        runner: 'codex',
        externalSessionId: 'native-a',
        nativeControl: 'MAR_MANAGED',
        activity: 'IDLE'
      };
      const target = {
        kind: 'session' as const,
        nodeId: node.id,
        workspaceId: workspace.id,
        sessionId: session.id
      };
      const manifest: NodeWorkbenchManifest = {
        manifestVersion: 1,
        observedAt: 1,
        conversation: { available: true, reasonCode: null }
      };
      let invalidate = false;
      let catalogReads = 0;
      let writes = 0;
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const path = new URL(String(input), location.href).pathname;
        if (
          path.endsWith('/messages') ||
          (path === '/api/queue-items/item' && init?.method === 'PATCH')
        ) {
          writes += 1;
          await pending;
          return new Response(
            JSON.stringify(
              submission === 'message'
                ? {
                    session,
                    run: {
                      id: 'late-run',
                      sessionId: session.id,
                      workspaceId: workspace.id,
                      status: 'COMPLETED',
                      startedAt: 1,
                      completedAt: 2
                    },
                    delivery: 'STARTED'
                  }
                : {}
            )
          );
        }
        if (path === '/api/workspaces') {
          catalogReads += 1;
          if (invalidate) {
            if (reason === 'network') throw new TypeError('Failed to fetch');
            if (reason === 'workspace-missing')
              return new Response(JSON.stringify({ workspaces: [] }));
            if (['403', '404', '500'].includes(reason))
              return new Response('{}', { status: Number(reason) });
            return new Response(JSON.stringify({ error: reason }), {
              status: reason === 'NODE_OFFLINE' ? 503 : 403
            });
          }
        }
        return new Response(
          JSON.stringify({
            manifest,
            workspaces: [workspace],
            sessions: [session],
            profiles: [],
            csrfToken: 'fixture'
          })
        );
      });
      await captured.seedNodes!([node]);
      captured.tree!.cacheWorkspaces(node.id, [workspace]);
      await captured.workspaceSelection!.select(target);
      await vi.waitFor(() => expect(captured.workspaceSelection!.loading.value).toBe(false));
      captured.setSessions!([session]);
      captured.setSession!(session.id);
      captured.setDraft!(false);
      await flushComponent();
      const slot = drafts.forTarget(target);
      slot.input.value = 'Pending input';
      if (submission === 'queue') {
        page.mainPaneController.state.queue.startEditing({
          queueItemId: 'item',
          content: 'Before edit'
        });
        page.mainPaneController.state.queue.editingContent.value = 'Pending queue edit';
      }
      slot.persist();
      const isolated = [
        { ...target, workspaceId: 'other-workspace' },
        { ...target, nodeId: 'other-node' }
      ].map((target) => {
        const slot = drafts.forTarget(target);
        slot.input.value = 'Other pending input';
        slot.persist();
        return { target, slot, settlement: slot.retain() };
      });
      const submitting =
        submission === 'message'
          ? page.mainPaneController.sendMessage()
          : page.mainPaneController.queueActions.save('item');
      try {
        await vi.waitFor(() => expect(writes).toBe(1));
        const revoked = !['NODE_OFFLINE', 'disconnected', 'network', '500'].includes(reason);
        const previousReads = catalogReads;
        invalidate = true;
        if (reason === 'node-missing') await captured.seedNodes!([]);
        if (reason === 'disconnected') await captured.seedNodes!([{ ...node, connected: false }]);
        await captured.workspaceSelection!.select(target);
        if (!['node-missing', 'disconnected'].includes(reason))
          await vi.waitFor(() => expect(catalogReads).toBeGreaterThan(previousReads));
        await vi.waitFor(() => expect(captured.workspaceSelection!.loading.value).toBe(false));
        await flushComponent();
        if (revoked) {
          expect(page.selection.workspaceTarget).toBeUndefined();
          expect(page.selection.workspaceTabs).toHaveLength(0);
        } else {
          expect(page.selection.workspaceTabs).toHaveLength(1);
          page.selection.closeWorkspaceTab(page.selection.workspaceTabs[0]!);
          await flushComponent();
        }
        storage.setItem.mockClear();
        storage.removeItem.mockClear();
        finish();
        await submitting;
        await flushComponent();
        if (revoked) {
          const draftWrites = [...storage.setItem.mock.calls, ...storage.removeItem.mock.calls]
            .map(([key]) => key.replace('mar.account.v1.1.', ''))
            .filter(
              (key) =>
                key.startsWith('mar.workbench.draft.') ||
                key.startsWith('mar.workbench.aside-draft.') ||
                key.startsWith('mar.workbench.queue-edit.')
            );
          expect(draftWrites).toEqual([]);
          expect(slot.input.value).toBe('Pending input');
          if (submission === 'queue')
            expect(slot.queueEdit.value?.content).toBe('Pending queue edit');
          storage.getItem.mockClear();
          drafts.forTarget(target);
          expect(storage.getItem).toHaveBeenCalledWith(
            `mar.account.v1.1.mar.workbench.draft.${node.id}.${workspace.id}`
          );
        } else {
          const restored = draftOwner.createSessionDraftService({
            target: ref(target),
            storage: createAccountStorage(storage as Storage, 1)
          });
          expect(restored.input.value).toBe(submission === 'message' ? '' : 'Pending input');
          expect(restored.queueEdit.value).toBeUndefined();
        }
        for (const other of isolated) {
          other.settlement.settle(() => {
            other.slot.input.value = '';
          });
          other.settlement.release();
          expect(
            draftOwner.createSessionDraftService({
              target: ref(other.target),
              storage: createAccountStorage(storage as Storage, 1)
            }).input.value
          ).toBe('');
        }
      } finally {
        finish();
        await submitting;
        for (const other of isolated) other.settlement.release();
      }
    }
  );

  it.each(
    (['node', 'workspace'] as const).flatMap((resource) =>
      (['success', 'failure', 'cancel'] as const).flatMap((outcome) =>
        (['message', 'queue'] as const).flatMap((submission) =>
          [false, true].map((closed) => ({ resource, outcome, submission, closed }))
        )
      )
    )
  )(
    'settles pending $submission only while its owner survives actual $resource removal: $outcome, closed $closed',
    async ({ resource, outcome, submission, closed }) => {
      const values = new Map<string, string>();
      const storage = {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => void values.set(key, value)),
        removeItem: vi.fn((key: string) => void values.delete(key)),
        clear: vi.fn(() => values.clear()),
        get length() {
          return values.size;
        },
        key: (index: number) => [...values.keys()][index] ?? null
      };
      vi.stubGlobal('sessionStorage', storage);
      const created = vi.spyOn(draftOwner, 'createSessionDraftService');
      const { page } = controller();
      const drafts = created.mock.results[0]!.value as ReturnType<
        typeof draftOwner.createSessionDraftService
      >;
      const workspace: Workspace = {
        id: 'workspace-a',
        path: '/project',
        kind: 'DIRECTORY',
        manageable: true
      };
      const session: Session = {
        id: 'session-a',
        workspaceId: workspace.id,
        runner: 'codex',
        externalSessionId: 'native-a',
        nativeControl: 'MAR_MANAGED',
        activity: 'IDLE'
      };
      const target = {
        kind: 'session' as const,
        nodeId: node.id,
        workspaceId: workspace.id,
        sessionId: session.id
      };
      await captured.seedNodes!([node]);
      captured.setTarget!(target);
      captured.setWorkspaces!([workspace]);
      captured.tree!.cacheWorkspaces(node.id, [workspace]);
      captured.tabs!.remember(node.id, node, workspace);
      await captured.seedManifest!({
        manifestVersion: 1,
        observedAt: 1,
        conversation: { available: true, reasonCode: null }
      });
      captured.setSessions!([session]);
      captured.setSession!(session.id);
      await flushComponent();
      const isolated = [
        { ...target, workspaceId: 'other-workspace' },
        { ...target, nodeId: 'other-node' }
      ].map((target) => {
        const slot = drafts.forTarget(target);
        slot.input.value = 'Other pending input';
        slot.persist();
        return { target, slot, settlement: slot.retain() };
      });
      const slot = drafts.forTarget(target);
      slot.input.value = 'Pending input';
      if (submission === 'queue') {
        page.mainPaneController.state.queue.startEditing({
          queueItemId: 'item',
          content: 'Before edit'
        });
        page.mainPaneController.state.queue.editingContent.value = 'Pending queue edit';
      }
      slot.persist();
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let writes = 0;
      let deletions = 0;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const path = new URL(String(input), location.href).pathname;
        if (init?.method === 'DELETE') {
          deletions += 1;
          if (outcome === 'failure')
            return new Response(
              JSON.stringify({ code: 'REJECTED', message: 'Deletion rejected' }),
              { status: 409 }
            );
        }
        if (
          path.endsWith('/messages') ||
          (path === '/api/queue-items/item' && init?.method === 'PATCH')
        ) {
          writes += 1;
          await pending;
          return new Response(
            JSON.stringify(
              submission === 'message'
                ? {
                    session,
                    run: {
                      id: 'late-run',
                      sessionId: session.id,
                      workspaceId: workspace.id,
                      status: 'COMPLETED',
                      startedAt: 1,
                      completedAt: 2
                    },
                    delivery: 'STARTED'
                  }
                : {}
            )
          );
        }
        return new Response(JSON.stringify({ csrfToken: 'fixture', nodes: [], profiles: [] }));
      });
      vi.spyOn(MarMessageBox, 'confirm').mockImplementation(async () => {
        if (outcome === 'cancel') throw new Error('cancel');
        return 'confirm' as Awaited<ReturnType<typeof MarMessageBox.confirm>>;
      });
      const submitting =
        submission === 'message'
          ? page.mainPaneController.sendMessage()
          : page.mainPaneController.queueActions.save('item');
      try {
        await vi.waitFor(() => expect(writes).toBe(1));
        if (closed) {
          page.selection.closeWorkspaceTab(
            page.selection.workspaceTabs.find((tab) => tab.workspaceId === workspace.id)!
          );
          await flushComponent();
        }
        if (resource === 'node') await captured.entities!.deleteNode(node);
        else await page.tree.removeWorkspace(node.id, workspace);
        expect(deletions).toBe(outcome === 'cancel' ? 0 : 1);
        if (outcome !== 'success' && !closed) {
          expect(page.selection.workspaceTabs.some((tab) => tab.workspaceId === workspace.id)).toBe(
            true
          );
          page.selection.closeWorkspaceTab(
            page.selection.workspaceTabs.find((tab) => tab.workspaceId === workspace.id)!
          );
        }
        await flushComponent();
        storage.setItem.mockClear();
        storage.removeItem.mockClear();
        finish();
        await submitting;
        await flushComponent();
        if (outcome === 'success') {
          const draftWriteKeys = [...storage.setItem.mock.calls, ...storage.removeItem.mock.calls]
            .map(([key]) => key.replace('mar.account.v1.1.', ''))
            .filter(
              (key) =>
                key.startsWith('mar.workbench.draft.') ||
                key.startsWith('mar.workbench.aside-draft.') ||
                key.startsWith('mar.workbench.queue-edit.')
            );
          expect(draftWriteKeys).toEqual([]);
          expect(slot.input.value).toBe('Pending input');
          if (submission === 'queue')
            expect(slot.queueEdit.value?.content).toBe('Pending queue edit');
          // A removed owner must not have recreated its slot or its Composer in the cache.
          storage.getItem.mockClear();
          drafts.forTarget(target);
          expect(storage.getItem).toHaveBeenCalledWith(
            `mar.account.v1.1.mar.workbench.draft.${node.id}.${workspace.id}`
          );
        } else {
          const restored = draftOwner.createSessionDraftService({
            target: ref(target),
            storage: createAccountStorage(storage as Storage, 1)
          });
          expect(restored.input.value).toBe(submission === 'message' ? '' : 'Pending input');
          expect(restored.queueEdit.value).toBeUndefined();
        }
        for (const other of isolated) {
          other.settlement.settle(() => {
            other.slot.input.value = '';
          });
          other.settlement.release();
          const invalidated =
            resource === 'node' && outcome === 'success' && other.target.nodeId === node.id;
          expect(
            draftOwner.createSessionDraftService({
              target: ref(other.target),
              storage: createAccountStorage(storage as Storage, 1)
            }).input.value
          ).toBe(invalidated ? 'Other pending input' : '');
        }
      } finally {
        finish();
        await submitting;
        for (const other of isolated) other.settlement.release();
      }
    }
  );

  it('releases draft cache owners on actual tab close and account sign-out', async () => {
    const created = vi.spyOn(draftOwner, 'createSessionDraftService');
    const { page } = controller();
    const owner = created.mock.results[0]!.value as ReturnType<
      typeof draftOwner.createSessionDraftService
    >;
    const a = { kind: 'workspace' as const, nodeId: node.id, workspaceId: 'a' };
    const b = { kind: 'workspace' as const, nodeId: node.id, workspaceId: 'b' };
    await captured.seedNodes!([node]);
    captured.tabs!.remember(node.id, node, { id: 'a', path: '/a', kind: 'DIRECTORY' });
    captured.tabs!.remember(node.id, node, { id: 'b', path: '/b', kind: 'DIRECTORY' });
    captured.setTarget!(b);
    await nextTick();
    const first = owner.forTarget(a);
    page.selection.closeWorkspaceTab(
      page.selection.workspaceTabs.find((tab) => tab.workspaceId === 'a')!
    );
    expect(owner.forTarget(a)).not.toBe(first);
    const second = owner.forTarget(b);
    captured.signedOut!();
    await nextTick();
    expect(owner.forTarget(b)).not.toBe(second);
  });

  it('does not reuse the previous account Changes fetch after signing out', async () => {
    const { page } = controller();
    const workspace = { id: 'workspace-a', path: '/project', kind: 'GIT_WORKSPACE' as const };
    const activate = async () => {
      await captured.seedNodes!([node]);
      captured.setTarget!({ nodeId: node.id, workspaceId: workspace.id });
      await flushComponent();
      captured.tree!.cacheWorkspaces(node.id, [workspace]);
      captured.setWorkspaces!([workspace]);
      await captured.seedManifest!({
        manifestVersion: 1,
        observedAt: 1,
        conversation: { available: true, reasonCode: null },
        files: { available: true, reasonCode: null },
        git: { available: true, reasonCode: null, supportsHistory: true }
      });
    };
    let fetches = 0;
    vi.mocked(fetch).mockImplementation(async (request) => {
      const result = String(request).includes('/git/fetch')
        ? { fetchFailed: ++fetches === 1, updated: false }
        : { changes: [] };
      return new Response(JSON.stringify(result));
    });
    await activate();
    await page.files.workspaceGit.loadChanges(true);
    await vi.waitFor(() => expect(page.files.workspaceGit.changesFetchFailed.value).toBe(true));
    captured.signedOut!();
    await flushComponent();
    await activate();
    await page.files.workspaceGit.loadChanges(true);
    await vi.waitFor(() => expect(fetches).toBe(2));
    expect(page.files.workspaceGit.changesFetchFailed.value).toBe(false);
  });

  it('provides complete resource and selection state before either Pane connects', () => {
    controller();
    expect(captured.paneConstruction).toEqual([
      { workspace: undefined, ready: false, revision: 0, connected: false },
      { workspace: undefined, ready: false, revision: 0, connected: false }
    ]);
  });

  it('keeps history operation loading independent for Main and Aside', () => {
    const { page } = controller();
    const main = page.mainPaneController;
    const aside = page.aside.asidePaneController;
    main.state.conversation.loadingInitial.value = false;
    aside.state.conversation.loadingInitial.value = false;
    expect(captured.histories).toHaveLength(2);
    expect(captured.submissionAvailable.map((available) => available())).toEqual([true, true]);
    expect(main.loading.value).toBe(false);
    expect(aside.loading.value).toBe(false);
    captured.histories[0]!.pending.value = true;
    expect(main.loading.value).toBe(true);
    expect(aside.loading.value).toBe(false);
    expect(captured.submissionAvailable.map((available) => available())).toEqual([false, true]);
    captured.histories[1]!.pending.value = true;
    captured.histories[0]!.pending.value = false;
    expect(main.loading.value).toBe(false);
    expect(aside.loading.value).toBe(true);
    expect(captured.submissionAvailable.map((available) => available())).toEqual([true, false]);
    captured.histories[1]!.pending.value = false;
    expect(aside.loading.value).toBe(false);
    expect(captured.submissionAvailable.map((available) => available())).toEqual([true, true]);
  });
  it('protects suspended drafts on unload but permits PWA updates and removes its listener on unmount', () => {
    const isReloadingForUpdate = vi.fn(() => false);
    const { page } = controller({
      state: ref<PwaApplicationState>({ offline: 'ready', checked: true }),
      isReloadingForUpdate
    } as unknown as PwaApplicationService);
    const unload = () => window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    expect(unload()).toBe(true);
    const tabs = createWorkspaceFileTabService();
    const tab = tabs.open({
      kind: 'WORKTREE_TEXT',
      nodeId: node.id,
      workspaceId: 'workspace-a',
      path: 'index.html',
      repositoryPath: '',
      worktreePath: ''
    });
    page.files.fileWorkbench.restore({
      fileTabs: tabs.snapshot(),
      dirtyTextDrafts: [
        {
          tabIdentity: tab.identity,
          path: tab.path,
          content: 'unsaved HTML',
          expectedRevision: 'r1'
        }
      ],
      fileWindowSuspended: true
    });
    expect(page.files.fileWorkbench.hasSuspendedDrafts()).toBe(true);
    expect(unload()).toBe(false);
    isReloadingForUpdate.mockReturnValue(true);
    expect(unload()).toBe(true);
    isReloadingForUpdate.mockReturnValue(false);
    mounted.pop()!.unmount();
    expect(unload()).toBe(true);
  });

  it.each([false, true])(
    'refreshes Changes on each shortcut without duplicate opening reads, initially visible: %s',
    async (visible) => {
      const { page } = controller();
      const workspace = { id: 'workspace-a', path: '/project', kind: 'GIT_WORKSPACE' as const };
      const target = { nodeId: node.id, workspaceId: workspace.id };
      await captured.seedNodes!([node]);
      captured.setTarget!(target);
      await nextTick();
      captured.setWorkspaces!([workspace]);
      await captured.seedManifest!({
        manifestVersion: 1,
        observedAt: 1,
        conversation: { available: true, reasonCode: null },
        files: { available: true, reasonCode: null }
      });
      await nextTick();
      page.aside.selectAsideTool({ ...target, id: 'files' });
      const loadChanges = vi.spyOn(page.files.workspaceGit, 'loadChanges').mockResolvedValue();
      page.files.mountSurface();
      page.aside.setAsideSurfaceVisible(visible);
      await nextTick();
      const shortcut = captured.lifecycle!.workspaceShortcuts.find(
        (binding) => binding.command === 'workspace.changes'
      );
      expect(shortcut).toBeDefined();
      expect(shortcut!.execute({} as KeyboardEvent)).toBe('HANDLED');
      await nextTick();
      expect(page.aside.asideState?.active).toEqual({ kind: 'tool', id: 'changes' });
      expect(loadChanges).toHaveBeenCalledTimes(visible ? 1 : 0);
      if (!visible) {
        page.aside.setAsideSurfaceVisible(true);
        await nextTick();
      }
      expect(loadChanges).toHaveBeenCalledTimes(1);
      expect(loadChanges).toHaveBeenLastCalledWith(true);

      expect(shortcut!.execute({} as KeyboardEvent)).toBe('HANDLED');
      await nextTick();
      expect(loadChanges).toHaveBeenCalledTimes(2);
      expect(loadChanges).toHaveBeenLastCalledWith(true);
      expect(shortcut!.execute({ repeat: true } as KeyboardEvent)).toBe('HANDLED');
      await nextTick();
      expect(loadChanges).toHaveBeenCalledTimes(2);
      expect(shortcut!.execute({} as KeyboardEvent)).toBe('HANDLED');
      await nextTick();
      expect(loadChanges).toHaveBeenCalledTimes(3);
      expect(loadChanges).toHaveBeenLastCalledWith(true);
      page.files.unmountSurface();
    }
  );

  it('uses the current CSRF token and renews it for a Files mutation', async () => {
    Object.assign(window, { sessionStorage });
    const { page } = controller();
    const workspace = { id: 'workspace-a', path: '/project', kind: 'DIRECTORY' as const };
    await captured.seedNodes!([node]);
    captured.setTarget!({ nodeId: node.id, workspaceId: workspace.id });
    await nextTick();
    captured.setWorkspaces!([workspace]);
    await captured.seedManifest!({
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null },
      files: { available: true, reasonCode: null },
      sessionAside: { apiVersion: 1 }
    });
    page.identity.csrfToken = 'updated-after-owner-creation';
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
    const scope = page.files.workspaceFiles.captureTarget();
    expect(scope).toBeDefined();
    await page.files.workspaceFiles.mutate(scope!, 'DELETE', 'obsolete.txt');
    expect(writes).toEqual(['updated-after-owner-creation', 'renewed']);
    expect(page.identity.csrfToken).toBe('renewed');
  });
  it('routes live file and Git transport capabilities through the root-owned file workbench', async () => {
    const createCoordinator = directCoordinator.createWorkbenchDirectTransportCoordinator;
    const coordinator = vi
      .spyOn(directCoordinator, 'createWorkbenchDirectTransportCoordinator')
      .mockImplementation((input) => ({
        ...createCoordinator(input),
        isConnected: () => true,
        workspaceDirectAvailable: () => true
      }));
    const bytes = new TextEncoder().encode('direct text');
    vi.spyOn(directRead, 'readWorkspaceDirectFileRange').mockResolvedValue({
      bytes,
      size: bytes.length,
      offset: 0,
      nextOffset: null,
      revision: 'a'.repeat(64)
    });
    vi.spyOn(directObject, 'readWorkspaceFileObjectUrl').mockImplementation(
      async (_name, _signal, receive) => {
        await receive({ write: vi.fn(), close: vi.fn(), abort: vi.fn() });
        return 'blob:fixture';
      }
    );
    const download = vi.fn<
      ReturnType<typeof fileStreamClient.createWorkspaceFileStreamClient>['download']
    >(async ({ descriptor, sink }) => {
      if (descriptor.direction === 'DOWNLOAD' && descriptor.range !== undefined) {
        await sink.write(bytes);
        await sink.close();
      }
    });
    vi.spyOn(fileStreamClient, 'createWorkspaceFileStreamClient').mockReturnValue({
      upload: vi.fn(),
      download
    });
    vi.spyOn(directDownload, 'downloadWorkspaceFileToBrowser').mockImplementation(async (input) => {
      await input.download({ write: vi.fn(), close: vi.fn(), abort: vi.fn() });
      return 'COMPLETED';
    });
    const identity = { size: bytes.length, revision: 'b'.repeat(64) };
    vi.spyOn(directRead, 'readWorkspaceDirectFileMetadata').mockResolvedValue(identity);
    vi.spyOn(directRead, 'readGitDirectFileMetadata').mockResolvedValue(identity);
    const pwa = {
      state: ref({ offline: 'online', checked: false }),
      subscribe: () => () => {},
      activeWorker: () => undefined
    } as unknown as PwaApplicationService;
    const { page } = controller(pwa);
    const workspace = { id: 'workspace-a', path: '/project', kind: 'GIT_WORKSPACE' as const };
    await captured.seedNodes!([node]);
    captured.setTarget!({ nodeId: node.id, workspaceId: workspace.id });
    await nextTick();
    captured.setWorkspaces!([workspace]);
    captured.tree!.cacheWorkspaces(node.id, [workspace]);
    const manifest = {
      manifestVersion: 1,
      observedAt: 1,
      nodeGeneration: 'generation-a',
      conversation: { available: true, reasonCode: null },
      files: { available: true, reasonCode: null },
      sessionAside: { apiVersion: 1 },
      directTransfer: { range: true, download: true, gitCommitBlob: true }
    } as unknown as NonNullable<typeof page.resources.nodeManifest>;
    await captured.seedManifest!(manifest);
    expect(coordinator).toHaveBeenCalledTimes(1);
    await page.files.fileWorkbench.openFile('direct.txt');
    await page.files.fileWorkbench.openTab({
      kind: 'HISTORY_TEXT',
      nodeId: node.id,
      workspaceId: workspace.id,
      path: 'history.txt',
      repositoryPath: '',
      worktreePath: '',
      commit: 'b'.repeat(40),
      refs: ['main']
    });
    expect(download.mock.calls.map(([input]) => input.descriptor.resource.kind)).toEqual([
      'WORKSPACE_FILE',
      'GIT_COMMIT_BLOB'
    ]);
    download.mockClear();
    await page.files.fileWorkbench.openFile('report.pdf');
    await page.files.fileWorkbench.openTab({
      kind: 'HISTORY_TEXT',
      nodeId: node.id,
      workspaceId: workspace.id,
      path: 'history.pdf',
      repositoryPath: '',
      worktreePath: '',
      commit: 'b'.repeat(40),
      refs: ['main']
    });
    expect(download.mock.calls.map(([input]) => input.descriptor.resource.kind)).toEqual([
      'WORKSPACE_FILE',
      'GIT_COMMIT_BLOB'
    ]);
    download.mockClear();
    await page.files.fileWorkbench.downloadTarget({
      ...page.selection.workspaceTarget!,
      path: 'download.png'
    });
    await page.files.fileWorkbench.downloadTarget({
      ...page.selection.workspaceTarget!,
      path: 'history.png',
      history: { commit: 'b'.repeat(40), repositoryPath: '', refs: ['main'] }
    });
    expect(download.mock.calls.map(([input]) => input.descriptor.resource.kind)).toEqual([
      'WORKSPACE_FILE',
      'GIT_COMMIT_BLOB'
    ]);
    download.mockClear();
    await captured.seedManifest!({
      ...manifest,
      directTransfer: {
        ...manifest.directTransfer!,
        range: false,
        download: false,
        gitCommitBlob: false
      }
    });
    await page.files.fileWorkbench.openFile('relay.txt');
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptor: expect.objectContaining({
          resource: expect.objectContaining({ path: 'relay.txt' })
        })
      })
    );
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/files/read?'))).toBe(
      false
    );
  });
  it.each(['FILE_NOT_FOUND', 'PERMISSION_DENIED'])(
    'keeps a successful preview independent of a directory %s failure',
    async (code) => {
      const show = vi.spyOn(feedback, 'showMessage').mockImplementation(() => {});
      const download = vi.fn(
        async ({
          sink
        }: Parameters<
          ReturnType<typeof fileStreamClient.createWorkspaceFileStreamClient>['download']
        >[0]) => {
          await sink.write(new TextEncoder().encode('safe'));
          await sink.close();
        }
      );
      vi.spyOn(fileStreamClient, 'createWorkspaceFileStreamClient').mockReturnValue({
        upload: vi.fn(),
        download
      });
      const { page } = controller();
      const workspace = { id: 'workspace-a', path: '/project', kind: 'DIRECTORY' as const };
      await captured.seedNodes!([node]);
      captured.setTarget!({ nodeId: node.id, workspaceId: workspace.id });
      await flushComponent();
      captured.tree!.cacheWorkspaces(node.id, [workspace]);
      captured.setWorkspaces!([workspace]);
      await captured.seedManifest!({
        manifestVersion: 1,
        observedAt: 1,
        conversation: { available: true, reasonCode: null },
        files: { available: true, reasonCode: null },
        sessionAside: { apiVersion: 1 }
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (request: string | URL | Request) => {
          const url = new URL(String(request), 'https://console.example.test');
          return url.pathname.endsWith('/files/direct-metadata')
            ? new Response(
                JSON.stringify({
                  file: { size: 4, revision: 'a'.repeat(64) }
                })
              )
            : new Response(JSON.stringify({ error: code }), { status: 404 });
        })
      );
      await page.files.fileWorkbench.openFile('missing/result.md');
      await flushComponent();
      expect(page.files.fileWorkbench.frames.value[0]?.fileContent.value).toMatchObject({
        path: 'missing/result.md',
        content: 'safe'
      });
      expect(show).toHaveBeenCalledTimes(code === 'PERMISSION_DENIED' ? 1 : 0);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ error: code }), { status: 404 }))
      );
      await page.files.fileWorkbench.openWorkspaceFile('missing/failure.md');
      const failed = page.files.fileWorkbench.frames.value.find(
        (frame) => frame.target.value?.path === 'missing/failure.md'
      )!;
      expect(failed.error.value).toMatchObject({ code });
      expect(failed.loading.value).toBe(false);
      expect(page.files.fileWorkbench.frames.value[0]?.fileContent.value?.content).toBe('safe');
      expect(show).toHaveBeenCalledTimes(code === 'PERMISSION_DENIED' ? 1 : 0);
      download.mockImplementationOnce(async ({ sink }) => {
        await sink.write(new TextEncoder().encode('recovered'));
        await sink.close();
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                file: {
                  size: 9,
                  revision: 'b'.repeat(64)
                }
              })
            )
        )
      );
      await page.files.fileWorkbench.reloadFile(failed.id);
      expect(failed.error.value).toBeUndefined();
      expect(failed.fileContent.value?.content).toBe('recovered');
    }
  );

  it.each(
    (['files', 'changes', 'history'] as const).flatMap((area) =>
      ['CAPABILITY_UNAVAILABLE', 'NETWORK_UNAVAILABLE'].map((code) => ({ area, code }))
    )
  )(
    'keeps a $area $code failure in its owner and recovers without a Message',
    async ({ area, code }) => {
      const show = vi.spyOn(feedback, 'showMessage').mockImplementation(() => {});
      const { page } = controller();
      const workspace = { id: 'workspace-a', path: '/project', kind: 'GIT_WORKSPACE' as const };
      await captured.seedNodes!([node]);
      captured.setTarget!({ nodeId: node.id, workspaceId: workspace.id });
      await flushComponent();
      captured.tree!.cacheWorkspaces(node.id, [workspace]);
      captured.setWorkspaces!([workspace]);
      await captured.seedManifest!({
        manifestVersion: 1,
        observedAt: 1,
        conversation: { available: true, reasonCode: null },
        files: { available: true, reasonCode: null },
        git: { available: true, reasonCode: null, supportsHistory: true }
      });
      let fail = true;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (request: string | URL | Request) => {
          const path = new URL(String(request), 'https://console.example.test').pathname;
          if (fail && code === 'NETWORK_UNAVAILABLE') throw new TypeError('Failed to fetch');
          if (path.endsWith('/git/refs')) return new Response(JSON.stringify({ refs: [] }));
          if (fail)
            return new Response(JSON.stringify({ error: code }), {
              status: 403
            });
          return new Response(
            JSON.stringify(
              area === 'files'
                ? {
                    workspace,
                    files: {
                      entries: [
                        { path: 'recovered.ts', name: 'recovered.ts', kind: 'FILE', size: 1 }
                      ],
                      nextCursor: null
                    }
                  }
                : area === 'changes'
                  ? { workspace, changes: [] }
                  : { commits: [], nextCursor: null }
            )
          );
        })
      );
      const read = () =>
        area === 'files'
          ? page.files.workspaceFiles.refresh()
          : area === 'changes'
            ? page.files.workspaceGit.loadChanges()
            : page.files.workspaceGit.loadHistory(true);
      await read();
      const failure =
        area === 'files'
          ? page.files.workspaceFiles.tree.refreshError.value?.cause
          : area === 'changes'
            ? page.files.workspaceGit.changesFailureCause.value
            : page.files.workspaceGit.historyFailureCause.value;
      expect(failure).toMatchObject({ code });
      expect(page.application.networkUnavailable).toBe(code === 'NETWORK_UNAVAILABLE');
      expect(show).not.toHaveBeenCalled();
      fail = false;
      await read();
      expect(page.application.networkUnavailable).toBe(false);
      if (area === 'files') {
        expect(page.files.workspaceFiles.tree.refreshError.value).toBeUndefined();
        expect(page.files.workspaceFiles.tree.root.value.children[0]?.path).toBe('recovered.ts');
      } else if (area === 'changes') {
        expect(page.files.workspaceGit.changesFailureCause.value).toBeUndefined();
        expect(page.files.workspaceGit.changesError.value).toBe(false);
      } else {
        expect(page.files.workspaceGit.historyFailureCause.value).toBeUndefined();
        expect(page.files.workspaceGit.historyError.value).toBeUndefined();
      }
      expect(show).not.toHaveBeenCalled();
    }
  );

  it('keeps Git changes when a file read reports an unavailable capability', async () => {
    const show = vi.spyOn(feedback, 'showMessage').mockImplementation(() => {});
    vi.spyOn(fileStreamClient, 'createWorkspaceFileStreamClient').mockReturnValue({
      upload: vi.fn(),
      async download({ sink }) {
        await sink.write(new TextEncoder().encode('recovered'));
        await sink.close();
      }
    });
    const { page } = controller();
    const workspace = { id: 'workspace-a', path: '/project', kind: 'GIT_WORKSPACE' as const };
    await captured.seedNodes!([node]);
    captured.setTarget!({ nodeId: node.id, workspaceId: workspace.id });
    await flushComponent();
    captured.tree!.cacheWorkspaces(node.id, [workspace]);
    captured.setWorkspaces!([workspace]);
    await captured.seedManifest!({
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null },
      files: { available: true, reasonCode: null },
      sessionAside: { apiVersion: 1 }
    });
    const changes = { changes: [{ path: 'kept.txt' }] };
    page.files.workspaceGit.restore({ changes });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'CAPABILITY_UNAVAILABLE' }), { status: 403 })
      )
    );
    await page.files.fileWorkbench.openWorkspaceFile('missing.txt');
    expect(page.files.workspaceGit.snapshot().changes).toEqual(changes);
    const failed = page.files.fileWorkbench.frames.value[0]!;
    expect(failed.error.value).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    expect(failed.loading.value).toBe(false);
    expect(show).not.toHaveBeenCalled();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              file: { size: 9, revision: 'c'.repeat(64) }
            })
          )
      )
    );
    await page.files.fileWorkbench.reloadFile(failed.id);
    expect(failed.error.value).toBeUndefined();
    expect(failed.fileContent.value?.content).toBe('recovered');
    expect(page.files.workspaceGit.snapshot().changes).toEqual(changes);
  });

  it('does not reapply stale Git Watch metadata after Files changes the Workspace kind', async () => {
    const { page } = controller();
    const workspace = { id: 'workspace-a', path: '/project', kind: 'GIT_WORKSPACE' as const };
    await captured.seedNodes!([node]);
    captured.setWorkspaces!([workspace]);
    captured.setTarget!({ nodeId: node.id, workspaceId: workspace.id });
    await flushComponent();
    captured.tree!.cacheWorkspaces(node.id, [workspace]);
    captured.setWorkspaces!([workspace]);
    await captured.seedManifest!({
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null },
      files: { available: true, reasonCode: null },
      sessionAside: { apiVersion: 1 }
    });
    const update = (
      data: { files?: unknown; changes?: unknown },
      topic: 'files' | 'changes' | 'sessions'
    ) => {
      captured.tools!.acceptWatch(node.id, workspace.id, data, { topic, revision: 1 });
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
    expect(page.resources.selectedWorkspace?.kind).toBe('DIRECTORY');
    update({}, 'sessions');
    await nextTick();
    expect(page.resources.selectedWorkspace?.kind).toBe('DIRECTORY');
    update({ changes: { workspace, changes: [], repositories: [] } }, 'changes');
    await nextTick();
    expect(page.resources.selectedWorkspace?.kind).toBe('GIT_WORKSPACE');
  });

  it('restores hidden Search drafts per Workspace and distinguishes an absent panel from clearing', async () => {
    const { page } = controller();
    await captured.seedNodes!([node]);
    captured.setWorkspaces!([
      { id: 'a', path: '/a', kind: 'DIRECTORY' },
      { id: 'b', path: '/b', kind: 'DIRECTORY' }
    ]);
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
    expect(await page.interactions.openQuickWorkspace(node.id, 'a')).toBe(true);
    page.files.setWorkspaceSearchPanel(panel);
    draft = { contentQuery: 'needle', contentUseRegex: true };
    expect(await page.interactions.openQuickWorkspace(node.id, 'b')).toBe(true);
    expect(draft).toEqual({ contentQuery: '', contentUseRegex: false });
    page.files.setWorkspaceSearchPanel(null);
    expect(await page.interactions.openQuickWorkspace(node.id, 'a')).toBe(true);
    expect(await page.interactions.openQuickWorkspace(node.id, 'b')).toBe(true);
    expect(await page.interactions.openQuickWorkspace(node.id, 'a')).toBe(true);
    page.files.setWorkspaceSearchPanel(panel);
    expect(draft).toEqual({ contentQuery: 'needle', contentUseRegex: true });
    draft = { contentQuery: '', contentUseRegex: false };
    expect(await page.interactions.openQuickWorkspace(node.id, 'b')).toBe(true);
    expect(await page.interactions.openQuickWorkspace(node.id, 'a')).toBe(true);
    expect(draft).toEqual({ contentQuery: '', contentUseRegex: false });
  });

  it('routes HTML preview to the scoped Browser and drops pending navigation on scope exit', async () => {
    const { page } = controller();
    const a = { nodeId: node.id, workspaceId: 'a' };
    const b = { nodeId: node.id, workspaceId: 'b' };
    await captured.seedNodes!([node]);
    captured.setTarget!(a);
    const manifest = {
      manifestVersion: 1 as const,
      observedAt: 1,
      conversation: { available: true, reasonCode: null },
      files: { available: true, reasonCode: null }
    };
    await captured.seedManifest!(manifest);
    await nextTick();
    page.aside.openHtmlAside('unavailable.html');
    expect(page.browser.destination.value).toBeUndefined();
    await captured.seedManifest!({
      ...manifest,
      browser: { apiVersion: 1, nodeGeneration: 'g1', ice: false }
    });
    await nextTick();
    page.aside.openHtmlAside('a.html');
    expect(page.aside.asideState?.active).toEqual({ kind: 'tool', id: 'node-browser' });
    expect(page.browser.destination.value).toEqual({ scope: a, target: { htmlPath: 'a.html' } });
    captured.setTarget!(b);
    await nextTick();
    expect(page.browser.destination.value).toBeUndefined();
    page.browser.openDestination(b, { url: 'https://example.test' });
    captured.signedOut!();
    expect(page.browser.destination.value).toBeUndefined();
  });

  it('projects and closes the image preview from its owning Main or Aside pane', () => {
    const { page } = controller();
    const main = page.mainPaneController.images;
    const aside = page.aside.asidePaneController.images;
    aside.open({ name: 'aside.png', previewUrl: '/api/aside-image' });
    expect(page.interactions.conversationImagePreviewOpen).toBe(true);
    expect(page.interactions.conversationImagePreview).toEqual({
      name: 'aside.png',
      url: '/api/aside-image'
    });
    page.interactions.conversationImagePreviewOpen = false;
    expect(aside.previewOpen.value).toBe(false);
    main.open({ name: 'main.png', previewUrl: '/api/main-image' });
    expect(page.interactions.conversationImagePreview?.name).toBe('main.png');
    aside.open({ name: 'aside-again.png', previewUrl: '/api/aside-image-2' });
    expect(main.previewOpen.value).toBe(false);
    expect(page.interactions.conversationImagePreview?.name).toBe('aside-again.png');
    page.interactions.conversationImagePreviewOpen = false;
    page.interactions.conversationImagePreview = undefined;
    expect(aside.previewOpen.value).toBe(false);
    expect(aside.preview.value).toBeUndefined();
  });

  it('routes preview load failures to the pane that opened the image', async () => {
    const { page } = controller();
    const aside = vi.spyOn(page.aside.asidePaneController.images, 'previewFailed');
    const main = vi.spyOn(page.mainPaneController.images, 'previewFailed');
    page.aside.asidePaneController.images.open({
      name: 'aside.png',
      previewUrl: '/api/aside-image'
    });
    await page.interactions.handleConversationImagePreviewError('/api/aside-image');
    expect(aside).toHaveBeenCalledWith('/api/aside-image');
    expect(main).not.toHaveBeenCalled();
  });

  it('supplies file-owned image resolvers for Main and Aside without losing captured targets', async () => {
    const { page } = controller();
    const a = { nodeId: node.id, workspaceId: 'workspace-a' };
    const b = { nodeId: 'node-b', workspaceId: 'workspace-b' };
    await captured.seedNodes!([
      { ...node, nodeAppVersion: '0.11.69' },
      { ...node, id: b.nodeId }
    ]);
    captured.setTarget!(a);
    captured.setWorkspaces!([{ id: a.workspaceId, path: '/project', kind: 'DIRECTORY' }]);
    await captured.seedManifest!({
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null },
      sessionAside: { apiVersion: 1 }
    });
    expect(page.aside.openAsideSession({ ...a, sessionId: 'aside-a' })).toBe(true);
    const path = 'images/a & b.png';
    const main = page.mainPaneController.imageResourceUrl.value!;
    const aside = page.aside.asidePaneController.imageResourceUrl.value!;
    const target = (resolver: (path: string) => string) => {
      const url = new URL(resolver(path), 'https://console.example.test');
      return {
        pathname: url.pathname,
        node: url.searchParams.get('nodeId'),
        path: url.searchParams.get('path')
      };
    };
    expect(target(main)).toEqual({
      pathname: '/api/workspaces/workspace-a/files/content',
      node: node.id,
      path
    });
    expect(target(aside)).toEqual(target(main));
    captured.setTarget!(b);
    expect(target(page.mainPaneController.imageResourceUrl.value!)).toEqual({
      pathname: '/api/workspaces/workspace-b/files/content',
      node: b.nodeId,
      path
    });
    expect(target(main).node).toBe(a.nodeId);
    expect(target(aside)).toEqual(target(main));
    expect(page.aside.asidePaneController.imageResourceUrl.value).toBeUndefined();
    captured.setTarget!(undefined);
    expect(page.mainPaneController.imageResourceUrl.value).toBeUndefined();
  });

  it('projects only actually visible Main and Aside sessions to the notification owner', async () => {
    const { page } = controller();
    const workspace = { nodeId: 'node-a', workspaceId: 'workspace-a' };
    await captured.seedNodes!([{ ...node, nodeAppVersion: '0.11.69' }]);
    captured.setTarget!(workspace);
    captured.setWorkspaces!([{ id: workspace.workspaceId, path: '/project', kind: 'DIRECTORY' }]);
    await captured.seedManifest!({
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null },
      files: { available: true, reasonCode: null },
      sessionAside: { apiVersion: 1 }
    });
    await nextTick();
    captured.setDraft!(false);
    captured.setSessions!(
      ['main', 'background', 'aside'].map((id) => ({
        id,
        workspaceId: workspace.workspaceId,
        runner: 'codex',
        activity: 'IDLE'
      }))
    );
    captured.setSession!('main');
    page.aside.setAsideSurfaceVisible(true);
    expect(page.aside.openAsideSession({ ...workspace, sessionId: 'background' })).toBe(true);
    expect(page.aside.openAsideSession({ ...workspace, sessionId: 'aside' })).toBe(true);
    page.mainPaneController.state.conversation.loadingInitial.value = false;
    page.aside.asidePaneController.state.conversation.loadingInitial.value = false;
    const visible = () => captured.notificationOptions?.activeTargets?.();
    expect(visible()).toEqual([
      { targetType: 'WORKSPACE_SESSION', ...workspace, sessionId: 'main' },
      { targetType: 'WORKSPACE_SESSION', ...workspace, sessionId: 'aside' }
    ]);
    await captured.seedNodes!([{ ...page.resources.nodes[0]!, connected: false }]);
    expect(visible()).toEqual([]);
    await captured.seedNodes!([{ ...page.resources.nodes[0]!, connected: true }]);
    expect(page.aside.asideState?.active).toEqual({ kind: 'session', sessionId: 'aside' });
    expect(visible()).toEqual([
      { targetType: 'WORKSPACE_SESSION', ...workspace, sessionId: 'main' }
    ]);
    await captured.seedManifest!({
      manifestVersion: 1,
      observedAt: 2,
      conversation: { available: true, reasonCode: null },
      files: { available: true, reasonCode: null },
      sessionAside: { apiVersion: 1 }
    });
    page.aside.asidePaneController.state.conversation.loadingInitial.value = false;
    expect(visible()).toEqual([
      { targetType: 'WORKSPACE_SESSION', ...workspace, sessionId: 'main' },
      { targetType: 'WORKSPACE_SESSION', ...workspace, sessionId: 'aside' }
    ]);
    page.layout.mobileViewport = true;
    page.layout.mobileWorkspaceSurface = 'inspector';
    expect(visible()).toEqual([]);
    page.aside.asidePaneController.state.conversation.loadingInitial.value = false;
    expect(visible()).toEqual([
      { targetType: 'WORKSPACE_SESSION', ...workspace, sessionId: 'aside' }
    ]);
    page.aside.selectAsideTool({ ...workspace, id: 'files' });
    expect(visible()).toEqual([]);
    page.layout.mobileWorkspaceSurface = 'conversation';
    expect(visible()).toEqual([
      { targetType: 'WORKSPACE_SESSION', ...workspace, sessionId: 'main' }
    ]);
    captured.setDraft!(true);
    expect(visible()).toEqual([]);
  });

  it('binds reconnect readiness to Main without delaying an independent visible Aside confirmation', async () => {
    let finishMain!: (completed: boolean) => void;
    const mainReady = new Promise<boolean>((resolve) => (finishMain = resolve));
    const createRefresh = snapshotRefresh.createSessionSnapshotRefreshService;
    const settled = vi.fn(() => mainReady);
    vi.spyOn(snapshotRefresh, 'createSessionSnapshotRefreshService').mockImplementation(
      (options) => ({
        ...createRefresh(options),
        whenSettled: settled
      })
    );
    const { page } = controller();
    const workspace = { nodeId: 'node-a', workspaceId: 'workspace-a' };
    await captured.seedNodes!([{ ...node, nodeAppVersion: '0.11.69' }]);
    captured.setTarget!(workspace);
    captured.setWorkspaces!([{ id: workspace.workspaceId, path: '/project', kind: 'DIRECTORY' }]);
    await captured.seedManifest!({
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null },
      files: { available: true, reasonCode: null },
      sessionAside: { apiVersion: 1 }
    });
    captured.setDraft!(false);
    captured.setSessions!(
      ['main', 'aside'].map((id) => ({
        id,
        workspaceId: workspace.workspaceId,
        runner: 'codex',
        activity: 'IDLE'
      }))
    );
    captured.setSession!('main');
    page.aside.setAsideSurfaceVisible(true);
    expect(page.aside.openAsideSession({ ...workspace, sessionId: 'aside' })).toBe(true);
    page.mainPaneController.state.conversation.loadingInitial.value = false;
    page.aside.asidePaneController.state.conversation.loadingInitial.value = false;
    const notifications = ['main', 'aside'].map((sessionId) => ({
      id: sessionId,
      kind: 'run',
      title: 'Completed',
      message: '',
      target: { targetType: 'WORKSPACE_SESSION', ...workspace, sessionId },
      read: false,
      createdAt: 1,
      updatedAt: 1,
      expiresAt: Date.now() + 60_000
    }));
    let confirmAside!: () => void;
    const asideRead = new Promise<void>((resolve) => (confirmAside = resolve));
    const readSessions: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path === '/api/notifications') return new Response(JSON.stringify({ notifications }));
      if (path === '/api/notifications/session/read') {
        const { sessionId } = JSON.parse(String(init?.body));
        readSessions.push(sessionId);
        if (sessionId === 'aside') await asideRead;
        notifications.find((entry) => entry.id === sessionId)!.read = true;
        return new Response('{}');
      }
      return new Response(JSON.stringify({ nodes: [{ ...node, nodeAppVersion: '0.11.69' }] }));
    });
    try {
      captured.live!.onConnectionRestored?.(true);
      await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(readSessions).toEqual(['aside']));
      expect(captured.notificationService!.unreadCount.value).toBe(2);
      confirmAside();
      await vi.waitFor(() =>
        expect(
          captured.notificationService!.notifications.value.find((item) => item.id === 'aside')
            ?.read
        ).toBe(true)
      );
      expect(
        captured.notificationService!.notifications.value.find((item) => item.id === 'main')?.read
      ).toBe(false);
      expect(readSessions).toEqual(['aside']);
      finishMain(true);
      await vi.waitFor(() => expect(captured.notificationService!.unreadCount.value).toBe(0));
      expect(readSessions).toEqual(['aside', 'main']);
    } finally {
      confirmAside();
      finishMain(false);
      captured.notificationService!.dispose();
    }
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
    await captured.seedNodes!([node]);
    captured.setWorkspaces!([{ id: workspace.workspaceId, path: '/project', kind: 'DIRECTORY' }]);
    captured.setTarget!(workspace);
    captured.setDraft!(false);
    captured.setSessions!([session]);
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
    captured.notificationService!.notifications.value = [
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
    captured.setSession!('previous-session');
    const opening = page.application.openRecentRun({
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
    expect(captured.notificationService!.notifications.value[0]?.read).toBe(false);
    await flushComponent();
    page.mainPaneController.state.conversation.confirmInitialRender(
      page.mainPaneController.state.conversation.initialRenderVersion.value
    );
    await opening;
    expect(page.mainPaneController.state.conversation.initialLoadFailed.value).toBe(false);
    await vi.waitFor(() =>
      expect(captured.notificationService!.notifications.value[0]?.read).toBe(true)
    );
  });

  it('opens a tool change with the pane’s full workspace and session identity', async () => {
    const { page } = controller();
    const openWorkspaceFileTab = vi
      .spyOn(page.files.fileWorkbench, 'openTab')
      .mockResolvedValue(undefined);
    await captured.seedNodes!([node]);
    captured.setTarget!({ nodeId: 'node-a', workspaceId: 'workspace-a' });
    await captured.seedManifest!({
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null }
    });
    captured.setDraft!(false);
    captured.setSession!('session-a');
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
    captured.setSession!(undefined);
    page.mainPaneController.openFileChange(entry);
    expect(openWorkspaceFileTab).toHaveBeenCalledTimes(1);
  });

  it('gates navigation and removes only missing Aside targets from the active workspace', async () => {
    const { page } = controller();
    const workspace = { nodeId: 'node-a', workspaceId: 'workspace-a' };
    await captured.seedNodes!([{ ...node, nodeAppVersion: '0.10.1' }]);
    captured.setTarget!(workspace);
    await captured.seedManifest!({
      manifestVersion: 1,
      observedAt: 1,
      sessionAside: { apiVersion: 1 },
      conversation: { available: true, reasonCode: null }
    });
    expect(captured.workspaceWatch?.sessionNavigation?.()).toBeUndefined();
    await captured.seedNodes!([{ ...node, nodeAppVersion: '0.11.69' }]);
    await captured.seedManifest!({
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null }
    });
    expect(captured.workspaceWatch?.sessionNavigation?.()).toBeUndefined();
    await captured.seedManifest!({
      ...page.resources.nodeManifest!,
      sessionAside: { apiVersion: 1 }
    });
    captured.setDraft!(false);
    captured.setSession!('main');
    expect(page.aside.openAsideSession({ ...workspace, sessionId: 'gone' })).toBe(true);
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
    expect(page.aside.asideState?.sessions).toEqual(['gone']);
    captured.workspaceWatch?.onSnapshot(
      'node-a',
      'workspace-a',
      { sessionNavigation: payload },
      'sessionNavigation',
      1,
      query
    );
    expect(page.aside.asideState?.sessions).toEqual([]);
    expect(page.sessionList.sessionNavigationSnapshot).toBeUndefined();
    const updatedQuery = captured.workspaceWatch!.sessionNavigation!()!;
    captured.workspaceWatch?.onSnapshot(
      'node-a',
      'workspace-a',
      { sessionNavigation: payload },
      'sessionNavigation',
      2,
      query
    );
    expect(page.sessionList.sessionNavigationSnapshot).toBeUndefined();
    const updatedPayload = { ...payload, missingSessionIds: [] };
    captured.workspaceWatch?.onSnapshot(
      'node-a',
      'workspace-a',
      { sessionNavigation: updatedPayload },
      'sessionNavigation',
      1,
      updatedQuery
    );
    expect(page.sessionList.sessionNavigationSnapshot).toMatchObject({
      ...workspace,
      ...updatedPayload
    });
    captured.setTarget!({ nodeId: 'node-b', workspaceId: 'workspace-a' });
    expect(page.sessionList.sessionNavigationSnapshot).toBeUndefined();
  });

  it('keeps an Aside title while the captured tree query changes without exposing the old tree', async () => {
    const { page } = controller();
    const workspace = { nodeId: 'node-a', workspaceId: 'workspace-a' };
    await captured.seedNodes!([{ ...node, nodeAppVersion: '0.11.69' }]);
    captured.setTarget!(workspace);
    await captured.seedManifest!({
      manifestVersion: 1,
      observedAt: 1,
      sessionAside: { apiVersion: 1 },
      conversation: { available: true, reasonCode: null }
    });
    captured.setDraft!(false);
    captured.setSession!('main');
    page.aside.openAsideSession({ ...workspace, sessionId: 'child' });
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
    expect(page.aside.asideSessionMetadata).toEqual([child]);
    page.sessionList.setSessionTreeAnchor('main');
    expect(page.sessionList.sessionNavigationSnapshot).toBeUndefined();
    expect(page.aside.asideSessionMetadata).toEqual([child]);
    captured.setTarget!({ nodeId: 'node-b', workspaceId: 'workspace-a' });
    expect(page.aside.asideSessionMetadata).toEqual([]);
  });

  it('requests the anchor board on opening collaboration and removes it when the network closes', async () => {
    const { page } = controller();
    const workspace = { nodeId: 'node-a', workspaceId: 'workspace-a' };
    await captured.seedNodes!([{ ...node, nodeAppVersion: '0.11.69' }]);
    captured.setTarget!(workspace);
    await captured.seedManifest!({
      manifestVersion: 1,
      observedAt: 1,
      sessionAside: { apiVersion: 1 },
      sessionCollaboration: true,
      conversation: { available: true, reasonCode: null }
    });
    captured.setDraft!(false);
    captured.setSession!('main');
    const query = () => captured.workspaceWatch!.sessionNavigation!();
    page.sessionList.setSessionTreeAnchor('main', true);
    expect(query()).toMatchObject({
      treeAnchor: 'main',
      collaboration: { boardSessionId: 'main' }
    });
    page.sessionList.setCollaborationBoard('peer');
    expect(query()).toMatchObject({
      treeAnchor: 'main',
      collaboration: { boardSessionId: 'peer' }
    });
    page.sessionList.setSessionTreeAnchor(undefined);
    expect(query()?.collaboration).toBeUndefined();
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
      captured.setTarget!({ nodeId: 'node-a', workspaceId: 'workspace-a' });
      captured.setSessions!([session]);
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
      const opening = page.selection.openSessionFromList(session.id);
      await flushComponent();
      expect(captured.waitForReady).toHaveBeenCalledOnce();
      expect(watchRequests).toEqual([]);
      expect(page.mainPaneController.state.conversation.loadingInitial.value).toBe(true);
      expect(page.mainPaneController.state.conversation.initialLoadFailed.value).toBe(false);
      if (outcome === 'changed-target')
        captured.setTarget!({ nodeId: 'node-b', workspaceId: 'workspace-b' });
      if (outcome === 'hidden') Object.assign(document, { visibilityState: 'hidden' });
      if (outcome === 'ready' || outcome === 'hidden')
        captured.live!.onReady?.('connection-a', true);
      resolveReady(outcome !== 'closed');
      await flushComponent();
      page.mainPaneController.state.conversation.confirmInitialRender(
        page.mainPaneController.state.conversation.initialRenderVersion.value
      );
      await opening;
      expect(watchRequests).toHaveLength(outcome === 'ready' ? 1 : 0);
      expect(page.mainPaneController.state.conversation.initialLoadFailed.value).toBe(false);
      if (outcome === 'ready')
        expect(page.mainPaneController.conversationSyncPending.value).toBe(false);
    }
  );
  it.each(['CHILD', 'MAIN', undefined] as const)(
    'keeps a newly submitted main session reachable after opening New from %s',
    async (initialGroup) => {
      const { page } = controller();
      await captured.seedNodes!([{ ...node, nodeAppVersion: '0.11.19' }]);
      await captured.seedManifest!({
        manifestVersion: 1,
        observedAt: 1,
        ...(initialGroup === undefined ? {} : { sessionGroups: { apiVersion: 1 } }),
        conversation: { available: true, reasonCode: null }
      });
      captured.setWorkspaces!([{ id: 'workspace-a', path: '/project', kind: 'DIRECTORY' }]);
      captured.setTarget!({ nodeId: 'node-a', workspaceId: 'workspace-a' });
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
      if (initialGroup !== undefined) page.sessionList.selectWorkspaceSessionGroup(initialGroup);
      await flushComponent();
      if (initialGroup === 'CHILD') {
        await page.sessionList.refreshWorkspaceSessions();
        expect(page.sessionList.visibleWorkspaceSessions).toEqual([child]);
      }

      page.selection.openNewSessionComposer();
      await flushComponent();
      page.mainPaneController.state.draft.input.value = 'Start a main session';
      page.mainPaneController.sendMessage();
      try {
        await vi.waitFor(() => expect(starts).toHaveLength(1));
        await flushComponent();
        expect(page.selection.draftSessionOpen).toBe(false);
        expect(page.selection.selectedSessionId).toMatch(/^draft:/);
        expect(page.mainPaneController.configuration.selectedSession.value?.id).toBe(
          page.selection.selectedSessionId
        );
        expect(page.mainPaneController.presentation.composerSessionOpen.value).toBe(true);
      } finally {
        finishStart();
      }
      await vi.waitFor(() => expect(page.selection.selectedSessionId).toBe(main.id));
      // The Node's next authoritative directory page makes the created identity reachable.
      await page.sessionList.refreshWorkspaceSessions();
      expect(page.sessionList.workspaceSessionGroup).toBe(
        initialGroup === undefined ? undefined : 'MAIN'
      );
      expect(page.mainPaneController.configuration.selectedSession.value?.id).toBe(main.id);
      expect(
        page.mainPaneController.conversationRuns.value.some((run) => run.id === 'created-run')
      ).toBe(true);
      expect(page.sessionList.visibleWorkspaceSessions.map((session) => session.id)).toContain(
        main.id
      );
      expect(page.sessionList.sessions.some((session) => session.id.startsWith('draft:'))).toBe(
        false
      );
      expect(starts).toHaveLength(1);
      expect(starts[0]).not.toHaveProperty('parentSessionId');
      expect(starts[0]).not.toHaveProperty('sessionGroup');
    }
  );

  it.each(['unfinished message', '/review unfinished message'])(
    'preserves the Main composer when opening a new session from an existing session: %s',
    async (input) => {
      const { page } = controller();
      captured.setTarget!({ nodeId: 'node-a', workspaceId: 'workspace-a' });
      captured.setSessions!([{ id: 'existing', workspaceId: 'workspace-a', runner: 'codex' }]);
      captured.setSession!('existing');
      const draft = page.mainPaneController.state.draft;
      draft.input.value = input;
      draft.references.value = [{ type: 'file', path: 'ref.ts', label: 'ref.ts' }];
      await flushComponent();

      page.selection.openNewSessionComposer();
      // The lifecycle fixture captures the Runner-change callback instead of installing its watcher.
      captured.lifecycle!.clearRunnerCommand();
      await flushComponent();

      expect(page.selection.draftSessionOpen).toBe(true);
      expect(draft.input.value).toBe(input);
      expect(draft.references.value).toEqual([{ type: 'file', path: 'ref.ts', label: 'ref.ts' }]);
    }
  );

  it('returns an already open draft to Main only on explicit New, preserving manual group changes', async () => {
    const { page } = controller();
    await captured.seedNodes!([{ ...node, nodeAppVersion: '0.11.19' }]);
    await captured.seedManifest!({
      manifestVersion: 1,
      observedAt: 1,
      sessionGroups: { apiVersion: 1 },
      conversation: { available: true, reasonCode: null }
    });
    captured.setTarget!({ nodeId: 'node-a', workspaceId: 'workspace-a' });
    page.selection.openNewSessionComposer();
    page.mainPaneController.state.draft.input.value = 'Keep this draft';
    page.sessionList.selectWorkspaceSessionGroup('CHILD');
    await flushComponent();
    expect(page.selection.draftSessionOpen).toBe(true);
    expect(page.mainPaneController.state.draft.input.value).toBe('Keep this draft');
    expect(page.sessionList.workspaceSessionGroup).toBe('CHILD');

    page.selection.openNewSessionComposer();
    expect(page.sessionList.workspaceSessionGroup).toBe('MAIN');
    expect(page.mainPaneController.state.draft.input.value).toBe('Keep this draft');
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
      await captured.seedNodes!([{ ...node, nodeAppVersion: '0.11.19' }]);
      await captured.seedManifest!({
        manifestVersion: 1,
        observedAt: 1,
        sessionGroups: { apiVersion: 1 },
        conversation: { available: true, reasonCode: null }
      });
      captured.setTarget!({ nodeId: 'node-a', workspaceId: 'workspace-a' });
      captured.setSessions!([main]);
      const previousGroup = targetGroup === 'MAIN' ? 'CHILD' : 'MAIN';
      page.sessionList.selectWorkspaceSessionGroup(previousGroup);
      const manifest = page.resources.nodeManifest;
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

      if (entry === 'quick') await page.selection.openSessionFromList(main.id);
      else if (entry === 'explicit-target') {
        await flushComponent();
        vi.mocked(fetch).mockClear();
        const opening = page.selection.openSessionGroupTarget({
          nodeId: 'node-a',
          workspaceId: 'workspace-a',
          sessionId: main.id
        });
        await flushComponent();
        page.mainPaneController.state.conversation.confirmInitialRender(
          page.mainPaneController.state.conversation.initialRenderVersion.value
        );
        await opening;
        expect(
          vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith('/api/workspaces?'))
        ).toBe(false);
      } else {
        await flushComponent();
        vi.mocked(fetch).mockClear();
        await page.application.openRecentRun({
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
      expect(page.selection.selectedSessionId).toBe(main.id);
      expect(page.sessionList.workspaceSessionGroup).toBe(
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
    await captured.seedNodes!([{ ...node, nodeAppVersion: '0.11.19' }]);
    captured.setTarget!({ nodeId: 'node-a', workspaceId: 'workspace-a' });
    captured.setSessions!([session]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ session, sessions: [session], turns: [] })))
    );
    const opening = page.selection.openSessionGroupTarget({
      nodeId: 'node-a',
      workspaceId: 'workspace-a',
      sessionId: session.id
    });
    await flushComponent();
    page.mainPaneController.state.conversation.confirmInitialRender(
      page.mainPaneController.state.conversation.initialRenderVersion.value
    );
    await opening;
    expect(page.sessionList.workspaceSessionGroup).toBeUndefined();
    await captured.seedManifest!({
      manifestVersion: 1,
      observedAt: 1,
      sessionGroups: { apiVersion: 1 },
      conversation: { available: true, reasonCode: null }
    });
    expect(page.sessionList.workspaceSessionGroup).toBe('CHILD');
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
      await captured.seedNodes!([{ ...node, nodeAppVersion: '0.11.19' }]);
      await captured.seedManifest!({
        manifestVersion: 1,
        observedAt: 1,
        sessionGroups: { apiVersion: 1 },
        conversation: { available: true, reasonCode: null }
      });
      captured.setTarget!({ nodeId: 'node-a', workspaceId: 'workspace-a' });
      captured.setSessions!(stage === 'session list' ? [] : [session]);
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
      const opening = page.selection.openSessionGroupTarget({
        nodeId: 'node-a',
        workspaceId: 'workspace-a',
        sessionId: session.id
      });
      await vi.waitFor(() => expect(resolveDetail).toBeDefined());
      page.sessionList.selectWorkspaceSessionGroup('CHILD');
      page.sessionList.selectWorkspaceSessionGroup('MAIN');
      resolveDetail!();
      await flushComponent();
      page.mainPaneController.state.conversation.confirmInitialRender(
        page.mainPaneController.state.conversation.initialRenderVersion.value
      );
      await opening;
      expect(page.sessionList.workspaceSessionGroup).toBe('MAIN');
      expect(page.selection.selectedSessionId).toBe(session.id);
    }
  );

  it('coordinates a group change only within the same Workspace', async () => {
    const { page } = controller();
    await captured.seedNodes!([{ ...node, nodeAppVersion: '0.11.19' }]);
    await captured.seedManifest!({
      manifestVersion: 1,
      observedAt: 1,
      sessionGroups: { apiVersion: 1 },
      conversation: { available: true, reasonCode: null }
    });
    captured.setTarget!({ nodeId: 'node-a', workspaceId: 'workspace-a' });
    await flushComponent();
    captured.startWorkspace.mockClear();
    captured.restartWorkspace.mockClear();

    page.sessionList.selectWorkspaceSessionGroup('CHILD');
    await flushComponent();
    expect(captured.startWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-a');
    expect(captured.restartWorkspace).not.toHaveBeenCalled();

    captured.startWorkspace.mockClear();
    captured.setTarget!({ nodeId: 'node-a', workspaceId: 'workspace-b' });
    await flushComponent();
    expect(page.sessionList.workspaceSessionGroup).toBe('MAIN');
    expect(captured.startWorkspace).not.toHaveBeenCalled();
    expect(captured.restartWorkspace).not.toHaveBeenCalled();

    page.sessionList.selectWorkspaceSessionGroup('CHILD');
    await flushComponent();
    expect(captured.startWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-b');
    expect(captured.restartWorkspace).not.toHaveBeenCalled();
  });

  it('shows only sessions in the current group page while retaining the selected session body', async () => {
    const { page } = controller();
    await captured.seedNodes!([{ ...node, nodeAppVersion: '0.11.19' }]);
    await captured.seedManifest!({
      manifestVersion: 1,
      observedAt: 1,
      sessionGroups: { apiVersion: 1 },
      conversation: { available: true, reasonCode: null }
    });
    captured.setTarget!({ nodeId: 'node-a', workspaceId: 'workspace-a' });
    captured.setSession!('body-session');
    captured.setSessions!([
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
    ]);
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

    await page.sessionList.refreshWorkspaceSessions();

    expect(page.sessionList.sessions.map((session) => session.id)).toContain('body-session');
    expect(page.sessionList.sessions.map((session) => session.id)).toContain('cached-ghost');
    expect(page.sessionList.visibleWorkspaceSessions.map((session) => session.id)).toEqual([
      'listed-main'
    ]);
  });

  it('restores a Workspace Tab session list before workspace registration finishes', async () => {
    const { page } = controller();
    const workspaces = ['workspace-a', 'workspace-b'].map((id) => ({
      id,
      path: `/${id}`,
      kind: 'DIRECTORY' as const
    }));
    const manifest: NodeWorkbenchManifest = {
      manifestVersion: 1,
      observedAt: 1,
      sessionGroups: { apiVersion: 1 },
      conversation: { available: true, reasonCode: null }
    };
    await captured.seedNodes!([{ ...node, nodeAppVersion: '0.11.19' }]);
    await captured.seedManifest!(manifest);
    captured.tree!.cacheWorkspaces(node.id, workspaces);
    let holdRegistration = false;
    let release!: () => void;
    const registration = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(String(input), 'https://console.example.test');
      if (url.pathname === '/api/workspaces' && holdRegistration) await registration;
      const workspaceId = url.searchParams.get('workspaceId');
      return new Response(
        JSON.stringify({
          manifest,
          workspaces,
          profiles: [],
          sessions: [
            {
              id: `${workspaceId}-session`,
              workspaceId,
              runner: 'codex',
              externalSessionId: `${workspaceId}-native`,
              sessionGroup: 'MAIN'
            }
          ],
          nextCursor: null
        })
      );
    });
    for (const workspace of workspaces) {
      captured.tabs!.remember(node.id, node, workspace);
      await page.selection.activateWorkspaceTab(
        page.selection.workspaceTabs.find((tab) => tab.workspaceId === workspace.id)!
      );
      await page.sessionList.refreshWorkspaceSessions();
      expect(page.sessionList.visibleWorkspaceSessions.map((session) => session.id)).toEqual([
        `${workspace.id}-session`
      ]);
    }
    holdRegistration = true;
    const switching = page.selection.activateWorkspaceTab(
      page.selection.workspaceTabs.find((tab) => tab.workspaceId === 'workspace-a')!
    );
    await flushComponent();
    expect(page.sessionList.visibleWorkspaceSessions.map((session) => session.id)).toEqual([
      'workspace-a-session'
    ]);
    release();
    await switching;
    expect(page.sessionList.visibleWorkspaceSessions.map((session) => session.id)).toEqual([
      'workspace-a-session'
    ]);
  });

  it('does not project ordinary session broadcasts before a Session Watch initial', async () => {
    const { page } = controller();
    captured.setTarget!({ nodeId: 'node-a', workspaceId: 'workspace-a' });
    captured.setSession!('session-a');
    const session = {
      id: 'session-a',
      workspaceId: 'workspace-a',
      runner: 'codex' as const,
      externalSessionId: 'native-a',
      runnerTitle: 'Original title',
      activity: 'IDLE' as const
    };
    captured.setSessions!([session]);
    captured.live!.onEvent({
      nodeId: 'node-a',
      sequence: 1,
      category: 'session',
      payload: {
        session: { ...session, runnerTitle: 'Broadcast title', activity: 'RUNNING' }
      }
    });
    expect(page.sessionList.sessions).toEqual([session]);
  });

  it('toggles active mobile top menus without changing their selected page', async () => {
    const { page } = controller();
    await captured.authenticated!();
    page.layout.mobileViewport = true;
    for (const view of ['nodes', 'settings', 'management'] as const) {
      page.application.selectNavigation(view);
      expect(page.application.view).toBe(view);
      expect(page.layout.mobileSidebarOpen).toBe(true);
      page.application.selectNavigation(view);
      expect(page.application.view).toBe(view);
      expect(page.layout.mobileSidebarOpen).toBe(false);
    }
    page.application.selectNavigation('conversations');
    expect(page.hosted.hostedConversationMobileHistoryOpen).toBe(false);
    page.application.selectNavigation('conversations');
    expect(page.hosted.hostedConversationMobileHistoryOpen).toBe(true);
    page.application.selectNavigation('conversations');
    expect(page.hosted.hostedConversationMobileHistoryOpen).toBe(false);
    page.application.selectNavigation('conversations');
    expect(page.hosted.hostedConversationMobileHistoryOpen).toBe(true);
  });

  it.each(['nodes', 'conversations'] as const)(
    'switches to mobile %s content without opening a menu or retaining another tool surface',
    async (view) => {
      const { page } = controller();
      await captured.authenticated!();
      page.layout.mobileViewport = true;
      page.application.selectNavigation(view === 'nodes' ? 'conversations' : 'nodes');
      page.layout.openMobileWorkspaceSurface('terminal');
      page.application.selectNavigation(view);
      expect(page.application.view).toBe(view);
      expect(page.layout.mobileSidebarOpen).toBe(false);
      expect(page.hosted.hostedConversationMobileHistoryOpen).toBe(false);
      expect(page.layout.mobileUtilityPanel).toBeUndefined();
      expect(page.layout.mobileWorkspaceSurface).toBe('conversation');

      page.application.selectNavigation(view);
      expect(page.layout.mobileSidebarOpen).toBe(view === 'nodes');
      expect(page.hosted.hostedConversationMobileHistoryOpen).toBe(view === 'conversations');
      page.layout.selectMobileUtilityPanel('activity');
      page.application.selectNavigation(view === 'nodes' ? 'conversations' : 'nodes');
      expect(page.layout.mobileSidebarOpen).toBe(false);
      expect(page.hosted.hostedConversationMobileHistoryOpen).toBe(false);
      expect(page.layout.mobileUtilityPanel).toBeUndefined();
    }
  );

  it('replaces hosted history and utility drawers when switching mobile menus', () => {
    const { page } = controller();
    page.layout.mobileViewport = true;
    page.application.selectNavigation('conversations');
    page.application.selectNavigation('conversations');
    expect(page.hosted.hostedConversationMobileHistoryOpen).toBe(true);
    page.layout.selectMobileUtilityPanel('activity');
    expect(page.hosted.hostedConversationMobileHistoryOpen).toBe(false);
    expect(page.layout.mobileUtilityPanel).toBe('activity');
    page.application.selectNavigation('conversations');
    expect(page.layout.mobileUtilityPanel).toBeUndefined();
    expect(page.hosted.hostedConversationMobileHistoryOpen).toBe(true);
    page.layout.selectMobileUtilityPanel('activity');
    page.application.selectNavigation('settings');
    expect(page.layout.mobileUtilityPanel).toBeUndefined();
    expect(page.layout.mobileSidebarOpen).toBe(true);
  });

  it('replaces hosted related files with global navigation without retaining a hidden tool layer', () => {
    const { page } = controller();
    page.layout.mobileViewport = true;
    page.application.selectNavigation('conversations');
    page.hosted.hostedConversationMobileFilesOpen = true;
    page.layout.selectMobileUtilityPanel('activity');
    expect(page.hosted.hostedConversationMobileFilesOpen).toBe(false);
    expect(page.layout.mobileUtilityPanel).toBe('activity');
    page.hosted.hostedConversationMobileFilesOpen = true;
    page.application.selectNavigation('nodes');
    expect(page.hosted.hostedConversationMobileFilesOpen).toBe(false);
    expect(page.layout.mobileSidebarOpen).toBe(false);
  });

  it('replaces a mobile utility menu with the active Work resource menu', async () => {
    const { page } = controller();
    await captured.authenticated!();
    page.layout.mobileViewport = true;
    page.layout.selectMobileUtilityPanel('activity');
    page.application.selectNavigation('nodes');
    expect(page.layout.mobileUtilityPanel).toBeUndefined();
    expect(page.layout.mobileSidebarOpen).toBe(true);
    page.application.selectNavigation('nodes');
    expect(page.layout.mobileSidebarOpen).toBe(false);
  });

  it('consumes host navigation and version rather than recreating defaults', () => {
    const { page, navigation, management } = controller();
    expect(page.application.view).toBe(navigation.view.value);
    expect(page.application.webVersion).toBe('9.8.7-fixture');
    expect(page.application.managementSection).toBe('custom-system');
    expect(page.application.managementItems.map((item) => item.id)).toEqual(['custom-nodes']);
    expect(management.items).toHaveBeenCalledWith(page.identity.admin);
  });
  it('ignores stale notifications and routes an existing notification through the service', async () => {
    const { page } = controller();
    page.application.view = 'settings';
    captured.notificationService!.notify({
      id: 'upload-a',
      kind: 'upload',
      title: 'Upload done',
      message: 'Ready',
      target: { nodeId: 'node-a' }
    });
    const notification = captured.notificationService!.notifications.value[0]!;
    captured.notificationService!.notifications.value = [];
    await page.application.openWorkbenchNotification(notification);
    expect(page.application.view).toBe('settings');
    captured.notificationService!.notifications.value = [notification];
    await page.application.openWorkbenchNotification(notification);
    expect(page.application.view).toBe('nodes');
    expect(captured.notificationService!.notifications.value[0]!.read).toBe(true);
  });
  it('retains a pending update after an apply failure and clears it when the document is already on that build', async () => {
    let listener!: (state: PwaApplicationState) => void;
    const initial: PwaApplicationState = { offline: 'ready', checked: true };
    const applyUpdate = vi.fn().mockResolvedValue('UNAVAILABLE');
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
    expect(captured.notificationService!.notifications.value).toEqual([]);
    listener({
      offline: 'ready',
      checked: true,
      update: { mode: 'worker', action: 'activate', version: '9.8.7', buildId: 'new-build' }
    });
    expect(captured.notificationService!.notifications.value).toEqual([
      expect.objectContaining({ kind: 'web-update', action: 'RELOAD_PAGE' })
    ]);
    expect(applyUpdate).not.toHaveBeenCalled();
    await page.application.openWorkbenchNotification(
      captured.notificationService!.notifications.value[0]!
    );
    expect(applyUpdate).toHaveBeenCalledOnce();
    expect(applyUpdate).toHaveBeenCalledWith();
    listener({
      offline: 'preparing',
      checked: true,
      unavailableUpdate: {
        mode: 'worker',
        action: 'activate',
        version: '9.8.7',
        buildId: 'new-build'
      }
    });
    expect(captured.notificationService!.notifications.value).toEqual([
      expect.objectContaining({ kind: 'web-update', read: false })
    ]);
    listener({
      offline: 'preparing',
      checked: true,
      reload: { mode: 'worker', action: 'reload', version: '9.8.7', buildId: 'new-build' }
    });
    expect(captured.notificationService!.notifications.value).toEqual([
      expect.objectContaining({ kind: 'web-update', action: 'RELOAD_PAGE' })
    ]);
    listener({
      offline: 'preparing',
      checked: true,
      reload: { mode: 'worker', action: 'activate', version: '9.8.7', buildId: 'new-build' }
    });
    expect(captured.notificationService!.notifications.value).toEqual([]);
    listener({
      offline: 'preparing',
      checked: true,
      reload: { mode: 'worker', action: 'reload', version: '9.8.7', buildId: 'other-build' }
    });
    expect(captured.notificationService!.notifications.value).toEqual([]);
  });

  it('keeps the update already detected before the authenticated notification view starts', async () => {
    const initial: PwaApplicationState = {
      offline: 'online',
      checked: true,
      update: { mode: 'online', action: 'reload', version: '9.8.7', buildId: 'new-build' }
    };
    controller({
      state: ref(initial),
      subscribe(callback: (state: PwaApplicationState) => void) {
        callback(initial);
        return () => undefined;
      }
    } as unknown as PwaApplicationService);
    await captured.authenticated!();
    expect(captured.notificationService!.notifications.value).toEqual([
      expect.objectContaining({ kind: 'web-update', read: false })
    ]);
  });
  it('reports an unavailable waiting update as a failed check, not the latest version', async () => {
    const failure = new Error('Waiting worker not ready');
    const pwa = {
      state: ref<PwaApplicationState>({ offline: 'ready', checked: true }),
      checkForUpdate: vi.fn().mockRejectedValue(failure)
    } as unknown as PwaApplicationService;
    const showMessage = vi.spyOn(feedback, 'showMessage').mockImplementation(() => undefined);
    const { page } = controller(pwa);
    await page.application.checkForUpdates();
    expect(showMessage).toHaveBeenCalledWith(translate('webUpdate.checkFailed'), 'error', failure);
    expect(showMessage).not.toHaveBeenCalledWith(translate('webUpdate.upToDate'), 'info');
  });
  it.each([true, false])(
    'refreshes restored Node state without duplicate workspace Watch (resumed=%s)',
    async (resumed) => {
      controller();
      captured.setTarget!({ nodeId: 'node-a', workspaceId: 'workspace-a' });
      await captured.seedNodes!([{ ...node, connected: false }]);
      vi.mocked(fetch).mockImplementation(
        async () => new Response(JSON.stringify({ nodes: [node] }))
      );
      const recover = vi.spyOn(captured.notificationService!, 'recover').mockResolvedValue();
      captured.live!.onConnectionRestored?.(resumed);
      captured.live!.onReady?.('connection-a', resumed);
      await flushComponent();
      expect(fetch).toHaveBeenCalledWith('/api/nodes', expect.anything());
      expect(recover).toHaveBeenCalledOnce();
      expect(captured.startWorkspace).toHaveBeenCalledTimes(resumed ? 0 : 1);
      expect(captured.restartWorkspace).not.toHaveBeenCalled();
    }
  );
  it('releases standalone intents and late route updates when its file owner is disposed', async () => {
    const { page } = controller();
    page.identity.admin = {
      authenticated: true,
      mustChangePassword: false,
      isAdmin: true,
      managementWritable: true
    };
    await captured.seedNodes!([node]);
    captured.setTarget!({ nodeId: node.id, workspaceId: 'workspace-a' });
    await captured.seedManifest!({
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null },
      files: { available: true, reasonCode: null }
    });
    let finish!: () => void;
    const opening = new Promise<void>((resolve) => (finish = resolve));
    const openFile = vi
      .fn()
      .mockImplementationOnce(() => opening)
      .mockResolvedValue(undefined);
    captured.standaloneOpen = openFile;
    const intent = (path: string) =>
      new CustomEvent(STANDALONE_FILE_OPEN_EVENT, {
        cancelable: true,
        detail: {
          url: `/console?standaloneFile=1&nodeId=node-a&workspaceId=workspace-a&path=${path}`
        }
      });
    try {
      window.dispatchEvent(intent('first.ts'));
      await flushComponent();
      expect(openFile).toHaveBeenCalledTimes(1);
      vi.mocked(history.replaceState).mockClear();
      page.files.fileWorkbench.dispose();
      const next = intent('next.ts');
      window.dispatchEvent(next);
      expect(next.defaultPrevented).toBe(false);
      finish();
      await flushComponent();
      expect(openFile).toHaveBeenCalledTimes(1);
      expect(history.replaceState).not.toHaveBeenCalled();
    } finally {
      finish();
      await flushComponent();
    }
  });
  it.each([false, true])(
    'serializes pending file intents and recovers after the first open (failed=%s)',
    async (failed) => {
      const { page } = controller();
      page.identity.admin = {
        authenticated: true,
        mustChangePassword: false,
        isAdmin: true,
        managementWritable: true
      };
      await captured.seedNodes!([node]);
      captured.setTarget!({ nodeId: node.id, workspaceId: 'workspace-a' });
      await captured.seedManifest!({
        manifestVersion: 1,
        observedAt: 1,
        conversation: { available: true, reasonCode: null },
        files: { available: true, reasonCode: null }
      });
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
      captured.standaloneOpen = openFile;
      const open = (path: string) =>
        window.dispatchEvent(
          new CustomEvent(STANDALONE_FILE_OPEN_EVENT, {
            detail: {
              url: `/console?standaloneFile=1&nodeId=node-a&workspaceId=${page.selection.workspaceTarget!.workspaceId}&path=${path}`
            }
          })
        );
      open('first.ts');
      await flushComponent();
      expect(openFile).toHaveBeenCalledTimes(1);
      vi.mocked(history.replaceState).mockClear();
      captured.setTarget!({ nodeId: node.id, workspaceId: 'workspace-b' });
      open('second.ts');
      await flushComponent();
      expect(openFile).toHaveBeenCalledTimes(1);
      expect(page.files.standaloneFileLoading).toBe(true);
      if (failed) reject(new Error('First open failed'));
      else finish();
      await flushComponent();
      expect(openFile).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ path: 'second.ts', nodeId: 'node-a', workspaceId: 'workspace-b' })
      );
      expect(history.replaceState).not.toHaveBeenCalled();
      expect(page.files.standaloneFileError).toBe(false);
      expect(page.files.standaloneFileLoading).toBe(true);
      finishSecond();
      await flushComponent();
      expect(page.files.standaloneFileLoading).toBe(false);
      expect(page.files.standaloneFileError).toBe(false);
      expect(String(vi.mocked(history.replaceState).mock.lastCall?.[2])).toContain(
        'path=second.ts'
      );
      expect(page.selection.workspaceTarget?.workspaceId).toBe('workspace-b');
    }
  );
  it('waits for the manifest, reports unavailable files, and accepts a later retry', async () => {
    const { page } = controller();
    page.identity.admin = {
      authenticated: true,
      mustChangePassword: false,
      isAdmin: true,
      managementWritable: true
    };
    await captured.seedNodes!([node]);
    captured.setTarget!({ nodeId: node.id, workspaceId: 'workspace-a' });
    captured.capability!.selectNode(node.id);
    const openFile = vi.fn(async () => undefined);
    captured.standaloneOpen = openFile;
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
    expect(page.files.standaloneFileLoading).toBe(true);
    expect(page.files.standaloneFileError).toBe(false);
    captured.capability!.invalidateNodeManifest(node.id);
    await flushComponent();
    expect(page.files.standaloneFileLoading).toBe(false);
    expect(page.files.standaloneFileError).toBe(true);
    await captured.seedManifest!({
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null },
      files: { available: true, reasonCode: null }
    });
    open();
    await flushComponent();
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'retry.ts', nodeId: 'node-a', workspaceId: 'workspace-a' })
    );
    expect(page.files.standaloneFileLoading).toBe(false);
    expect(page.files.standaloneFileError).toBe(false);
  });
});
