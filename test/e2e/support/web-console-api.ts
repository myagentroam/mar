import type { Page, Route } from '@playwright/test';

export async function mockEmptyWorkspaceFiles(
  page: Page,
  workspaceIds: readonly string[]
): Promise<void> {
  const paths = new Set(
    workspaceIds.map((id) => `/api/workspaces/${encodeURIComponent(id)}/files`)
  );
  await page.route(/\/api\/workspaces\/[^/]+\/files(?:\?.*)?$/, (route) => {
    if (!paths.has(new URL(route.request().url()).pathname)) return route.fallback();
    return json(route, { files: { entries: [], nextCursor: null, truncated: false } });
  });
}

function withMockNativeSessionIdentity(
  session: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  return {
    ...session,
    externalSessionId:
      typeof session.externalSessionId === 'string'
        ? session.externalSessionId
        : `mock-native:${String(session.id)}`
  };
}

function isMockAgentSession(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === 'string' &&
    typeof (value as Record<string, unknown>).workspaceId === 'string' &&
    typeof (value as Record<string, unknown>).runner === 'string'
  );
}

function normalizeMockAgentSessionPayload(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const value = body as Readonly<Record<string, unknown>>;
  const session = isMockAgentSession(value.session)
    ? withMockNativeSessionIdentity(value.session)
    : value.session;
  const sessions = Array.isArray(value.sessions)
    ? value.sessions.map((item) =>
        isMockAgentSession(item) ? withMockNativeSessionIdentity(item) : item
      )
    : value.sessions;
  if (session === value.session && sessions === value.sessions) return body;
  return {
    ...value,
    ...(session === undefined ? {} : { session }),
    ...(sessions === undefined ? {} : { sessions })
  };
}

export async function mockConsoleApi(
  page: Page,
  level: 'MANAGED',
  capabilities: readonly string[],
  writes: { readonly url: string; readonly csrf: string | undefined; readonly body: string }[],
  workspaceKind: 'DIRECTORY' | 'GIT_WORKSPACE' = 'GIT_WORKSPACE',
  connected = true,
  activityOverride?: 'MANAGED_ACTIVE' | 'IDLE',
  runnerDefaults?: readonly {
    readonly runner: 'codex' | 'claude-code';
    readonly modelId: string;
    readonly effort: string;
    readonly access: string;
  }[],
  nodeAppVersion = '0.9.6',
  routeInContext = false
): Promise<void> {
  const routing = routeInContext ? page.context() : page;
  await routing.addInitScript(() => {
    if (localStorage.getItem('mar.locale.v2') === null)
      localStorage.setItem('mar.locale.v2', 'zh-CN');
    // Regular Console mocks have no real login cookie. Connecting to the test Server Workbench
    // WebSocket would close with 4001 and incorrectly return the page to login. Dedicated realtime
    // tests install their own mock first, which remains available for actively pushing events.
    if (
      window.WebSocket.name === 'MockWorkbenchWebSocket' ||
      window.WebSocket.name === 'MockWebSocket'
    ) {
      type ExistingMockSocket = EventTarget & {
        readonly url: string;
        readonly readyState: number;
      };
      type ExistingMockSocketConstructor = {
        readonly CLOSED: number;
        readonly instances: ExistingMockSocket[];
        readonly prototype: {
          send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
        };
        acceptSessionWatch?: (watch: Record<string, unknown>, payload: unknown) => void;
        acceptWorkspaceWatch?: (
          watch: Record<string, unknown>,
          snapshots: Readonly<Record<string, unknown>>
        ) => void;
      };
      const existing = window.WebSocket as unknown as ExistingMockSocketConstructor;
      const originalSend = existing.prototype.send;
      existing.prototype.send = function (
        this: ExistingMockSocket,
        data: string | ArrayBufferLike | Blob | ArrayBufferView
      ): void {
        if (!this.url.includes('/api/workbench/live')) {
          originalSend.call(this, data);
          return;
        }
        let message: unknown;
        try {
          message = JSON.parse(String(data)) as unknown;
        } catch {
          return;
        }
        if (
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'ping' &&
          'id' in message &&
          typeof message.id === 'string'
        ) {
          const id = message.id;
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent('message', { data: JSON.stringify({ type: 'pong', id }) })
            )
          );
          return;
        }
        if (
          typeof message !== 'object' ||
          message === null ||
          !('type' in message) ||
          message.type !== 'resume'
        )
          return;
        const resumed =
          existing.instances.filter((socket) => socket.url.includes('/api/workbench/live')).length >
          1;
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'workbench.ready',
                workbenchConnectionId: 'mock-workbench-connection',
                workbenchResumeToken: 'mock-workbench-token',
                resumed
              })
            })
          )
        );
      };
      const CustomWebSocket = new Proxy(window.WebSocket, {
        construct(target, argumentsList) {
          const socket = Reflect.construct(target, argumentsList) as ExistingMockSocket;
          if (!socket.url.includes('/api/workbench/live')) return socket;
          let opened = false;
          socket.addEventListener('open', () => {
            opened = true;
          });
          queueMicrotask(() => {
            if (!opened) socket.dispatchEvent(new Event('open'));
          });
          return socket;
        }
      });
      Object.defineProperty(window, 'WebSocket', {
        configurable: true,
        value: CustomWebSocket
      });
      const currentSocket = (): ExistingMockSocket | undefined => {
        for (let index = existing.instances.length - 1; index >= 0; index -= 1) {
          const socket = existing.instances[index];
          if (socket?.url.includes('/api/workbench/live') && socket.readyState !== existing.CLOSED)
            return socket;
        }
        return undefined;
      };
      existing.acceptSessionWatch = (watch, payload) => {
        currentSocket()?.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'watch.event',
              event: {
                type: 'watch.session.snapshot',
                workbenchConnectionId: 'mock-workbench-connection',
                ...watch,
                revision: 1,
                snapshotSequence: 1,
                expiresAt: Date.now() + 30_000,
                payload
              }
            })
          })
        );
      };
      existing.acceptWorkspaceWatch = (watch, snapshots) => {
        let revision = 0;
        for (const [topic, payload] of Object.entries(snapshots))
          currentSocket()?.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'watch.event',
                event: {
                  type: 'watch.workspace.snapshot',
                  workbenchConnectionId: 'mock-workbench-connection',
                  ...watch,
                  topic,
                  revision: ++revision,
                  snapshotSequence: revision,
                  expiresAt: Date.now() + 30_000,
                  payload
                }
              })
            })
          );
      };
      Object.defineProperty(window, '__consoleMockWorkbenchWebSocket', {
        configurable: true,
        value: existing
      });
      return;
    }
    class ConsoleMockWorkbenchWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      static readonly instances: ConsoleMockWorkbenchWebSocket[] = [];
      static activeWatch:
        | {
            nodeGeneration: string;
            nodeId: string;
            watchId: string;
            sessionId: string;
            workspaceId: string;
          }
        | undefined;
      static activeHostedWatch:
        | {
            nodeGeneration: string;
            nodeId: string;
            watchId: string;
            conversationId: string;
          }
        | undefined;
      static activeWorkspaceWatch: Record<string, unknown> | undefined;
      static readonly workspaceTopicRevisions = new Map<string, number>();
      static sequence = 10;
      static resumeAsResumed = false;

      static emitNodeConnection(nodeId: string, connected: boolean): void {
        const socket = ConsoleMockWorkbenchWebSocket.instances.find(
          (item) =>
            item.url.includes('/api/workbench/live') &&
            item.readyState !== ConsoleMockWorkbenchWebSocket.CLOSED
        );
        socket?.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({ type: 'node', nodeId, connected })
          })
        );
      }

      static closeActive(): void {
        const socket = ConsoleMockWorkbenchWebSocket.instances.find(
          (item) =>
            item.url.includes('/api/workbench/live') &&
            item.readyState !== ConsoleMockWorkbenchWebSocket.CLOSED
        );
        socket?.close();
      }

      static acceptSessionWatch(
        watch: NonNullable<typeof ConsoleMockWorkbenchWebSocket.activeWatch>,
        payload: unknown
      ): void {
        ConsoleMockWorkbenchWebSocket.activeWatch = watch;
        ConsoleMockWorkbenchWebSocket.dispatch({
          type: 'watch.session.snapshot',
          workbenchConnectionId: 'mock-workbench-connection',
          ...watch,
          revision: 1,
          snapshotSequence: 1,
          expiresAt: Date.now() + 30_000,
          payload
        });
      }

      static emitSessionEvent(category: string, payload: unknown): boolean {
        const watch = ConsoleMockWorkbenchWebSocket.activeWatch;
        if (watch === undefined) return false;
        ConsoleMockWorkbenchWebSocket.dispatch({
          type: 'watch.session.event',
          workbenchConnectionId: 'mock-workbench-connection',
          ...watch,
          event: { sequence: ++ConsoleMockWorkbenchWebSocket.sequence, category, payload }
        });
        return true;
      }

      static acceptHostedConversationWatch(
        watch: NonNullable<typeof ConsoleMockWorkbenchWebSocket.activeHostedWatch>,
        payload: unknown
      ): void {
        ConsoleMockWorkbenchWebSocket.activeHostedWatch = watch;
        ConsoleMockWorkbenchWebSocket.dispatch({
          type: 'watch.hosted-conversation.snapshot',
          workbenchConnectionId: 'mock-workbench-connection',
          ...watch,
          revision: 1,
          snapshotSequence: 1,
          expiresAt: 1_900_000_030_000,
          payload
        });
      }

      static emitHostedConversationEvent(payload: unknown): boolean {
        const watch = ConsoleMockWorkbenchWebSocket.activeHostedWatch;
        if (watch === undefined) return false;
        ConsoleMockWorkbenchWebSocket.dispatch({
          type: 'watch.hosted-conversation.event',
          workbenchConnectionId: 'mock-workbench-connection',
          ...watch,
          expiresAt: 1_900_000_030_000,
          event: {
            sequence: ++ConsoleMockWorkbenchWebSocket.sequence,
            category: 'hosted-conversation',
            payload
          }
        });
        return true;
      }

      static acceptWorkspaceWatch(
        watch: Record<string, unknown>,
        snapshots: Readonly<Record<string, unknown>>
      ): void {
        ConsoleMockWorkbenchWebSocket.activeWorkspaceWatch = watch;
        for (const [topic, payload] of Object.entries(snapshots))
          ConsoleMockWorkbenchWebSocket.emitWorkspaceSnapshot(topic, payload);
      }

      static emitWorkspaceSnapshot(topic: string, payload: unknown): boolean {
        const watch = ConsoleMockWorkbenchWebSocket.activeWorkspaceWatch;
        if (watch === undefined) return false;
        const revision =
          (ConsoleMockWorkbenchWebSocket.workspaceTopicRevisions.get(topic) ?? 0) + 1;
        ConsoleMockWorkbenchWebSocket.workspaceTopicRevisions.set(topic, revision);
        ConsoleMockWorkbenchWebSocket.dispatch({
          type: 'watch.workspace.snapshot',
          workbenchConnectionId: 'mock-workbench-connection',
          ...watch,
          topic,
          revision,
          snapshotSequence: revision,
          expiresAt: Date.now() + 30_000,
          payload
        });
        return true;
      }

      static dispatch(frame: unknown): void {
        const socket = ConsoleMockWorkbenchWebSocket.instances.find(
          (item) =>
            item.url.includes('/api/workbench/live') &&
            item.readyState === ConsoleMockWorkbenchWebSocket.OPEN
        );
        socket?.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({ type: 'watch.event', event: frame })
          })
        );
      }

      readonly url: string;
      readyState = ConsoleMockWorkbenchWebSocket.CONNECTING;

      constructor(url: string | URL) {
        const value = String(url);
        super();
        this.url = value;
        ConsoleMockWorkbenchWebSocket.instances.push(this);
        queueMicrotask(() => {
          if (this.readyState !== ConsoleMockWorkbenchWebSocket.CONNECTING) return;
          this.readyState = ConsoleMockWorkbenchWebSocket.OPEN;
          this.dispatchEvent(new Event('open'));
        });
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        let message: unknown;
        try {
          message = JSON.parse(String(data)) as unknown;
        } catch {
          return;
        }
        if (
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'ping' &&
          'id' in message &&
          typeof message.id === 'string'
        ) {
          const id = message.id;
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({ type: 'pong', id })
              })
            )
          );
          return;
        }
        if (
          typeof message !== 'object' ||
          message === null ||
          !('type' in message) ||
          message.type !== 'resume'
        )
          return;
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'workbench.ready',
                workbenchConnectionId: 'mock-workbench-connection',
                workbenchResumeToken: 'mock-workbench-token',
                resumed: ConsoleMockWorkbenchWebSocket.resumeAsResumed
              })
            })
          )
        );
      }

      close(): void {
        if (this.readyState === ConsoleMockWorkbenchWebSocket.CLOSED) return;
        this.readyState = ConsoleMockWorkbenchWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent('close'));
      }
    }
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      value: ConsoleMockWorkbenchWebSocket
    });
    Object.defineProperty(window, '__consoleMockWorkbenchWebSocket', {
      configurable: true,
      value: ConsoleMockWorkbenchWebSocket
    });
  });
  let authenticated = false;
  const activity =
    activityOverride ?? (capabilities.includes('turn.steer') ? 'MANAGED_ACTIVE' : 'IDLE');
  const session = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    runner: 'codex' as const,
    externalSessionId: 'vscode-thread-1',
    nativeControl: 'EXTERNAL' as const,
    activity,
    control: { level, capabilities }
  };
  await routing.route('**/api/auth/me', (route) =>
    json(
      route,
      authenticated
        ? { authenticated: true, mustChangePassword: false, username: 'admin', isAdmin: true }
        : { authenticated: false, mustChangePassword: false }
    )
  );
  await routing.route('**/api/auth/login', (route) => {
    authenticated = true;
    return json(route, {
      authenticated: true,
      mustChangePassword: false,
      username: 'admin',
      isAdmin: true,
      csrfToken: 'csrf-1'
    });
  });
  await routing.route('**/api/auth/csrf', (route) => json(route, { csrfToken: 'csrf-1' }));
  await routing.route('**/api/auth/sessions', (route) => json(route, { sessions: [] }));
  await routing.route(/\/api\/notifications(?:\/.*)?$/, (route) =>
    json(route, route.request().method() === 'GET' ? { notifications: [] } : {})
  );
  await routing.route('**/api/management/users', (route) => json(route, { users: [] }));
  await routing.route('**/api/environment-secrets**', (route) => {
    if (route.request().method() === 'GET') return json(route, { secrets: [] });
    return write(route, writes, {});
  });
  await routing.route('**/api/system-settings', (route) =>
    json(route, { auditRetentionDays: 180, skillTlsVerificationDisabled: false })
  );
  await routing.route('**/api/workbench-capabilities', (route) =>
    json(route, { serverVersion: '0.9.6' })
  );
  await routing.route('**/api/nodes', (route) =>
    json(route, {
      nodes: [
        {
          id: 'node-1',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion,
          nodeVersion: 'v24.15.0',
          connected,
          disabled: false,
          capabilities: {
            codex: { available: true, version: '0.146' },
            claudeCode: { available: true, version: '2.1' }
          }
        }
      ]
    })
  );
  await routing.route('**/api/nodes/node-1/workbench-capabilities', (route) =>
    json(route, {
      manifest: {
        manifestVersion: 1,
        observedAt: 1_900_000_000_000,
        conversation: { available: true, reasonCode: null },
        files: { available: true, reasonCode: null },
        git: { available: true, reasonCode: null, supportsHistory: true },
        terminal: {
          available: true,
          reasonCode: null,
          supportsReplay: true,
          supportsTakeover: true,
          profiles: [{ id: 'default', label: 'Default shell', isDefault: true }]
        }
      }
    })
  );
  const testTerminal = {
    id: 'terminal-1',
    workspaceId: 'workspace-1',
    profileId: 'default',
    state: 'RUNNING' as const,
    latestSequence: 0
  };
  await routing.route('**/api/terminals?nodeId=node-1', (route) =>
    json(route, { terminals: [testTerminal] })
  );
  await routing.route('**/api/terminals/terminal-1/attach-ticket', (route) =>
    json(route, { ticket: 'terminal-ticket-1' })
  );
  await routing.route('**/api/terminals', (route) =>
    write(route, writes, { terminal: testTerminal })
  );
  await routing.route('**/api/workspaces?nodeId=node-1', (route) =>
    connected
      ? json(route, {
          workspaces: [
            {
              id: 'workspace-1',
              path: '/project',
              kind: workspaceKind,
              gitSummary: workspaceKind === 'GIT_WORKSPACE' ? { branch: 'master' } : undefined
            }
          ]
        })
      : json(route, { error: { code: 'NODE_OFFLINE' } }, 409)
  );
  await routing.route(/\/api\/workspaces$/, (route) =>
    write(route, writes, {
      workspace: {
        id: 'workspace-created',
        path: '/another-project',
        kind: 'DIRECTORY'
      }
    })
  );
  await routing.route(/\/api\/workspace-directories(?:\?.*)?$/, (route) =>
    json(route, {
      directory: {
        homePath: '/home/node',
        currentPath: '/home/node',
        parentPath: null,
        browseRoots: ['/home/node'],
        selectable: true,
        entries: [{ path: '/another-project', name: 'another-project', selectable: true }],
        truncated: false
      }
    })
  );
  await routing.route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, (route) =>
    json(route, {
      files: {
        entries: [{ path: 'src/main.ts', name: 'main.ts', kind: 'FILE', size: 25, modifiedAt: 1 }],
        nextCursor: null,
        truncated: false
      }
    })
  );
  await routing.route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) =>
    json(route, {
      file: {
        path: 'src/main.ts',
        encoding: 'utf-8',
        size: 25,
        content: 'export const answer = 42;',
        truncated: false,
        nextOffset: null
      }
    })
  );
  await routing.route(/\/api\/workspaces\/workspace-1\/files\/search(?:\?.*)?$/, (route) =>
    json(route, { files: { entries: [], nextCursor: null, truncated: false } })
  );
  await routing.route(/\/api\/workspaces\/workspace-1\/effective-skills(?:\?.*)?$/, (route) =>
    json(route, { skills: [] })
  );
  await routing.route(/\/api\/workspaces\/workspace-1\/changes(?:\?.*)?$/, (route) =>
    json(route, { changes: [] })
  );
  await routing.route(/\/api\/workspaces\/[^/]+\/watch$/, (route) =>
    fulfillMockWorkspaceWatch(page, route, undefined, workspaceKind)
  );
  await routing.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, (route) =>
    json(route, {
      sessions: [session],
      nextCursor: null
    })
  );
  await routing.route('**/api/agent-sessions/session-1?nodeId=node-1', (route) =>
    json(route, { session })
  );
  await routing.route('**/api/agent-sessions/*/channel-token?nodeId=node-1', (route) =>
    json(route, { token: 'test-channel-token' })
  );
  await routing.route('**/api/agent-sessions/discover', (route) => json(route, { sessions: [] }));
  await routing.route(/\/api\/runner-profiles\?.*\bnodeId=node-1(?:&|$)/, (route) =>
    json(route, {
      profiles: [
        {
          runner: 'codex',
          models: [
            {
              id: 'gpt-5.6-sol',
              label: 'GPT-5.6 Sol',
              supportedEfforts: ['low', 'medium', 'high']
            },
            {
              id: 'gpt-5.6-terra',
              label: 'GPT-5.6 Terra',
              supportedEfforts: ['medium', 'high', 'xhigh']
            }
          ],
          accessOptions: [
            { id: 'on-request', label: 'On-request' },
            { id: 'workspace-write', label: 'Workspace write' },
            { id: 'full-access', label: 'Full access' },
            { id: 'read-only', label: 'Read-only' }
          ],
          commands: [
            {
              id: 'compact',
              runner: 'codex',
              label: '/compact',
              description: '立即压缩当前会话上下文。',
              inputHint: '/compact',
              source: 'CODEX_APP_SERVER',
              interaction: 'IMMEDIATE_ACTION',
              available: true,
              reasonCode: null
            },
            {
              id: 'plan',
              runner: 'codex',
              label: '/plan',
              description: '开启或关闭协作规划模式。',
              inputHint: '/plan',
              source: 'CODEX_APP_SERVER',
              interaction: 'TOGGLE',
              available: true,
              reasonCode: null
            }
          ],
          capabilities: ['history.read', 'turn.start']
        },
        {
          runner: 'claude-code',
          models: [
            { id: 'sonnet', label: 'Claude Sonnet', supportedEfforts: ['low', 'medium', 'high'] }
          ],
          accessOptions: [
            { id: 'default', label: 'Default' },
            { id: 'bypass', label: 'Bypass permissions' }
          ],
          commands: [],
          capabilities: ['history.read', 'turn.start']
        }
      ],
      ...(runnerDefaults === undefined ? {} : { defaults: runnerDefaults })
    })
  );
  await routing.route('**/api/runner-commands', (route) =>
    write(route, writes, { enabled: false })
  );
  await routing.route('**/api/agent-sessions/session-1/context?nodeId=node-1', (route) =>
    json(route, { context: null })
  );
  await routing.route(
    '**/api/workspaces/workspace-1/queue?nodeId=node-1&sessionId=session-1',
    (route) => json(route, { queue: { version: 0, paused: false, items: [] } })
  );
  await routing.route('**/api/agent-sessions/session-1/watch*', (route) =>
    fulfillMockSessionWatch(page, route, session, {
      kind: 'session-watch-snapshot',
      sequence: 1,
      session,
      runs:
        activity === 'MANAGED_ACTIVE'
          ? [
              {
                id: 'run-1',
                sessionId: session.id,
                workspaceId: session.workspaceId,
                status: 'RUNNING',
                recoveryState: 'ACTIVE',
                clientMessageId: 'message-1'
              }
            ]
          : [],
      queue: { version: 0, paused: false, items: [] },
      context: null,
      conversation: {
        unit: 'SEGMENT',
        source: 'official',
        readAt: 1,
        latestVisibleAt: 2,
        nextCursor: null,
        snapshotSequence: 1,
        segments: [
          {
            id: 'turn-1:segment:0',
            sessionId: session.id,
            turnId: 'turn-1',
            runId: activity === 'MANAGED_ACTIVE' ? 'run-1' : null,
            index: 0,
            status: 'RUNNING',
            startedAt: 1,
            completedAt: null,
            items: [
              {
                id: 'item-1',
                sessionId: session.id,
                turnId: 'turn-1',
                runId: activity === 'MANAGED_ACTIVE' ? 'run-1' : null,
                parentItemId: null,
                sourceSequence: null,
                revision: 1,
                kind: 'assistant_message',
                status: 'IN_PROGRESS',
                startedAt: 1,
                completedAt: null,
                payload: { text: '正在同步对话', format: 'markdown', model: null }
              },
              {
                id: 'item-thinking',
                sessionId: session.id,
                turnId: 'turn-1',
                runId: activity === 'MANAGED_ACTIVE' ? 'run-1' : null,
                parentItemId: null,
                sourceSequence: null,
                revision: 1,
                kind: 'reasoning_summary',
                status: 'COMPLETED',
                startedAt: 1,
                completedAt: 1,
                payload: { sections: [{ index: 0, text: '检查当前工作区' }] }
              },
              {
                id: 'item-tool',
                sessionId: session.id,
                turnId: 'turn-1',
                runId: activity === 'MANAGED_ACTIVE' ? 'run-1' : null,
                parentItemId: null,
                sourceSequence: null,
                revision: 1,
                kind: 'tool_call',
                status: 'COMPLETED',
                startedAt: 1,
                completedAt: 1,
                payload: {
                  namespace: 'functions',
                  toolName: 'exec_command',
                  title: '读取 package.json',
                  inputSummary: '{"cmd":"cat package.json"}',
                  outputSummary: '{"name":"example"}',
                  progressLabel: null,
                  errorCode: null,
                  truncated: false
                }
              },
              {
                id: 'run-1:approval:approval-1',
                sessionId: session.id,
                turnId: 'turn-1',
                runId: activity === 'MANAGED_ACTIVE' ? 'run-1' : null,
                parentItemId: null,
                sourceSequence: null,
                revision: 1,
                kind: 'approval_request',
                status: 'PENDING',
                startedAt: 1,
                completedAt: null,
                payload: {
                  approvalId: 'approval-1',
                  approvalStatus: 'PENDING',
                  approval: { toolName: 'Bash', input: { command: 'pwd' } },
                  expiresAt: 1_900_000_000_000
                }
              },
              {
                id: 'run-1:approval:approval-2',
                sessionId: session.id,
                turnId: 'turn-1',
                runId: activity === 'MANAGED_ACTIVE' ? 'run-1' : null,
                parentItemId: null,
                sourceSequence: null,
                revision: 1,
                kind: 'approval_request',
                status: 'COMPLETED',
                startedAt: 1,
                completedAt: 1,
                payload: {
                  approvalId: 'approval-2',
                  approvalStatus: 'APPROVED',
                  approval: { toolName: 'Bash', input: { command: 'git status' } },
                  expiresAt: 1_900_000_010_000
                }
              },
              {
                id: 'item-summary',
                sessionId: session.id,
                turnId: 'turn-1',
                runId: activity === 'MANAGED_ACTIVE' ? 'run-1' : null,
                parentItemId: null,
                sourceSequence: null,
                revision: 1,
                kind: 'turn_summary',
                status: 'COMPLETED',
                startedAt: 1,
                completedAt: 1,
                payload: { status: 'SUCCEEDED', durationMs: 12 }
              }
            ]
          },
          {
            id: 'turn-older:segment:0',
            sessionId: session.id,
            turnId: 'turn-older',
            runId: null,
            index: 0,
            status: 'SUCCEEDED',
            startedAt: 0,
            completedAt: 0,
            items: [
              {
                id: 'item-older',
                sessionId: session.id,
                turnId: 'turn-older',
                runId: null,
                parentItemId: null,
                sourceSequence: null,
                revision: 1,
                kind: 'assistant_message',
                status: 'COMPLETED',
                startedAt: 0,
                completedAt: 0,
                payload: { text: '较早的对话', format: 'markdown', model: null }
              }
            ]
          }
        ]
      }
    })
  );
  await routing.route('**/api/runner-defaults', (route) => write(route, writes, { defaults: [] }));
  await routing.route(
    /\/api\/agent-sessions\/session-1\/turns\?nodeId=node-1&limit=\d+(?:&cursor=[^&]+)?(?:&unit=SEGMENT)?$/,
    (route) =>
      json(route, {
        turns: [
          {
            id: 'turn-1',
            status: 'RUNNING',
            items: [
              {
                id: 'item-1',
                kind: 'assistant_message',
                status: 'IN_PROGRESS',
                payload: { text: '正在同步对话' }
              },
              {
                id: 'item-thinking',
                kind: 'reasoning_summary',
                status: 'COMPLETED',
                payload: { sections: [{ index: 0, text: '检查当前工作区' }] }
              },
              {
                id: 'item-tool',
                kind: 'tool_call',
                status: 'COMPLETED',
                payload: {
                  namespace: 'functions',
                  toolName: 'exec_command',
                  title: '读取 package.json',
                  inputSummary: '{"cmd":"cat package.json"}',
                  outputSummary: '{"name":"example"}',
                  progressLabel: null,
                  errorCode: null,
                  truncated: false
                }
              },
              {
                id: 'item-summary',
                kind: 'turn_summary',
                status: 'COMPLETED',
                payload: { status: 'SUCCEEDED', durationMs: 12 }
              }
            ]
          },
          {
            id: 'turn-older',
            status: 'SUCCEEDED',
            items: [
              {
                id: 'item-older',
                kind: 'assistant_message',
                status: 'COMPLETED',
                payload: { text: '较早的对话' }
              }
            ]
          }
        ],
        nextCursor: null
      })
  );
  await routing.route('**/api/agent-sessions/session-1/runs?nodeId=node-1', (route) =>
    json(route, {
      runs: [
        { id: 'run-1', status: 'RUNNING', recoveryState: 'ACTIVE', clientMessageId: 'message-1' }
      ]
    })
  );
  await routing.route('**/api/agent-runs/run-1/events?nodeId=node-1&after=0', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: 'id: 1\nevent: run-event\ndata: {"id":1,"sequence":1,"eventType":"text.delta","payload":{"text":"<img src=x onerror=alert(1)>"}}\n\n'
    })
  );
  await routing.route('**/api/agent-runs/run-1/approvals/approval-1/decision', (route) =>
    write(route, writes, { approval: { id: 'approval-1', status: 'APPROVED' } })
  );
  await routing.route('**/api/agent-sessions/session-1/messages', (route) =>
    write(route, writes, {
      session,
      run: {
        id: 'run-1',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        status: 'RUNNING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'next-message'
      }
    })
  );
}

export async function installSessionIdleSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class MockWorkbenchWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: MockWorkbenchWebSocket[] = [];
      static acceptSessionWatch(watch: Record<string, unknown>, payload: unknown): void {
        const socket = MockWorkbenchWebSocket.instances.find((item) =>
          item.url.includes('/api/workbench/live')
        );
        socket?.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'watch.event',
              event: {
                type: 'watch.session.snapshot',
                workbenchConnectionId: 'mock-workbench-connection',
                ...watch,
                payload
              }
            })
          })
        );
      }
      static acceptWorkspaceWatch(
        watch: Record<string, unknown>,
        snapshots: Readonly<Record<string, unknown>>
      ): void {
        const socket = MockWorkbenchWebSocket.instances.find((item) =>
          item.url.includes('/api/workbench/live')
        );
        let revision = 0;
        for (const [topic, payload] of Object.entries(snapshots)) {
          socket?.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'watch.event',
                event: {
                  type: 'watch.workspace.snapshot',
                  workbenchConnectionId: 'mock-workbench-connection',
                  ...watch,
                  topic,
                  revision: ++revision,
                  payload
                }
              })
            })
          );
        }
      }
      static emitRunActive() {
        const socket = MockWorkbenchWebSocket.instances.find((item) =>
          item.url.includes('/api/workbench/live')
        );
        socket?.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'event',
              event: {
                nodeId: 'node-1',
                sequence: 1,
                category: 'run',
                payload: {
                  run: {
                    id: 'run-session-2-live',
                    sessionId: 'session-2',
                    workspaceId: 'workspace-1',
                    status: 'RUNNING',
                    recoveryState: 'ACTIVE',
                    clientMessageId: 'message-session-2-live'
                  }
                }
              }
            })
          })
        );
      }
      static emitSessionIdle() {
        const socket = MockWorkbenchWebSocket.instances.find((item) =>
          item.url.includes('/api/workbench/live')
        );
        socket?.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'event',
              event: {
                nodeId: 'node-1',
                sequence: 2,
                category: 'run',
                payload: {
                  run: {
                    id: 'run-session-2-live',
                    sessionId: 'session-2',
                    workspaceId: 'workspace-1',
                    status: 'SUCCEEDED',
                    recoveryState: 'ACTIVE',
                    clientMessageId: 'message-session-2-live'
                  }
                }
              }
            })
          })
        );
        socket?.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'event',
              event: {
                nodeId: 'node-1',
                sequence: 3,
                category: 'session',
                payload: {
                  session: {
                    id: 'session-2',
                    workspaceId: 'workspace-1',
                    runner: 'codex',
                    externalSessionId: 'mock-native:session-2',
                    runnerTitle: '第二会话',
                    activity: 'IDLE',
                    control: {
                      level: 'MANAGED',
                      capabilities: ['history.read', 'events.live', 'turn.start']
                    }
                  }
                }
              }
            })
          })
        );
      }
      readonly url: string;
      readyState = MockWorkbenchWebSocket.OPEN;
      constructor(url: string) {
        super();
        this.url = url;
        MockWorkbenchWebSocket.instances.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        let message: unknown;
        try {
          message = JSON.parse(String(data)) as unknown;
        } catch {
          return;
        }
        if (
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'ping' &&
          'id' in message &&
          typeof message.id === 'string'
        ) {
          const id = message.id;
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent('message', { data: JSON.stringify({ type: 'pong', id }) })
            )
          );
          return;
        }
        if (
          typeof message !== 'object' ||
          message === null ||
          !('type' in message) ||
          message.type !== 'resume'
        )
          return;
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'workbench.ready',
                workbenchConnectionId: 'mock-workbench-connection',
                workbenchResumeToken: 'mock-workbench-token',
                resumed: false
              })
            })
          )
        );
      }
      close() {
        this.readyState = MockWorkbenchWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent('close'));
      }
    }
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      value: MockWorkbenchWebSocket
    });
    Object.defineProperty(window, '__runIdleSocket', {
      configurable: true,
      value: MockWorkbenchWebSocket
    });
    Object.defineProperty(window, '__consoleMockWorkbenchWebSocket', {
      configurable: true,
      value: MockWorkbenchWebSocket
    });
  });
}

export function json(route: Route, body: unknown, status = 200): Promise<void> {
  const pathname = new URL(route.request().url()).pathname;
  const responseBody =
    pathname === '/api/agent-sessions' || pathname.startsWith('/api/agent-sessions/')
      ? normalizeMockAgentSessionPayload(body)
      : body;
  return route.fulfill({
    contentType: 'application/json',
    status,
    body: JSON.stringify(responseBody)
  });
}

export async function emitMockSessionEvent(
  page: Page,
  category: string,
  payload: unknown
): Promise<void> {
  await page.waitForFunction(() =>
    Boolean(
      (
        window as unknown as {
          __consoleMockWorkbenchWebSocket?: { activeWatch?: unknown };
        }
      ).__consoleMockWorkbenchWebSocket?.activeWatch
    )
  );
  const emitted = await page.evaluate(
    ({ eventCategory, eventPayload }) =>
      (
        window as unknown as {
          __consoleMockWorkbenchWebSocket?: {
            emitSessionEvent(category: string, payload: unknown): boolean;
          };
        }
      ).__consoleMockWorkbenchWebSocket?.emitSessionEvent(eventCategory, eventPayload),
    { eventCategory: category, eventPayload: payload }
  );
  if (!emitted) throw new Error('Mock Session Watch is not active');
}

export async function emitMockWorkspaceSnapshot(
  page: Page,
  topic: 'sessions' | 'files' | 'changes',
  payload: unknown
): Promise<void> {
  await page.waitForFunction(() =>
    Boolean(
      (
        window as unknown as {
          __consoleMockWorkbenchWebSocket?: { activeWorkspaceWatch?: unknown };
        }
      ).__consoleMockWorkbenchWebSocket?.activeWorkspaceWatch
    )
  );
  const emitted = await page.evaluate(
    ({ eventTopic, eventPayload }) =>
      (
        window as unknown as {
          __consoleMockWorkbenchWebSocket?: {
            emitWorkspaceSnapshot(topic: string, payload: unknown): boolean;
          };
        }
      ).__consoleMockWorkbenchWebSocket?.emitWorkspaceSnapshot(eventTopic, eventPayload),
    { eventTopic: topic, eventPayload: payload }
  );
  if (!emitted) throw new Error('Mock Workspace Watch is not active');
}

export async function emitMockHostedConversationEvent(page: Page, payload: unknown): Promise<void> {
  await page.waitForFunction(() =>
    Boolean(
      (
        window as unknown as {
          __consoleMockWorkbenchWebSocket?: { activeHostedWatch?: unknown };
        }
      ).__consoleMockWorkbenchWebSocket?.activeHostedWatch
    )
  );
  const emitted = await page.evaluate(
    (eventPayload) =>
      (
        window as unknown as {
          __consoleMockWorkbenchWebSocket?: {
            emitHostedConversationEvent(payload: unknown): boolean;
          };
        }
      ).__consoleMockWorkbenchWebSocket?.emitHostedConversationEvent(eventPayload),
    payload
  );
  if (!emitted) throw new Error('Mock Hosted Conversation Watch is not active');
}

export async function fulfillMockWorkspaceWatch(
  page: Page,
  route: Route,
  session:
    | (Readonly<Record<string, unknown>> & {
        readonly id: string;
        readonly workspaceId: string;
      })
    | undefined,
  workspaceKind: 'DIRECTORY' | 'GIT_WORKSPACE',
  fileEntries?: readonly Readonly<Record<string, unknown>>[],
  changesSnapshot: unknown = { changes: [] },
  navigationSnapshot?: (query: {
    readonly sessionIds: readonly string[];
    readonly summaryAnchors: readonly string[];
    readonly treeAnchor?: string;
  }) => unknown
): Promise<void> {
  if (route.request().method() === 'DELETE') {
    await json(route, { released: true });
    return;
  }
  const request = JSON.parse(route.request().postData() ?? '{}') as {
    nodeId?: string;
    watchId?: string;
    mode?: string;
    workbenchConnectionId?: string;
    topics?: {
      readonly sessionGroup?: 'MAIN' | 'CHILD';
      readonly sessionNavigation?: {
        readonly sessionIds: readonly string[];
        readonly summaryAnchors: readonly string[];
        readonly treeAnchor?: string;
      };
    };
  };
  const nodeGeneration = 'mock-node-generation';
  const watchId = request.watchId ?? 'mock-workspace-watch';
  const workspaceId =
    session?.workspaceId ??
    decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) ?? 'workspace-1');
  await json(route, {
    accepted: true,
    watchId,
    nodeGeneration,
    expiresAt: 1_900_000_030_000
  });
  if (request.mode !== 'initial' || page.isClosed()) return;
  try {
    const snapshots =
      session === undefined
        ? await page.evaluate(
            async ({ nodeId, selectedWorkspaceId, git, sessionGroup }) => {
              const readJson = async (path: string): Promise<Record<string, unknown>> => {
                const response = await fetch(path, {
                  headers: { 'x-mar-e2e-workspace-watch-snapshot': '1' }
                });
                return response.json() as Promise<Record<string, unknown>>;
              };
              const [sessions, files, changes] = await Promise.all([
                readJson(
                  `/api/agent-sessions?nodeId=${encodeURIComponent(nodeId)}&workspaceId=${encodeURIComponent(selectedWorkspaceId)}&limit=30${sessionGroup === undefined ? '' : `&sessionGroup=${sessionGroup}`}`
                ),
                readJson(
                  `/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/files?nodeId=${encodeURIComponent(nodeId)}`
                ),
                git
                  ? readJson(
                      `/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/changes?nodeId=${encodeURIComponent(nodeId)}`
                    )
                  : Promise.resolve(undefined)
              ]);
              const sessionPage = sessions as {
                readonly sessions?: readonly Record<string, unknown>[];
              };
              return {
                sessions: Array.isArray(sessionPage.sessions)
                  ? {
                      ...sessions,
                      sessions: sessionPage.sessions.map((session) => ({
                        ...session,
                        externalSessionId:
                          typeof session.externalSessionId === 'string'
                            ? session.externalSessionId
                            : `mock-native:${String(session.id)}`
                      }))
                    }
                  : sessions,
                files,
                ...(changes === undefined ? {} : { changes })
              };
            },
            {
              nodeId: request.nodeId ?? 'node-1',
              selectedWorkspaceId: workspaceId,
              sessionGroup: request.topics?.sessionGroup,
              git: workspaceKind === 'GIT_WORKSPACE'
            }
          )
        : {
            sessions: { sessions: [withMockNativeSessionIdentity(session)], nextCursor: null },
            files: {
              files: {
                entries: fileEntries ?? [
                  {
                    path: 'src/main.ts',
                    name: 'main.ts',
                    kind: 'FILE',
                    size: 25,
                    modifiedAt: 1
                  }
                ],
                nextCursor: null,
                truncated: false
              }
            },
            ...(workspaceKind === 'GIT_WORKSPACE' ? { changes: changesSnapshot } : {})
          };
    await page.evaluate(
      ({ watch, snapshots }) => {
        const socket = (
          window as unknown as {
            __consoleMockWorkbenchWebSocket?: {
              acceptWorkspaceWatch(
                watch: Record<string, unknown>,
                snapshots: Readonly<Record<string, unknown>>
              ): void;
            };
          }
        ).__consoleMockWorkbenchWebSocket;
        setTimeout(() => socket?.acceptWorkspaceWatch(watch, snapshots), 0);
      },
      {
        watch: {
          nodeGeneration,
          nodeId: request.nodeId ?? 'node-1',
          watchId,
          workspaceId
        },
        snapshots:
          request.topics?.sessionNavigation && navigationSnapshot
            ? {
                ...snapshots,
                sessionNavigation: navigationSnapshot(request.topics.sessionNavigation)
              }
            : snapshots
      }
    );
  } catch (error) {
    if (
      page.isClosed() ||
      String(error).includes('Test ended') ||
      String(error).includes('Execution context was destroyed')
    )
      return;
    throw error;
  }
}

export async function fulfillMockSessionWatch(
  page: Page,
  route: Route,
  session: { readonly id: string; readonly workspaceId: string },
  payload: unknown
): Promise<void> {
  const request = JSON.parse(route.request().postData() ?? '{}') as {
    nodeId?: string;
    watchId?: string;
  };
  const nodeGeneration = 'mock-node-generation';
  const watchId = request.watchId ?? 'mock-session-watch';
  await json(route, {
    accepted: true,
    watchId,
    nodeGeneration,
    expiresAt: 1_900_000_030_000
  });
  if (page.isClosed()) return;
  try {
    const snapshot =
      typeof payload === 'object' &&
      payload !== null &&
      'session' in payload &&
      typeof payload.session === 'object' &&
      payload.session !== null
        ? {
            ...payload,
            session: withMockNativeSessionIdentity(payload.session as Record<string, unknown>)
          }
        : payload;
    await page.evaluate(
      ({ watch, snapshot }) => {
        const socket = (
          window as unknown as {
            __consoleMockWorkbenchWebSocket?: {
              acceptSessionWatch(watch: unknown, payload: unknown): void;
            };
          }
        ).__consoleMockWorkbenchWebSocket;
        setTimeout(() => socket?.acceptSessionWatch(watch, snapshot), 0);
      },
      {
        watch: {
          nodeGeneration,
          nodeId: request.nodeId ?? 'node-1',
          watchId,
          sessionId: session.id,
          workspaceId: session.workspaceId
        },
        snapshot
      }
    );
  } catch (error) {
    if (
      page.isClosed() ||
      String(error).includes('Test ended') ||
      String(error).includes('Execution context was destroyed')
    )
      return;
    throw error;
  }
}

export async function fulfillMockHostedConversationWatch(
  page: Page,
  route: Route,
  conversationId: string,
  payload: unknown
): Promise<void> {
  if (route.request().method() === 'DELETE') {
    await json(route, { unwatched: true });
    return;
  }
  const request = JSON.parse(route.request().postData() ?? '{}') as {
    mode?: string;
    watchId?: string;
    workbenchConnectionId?: string;
  };
  const nodeGeneration = 'mock-node-generation';
  const watchId = request.watchId ?? 'mock-hosted-conversation-watch';
  await json(route, {
    accepted: true,
    watchId,
    nodeGeneration,
    expiresAt: 1_900_000_030_000
  });
  if (request.mode !== 'initial' || page.isClosed()) return;
  try {
    await page.evaluate(
      ({ watch, snapshot }) => {
        const socket = (
          window as unknown as {
            __consoleMockWorkbenchWebSocket?: {
              acceptHostedConversationWatch(watch: Record<string, unknown>, payload: unknown): void;
            };
          }
        ).__consoleMockWorkbenchWebSocket;
        setTimeout(() => socket?.acceptHostedConversationWatch(watch, snapshot), 0);
      },
      {
        watch: {
          nodeGeneration,
          nodeId: 'node-1',
          watchId,
          conversationId
        },
        snapshot: payload
      }
    );
  } catch (error) {
    if (
      page.isClosed() ||
      String(error).includes('Test ended') ||
      String(error).includes('Execution context was destroyed')
    )
      return;
    throw error;
  }
}

export function write(
  route: Route,
  writes: { readonly url: string; readonly csrf: string | undefined; readonly body: string }[],
  body: unknown
): Promise<void> {
  writes.push({
    url: route.request().url(),
    csrf: route.request().headers()['x-csrf-token'],
    body: route.request().postData() ?? ''
  });
  return json(route, body);
}
