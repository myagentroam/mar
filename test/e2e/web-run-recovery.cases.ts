import { expect, test } from '@playwright/test';
import { serializeComposerTag } from '../../packages/protocol/src/composer-tags.js';
import {
  emitMockSessionEvent,
  fulfillMockSessionWatch,
  mockConsoleApi,
  json,
  write
} from './support/web-console-api.js';

// Native identity for new sessions, late snapshots, and connection recovery

for (const locale of ['zh-CN', 'en-US'] as const) {
  test(`System restart continuation is distinct from user input in history and paused queue ${locale}`, async ({
    page
  }) => {
    await page.addInitScript((language) => localStorage.setItem('mar.locale.v2', language), locale);
    const writes: { url: string; csrf: string | undefined; body: string }[] = [];
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
    const session = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'mar-agent',
      externalSessionId: 'native-restart-session',
      activity: 'IDLE',
      nativeControl: 'MAR_MANAGED',
      control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
    };
    const content = serializeComposerTag('mar_restart', {});
    const queue = {
      version: 3,
      paused: true,
      items: [
        {
          queueItemId: 'restored-input',
          sessionId: session.id,
          content,
          clientMessageId: 'restart-input',
          initiatedByUserId: 7,
          createdAt: 1
        }
      ]
    };
    let legacyTurnReads = 0;
    await page.route(/\/api\/agent-sessions\/session-1\/turns\?/, (route) => {
      legacyTurnReads++;
      return json(route, { turns: [], nextCursor: null });
    });
    await page.route('**/api/agent-sessions/session-1/watch', (route) =>
      fulfillMockSessionWatch(page, route, session, {
        kind: 'session-watch-snapshot',
        sequence: 10,
        session,
        runs: [],
        queue,
        context: null,
        conversation: {
          unit: 'SEGMENT',
          source: 'official',
          readAt: 10,
          latestVisibleAt: 10,
          snapshotSequence: 10,
          nextCursor: null,
          segments: [
            {
              id: 'restart-turn:segment:0',
              turnId: 'restart-turn',
              sessionId: session.id,
              runId: null,
              index: 0,
              status: 'SUCCEEDED',
              startedAt: 9,
              completedAt: 10,
              items: [
                {
                  id: 'restart-input',
                  kind: 'user_message',
                  status: 'COMPLETED',
                  payload: { text: content }
                }
              ]
            }
          ]
        }
      })
    );
    await page.goto('/console');
    const english = locale === 'en-US';
    await page.getByRole('button', { name: english ? 'Open console' : '进入控制台' }).click();
    await page.getByRole('button', { name: english ? 'Work' : '工作', exact: true }).click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: /node-1/ })
      .click();
    await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
    await page.locator('.session-list button').first().click();
    const label = english ? 'System restart continuation' : '系统重启续作';
    await expect(
      page.locator('.conversation-timeline').getByText(label, { exact: true })
    ).toBeVisible();
    await expect(page.locator('.composer-queue').getByText(label, { exact: true })).toBeVisible();
    await expect(page.locator('.composer-queue-paused')).toBeVisible();
    await expect(page.locator('.queue-item-content')).toContainText(
      english
        ? 'Continuing unfinished work after a system restart.'
        : '因系统重启，检查现场并继续未完成工作。'
    );
    expect(legacyTurnReads).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.composer-queue').getByText(label, { exact: true })).toBeVisible();
    expect(
      await page
        .locator('.composer-queue')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
    ).toBe(true);
  });
}

test('Observable history opens through the watch snapshot without parallel turn reads', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  let turnReads = 0;
  await page.route('**/api/agent-sessions/session-1/turns?nodeId=node-1&limit=10', (route) => {
    turnReads += 1;
    return json(route, { turns: [], nextCursor: null });
  });
  const session = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    runner: 'codex',
    externalSessionId: 'vscode-thread-1',
    activity: 'IDLE',
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
  };
  await page.route('**/api/agent-sessions/session-1/watch', (route) =>
    fulfillMockSessionWatch(page, route, session, {
      kind: 'session-watch-snapshot',
      sequence: 10,
      session,
      runs: [],
      queue: { version: 0, paused: false, items: [] },
      context: null,
      conversation: {
        unit: 'SEGMENT',
        source: 'official',
        readAt: Date.now(),
        latestVisibleAt: 10,
        snapshotSequence: 10,
        segments: [
          {
            id: 'watch-turn:segment:0',
            turnId: 'watch-turn',
            sessionId: 'session-1',
            runId: null,
            index: 0,
            status: 'SUCCEEDED',
            startedAt: 10,
            completedAt: 10,
            items: [
              {
                id: 'watch-item',
                kind: 'assistant_message',
                status: 'COMPLETED',
                payload: { text: 'watch 同步历史' }
              }
            ]
          }
        ],
        nextCursor: null
      }
    })
  );
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list button').first().click();
  await expect(page.getByText('watch 同步历史', { exact: true })).toBeVisible();
  expect(turnReads).toBe(0);
});

test('First messages immediately mark new sessions as managed runs and merge realtime conversation items', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await page.addInitScript(() => {
    class MockWorkbenchWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: MockWorkbenchWebSocket[] = [];
      static emitFirstTurn(watchId: string) {
        const socket = MockWorkbenchWebSocket.instances.find((item) =>
          item.url.includes('/api/workbench/live')
        );
        if (socket === undefined) return;
        const emit = (sequence: number, category: string, payload: unknown) =>
          socket.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'watch.event',
                event: {
                  type: 'watch.session.event',
                  workbenchConnectionId: 'mock-workbench-connection',
                  nodeGeneration: 'mock-node-generation',
                  nodeId: 'node-1',
                  workspaceId: 'workspace-1',
                  sessionId: 'session-created',
                  watchId,
                  event: { sequence, category, payload }
                }
              })
            })
          );
        // Reconnect/replay can deliver a conversation event before the Run snapshot. Web must
        // buffer it until the authoritative Run arrives.
        emit(2, 'conversation', {
          sessionId: 'session-created',
          runId: 'run-created',
          item: {
            itemId: 'run-created:assistant-live',
            turnId: 'turn-created',
            segmentId: 'turn-created:segment:0',
            segmentIndex: 0,
            kind: 'assistant_message',
            status: 'IN_PROGRESS',
            payload: {
              text: '首条回复已实时显示',
              format: 'markdown',
              model: null
            }
          }
        });
        emit(3, 'run', {
          run: {
            id: 'run-created',
            sessionId: 'session-created',
            workspaceId: 'workspace-1',
            status: 'RUNNING',
            recoveryState: 'ACTIVE',
            clientMessageId: 'first-message'
          }
        });
      }
      readonly url: string;
      readyState = MockWorkbenchWebSocket.OPEN;
      constructor(url: string) {
        super();
        this.url = url;
        MockWorkbenchWebSocket.instances.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
      }
      send(data: string) {
        let message: { readonly type?: unknown };
        try {
          message = JSON.parse(data) as { readonly type?: unknown };
        } catch {
          return;
        }
        if (message.type !== 'resume') return;
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
    Object.defineProperty(window, '__newSessionWebSockets', {
      configurable: true,
      value: MockWorkbenchWebSocket
    });
  });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  const created = {
    id: 'session-created',
    workspaceId: 'workspace-1',
    runner: 'codex' as const,
    externalSessionId: 'session-created',
    runnerTitle: '首条消息',
    activity: 'MANAGED_ACTIVE' as const,
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
  };
  let createdWatchId: string | undefined;
  await page.route('**/api/agent-sessions/start', (route) =>
    write(route, writes, {
      session: created,
      run: {
        id: 'run-created',
        sessionId: 'session-created',
        workspaceId: 'workspace-1',
        status: 'STARTING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'first-message'
      },
      turn: {
        id: 'turn-created',
        sessionId: 'session-created',
        runId: 'run-created',
        status: 'PREPARING',
        items: [
          {
            id: 'user-created',
            kind: 'user_message',
            status: 'COMPLETED',
            payload: {
              clientMessageId: 'first-message',
              text: '请开始',
              contexts: [],
              delivery: 'ACCEPTED'
            }
          }
        ]
      },
      delivery: 'STARTED'
    })
  );
  await page.route('**/api/agent-sessions/session-created/watch*', (route) => {
    if (route.request().method() === 'DELETE') return json(route, { unwatched: true });
    const request = route.request().postDataJSON() as { readonly watchId?: string };
    createdWatchId = request.watchId;
    return fulfillMockSessionWatch(page, route, created, {
      kind: 'session-watch-snapshot',
      sequence: 1,
      session: created,
      runs: [
        {
          id: 'run-created',
          sessionId: 'session-created',
          workspaceId: 'workspace-1',
          status: 'STARTING',
          recoveryState: 'ACTIVE',
          clientMessageId: 'first-message'
        }
      ],
      queue: { version: 0, paused: false, items: [] },
      context: null,
      conversation: {
        unit: 'SEGMENT',
        source: 'runtime',
        readAt: 1,
        latestVisibleAt: 1,
        snapshotSequence: 1,
        segments: [
          {
            id: 'turn-created:segment:0',
            turnId: 'turn-created',
            sessionId: 'session-created',
            runId: 'run-created',
            index: 0,
            status: 'PREPARING',
            items: [
              {
                id: 'user-created',
                kind: 'user_message',
                status: 'COMPLETED',
                payload: {
                  clientMessageId: 'first-message',
                  text: '请开始',
                  contexts: [],
                  delivery: 'ACCEPTED'
                }
              }
            ],
            startedAt: 1,
            completedAt: null
          }
        ],
        nextCursor: null
      }
    });
  });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  const input = page.getByRole('textbox', { name: '输入消息' });
  await input.fill('请开始');
  await input.press('Control+Enter');
  await expect(page.locator('.session-list .mar-session-activity.managed_active')).toHaveCount(1);
  await expect(page.locator('.conversation-item.user_message')).toContainText('请开始');
  await expect.poll(() => createdWatchId).toBeTruthy();
  await page.evaluate(
    (watchId) =>
      (
        window as unknown as { __newSessionWebSockets: { emitFirstTurn(watchId: string): void } }
      ).__newSessionWebSockets.emitFirstTurn(watchId),
    createdWatchId!
  );
  await expect(page.getByText('首条回复已实时显示', { exact: true })).toBeVisible();
});

test('Input-required events arriving before message responses replay immediately after Run binding', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await page.addInitScript(() => {
    class MockWorkbenchWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: MockWorkbenchWebSocket[] = [];
      static emitUserInput() {
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
                category: 'conversation',
                payload: {
                  sessionId: 'session-input-race',
                  runId: 'run-input-race',
                  item: {
                    itemId: 'run-input-race:user-input',
                    kind: 'user_input_request',
                    status: 'PENDING',
                    payload: {
                      requestId: 'request-input-race',
                      questions: [
                        {
                          id: 'scope',
                          prompt: '无需下一条消息即可显示的问题',
                          input: 'SINGLE_SELECT',
                          options: [{ value: 'continue', label: '继续', description: null }],
                          allowOther: false
                        }
                      ]
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
      send(data: string) {
        let message: { readonly type?: unknown };
        try {
          message = JSON.parse(data) as { readonly type?: unknown };
        } catch {
          return;
        }
        if (message.type !== 'resume') return;
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
    Object.defineProperty(window, '__inputRaceWebSockets', {
      configurable: true,
      value: MockWorkbenchWebSocket
    });
  });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  let releaseMessage: (() => void) | undefined;
  const messageReady = new Promise<void>((resolve) => {
    releaseMessage = resolve;
  });
  let messageReceived: (() => void) | undefined;
  const messageStarted = new Promise<void>((resolve) => {
    messageReceived = resolve;
  });
  let inputRaceClientMessageId = 'input-race-message';
  const inputRaceSession = {
    id: 'session-input-race',
    workspaceId: 'workspace-1',
    runner: 'codex' as const,
    externalSessionId: 'session-input-race',
    runnerTitle: '待输入竞态',
    activity: 'MANAGED_ACTIVE' as const,
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
  };
  await page.route('**/api/agent-sessions/start', async (route) => {
    const body = route.request().postDataJSON() as { clientMessageId: string };
    inputRaceClientMessageId = body.clientMessageId;
    messageReceived?.();
    await messageReady;
    await write(route, writes, {
      session: inputRaceSession,
      run: {
        id: 'run-input-race',
        sessionId: 'session-input-race',
        status: 'RUNNING',
        recoveryState: 'ACTIVE',
        clientMessageId: body.clientMessageId
      },
      turn: {
        id: 'turn-input-race',
        sessionId: 'session-input-race',
        runId: 'run-input-race',
        status: 'WAITING_INPUT',
        items: [
          {
            id: 'input-race',
            kind: 'user_input_request',
            status: 'PENDING',
            payload: {
              requestId: 'request-input-race',
              questions: [
                {
                  id: 'scope',
                  prompt: '无需下一条消息即可显示的问题',
                  input: 'SINGLE_SELECT',
                  options: [{ value: 'continue', label: '继续', description: null }],
                  allowOther: false
                }
              ]
            }
          }
        ]
      },
      delivery: 'STARTED'
    });
  });
  await page.route('**/api/agent-sessions/session-input-race/watch*', (route) =>
    fulfillMockSessionWatch(page, route, inputRaceSession, {
      kind: 'session-watch-snapshot',
      sequence: 1,
      session: inputRaceSession,
      runs: [
        {
          id: 'run-input-race',
          sessionId: 'session-input-race',
          workspaceId: 'workspace-1',
          status: 'RUNNING',
          recoveryState: 'ACTIVE',
          clientMessageId: inputRaceClientMessageId
        }
      ],
      queue: { version: 0, paused: false, items: [] },
      context: null,
      conversation: {
        unit: 'SEGMENT',
        source: 'runtime',
        readAt: 1,
        latestVisibleAt: 1,
        snapshotSequence: 1,
        segments: [
          {
            id: 'turn-input-race:segment:0',
            turnId: 'turn-input-race',
            sessionId: 'session-input-race',
            runId: 'run-input-race',
            index: 0,
            status: 'WAITING_INPUT',
            items: [
              {
                id: 'input-race',
                kind: 'user_input_request',
                status: 'PENDING',
                payload: {
                  requestId: 'request-input-race',
                  questions: [
                    {
                      id: 'scope',
                      prompt: '无需下一条消息即可显示的问题',
                      input: 'SINGLE_SELECT',
                      options: [{ value: 'continue', label: '继续', description: null }],
                      allowOther: false
                    }
                  ]
                }
              }
            ],
            startedAt: 1,
            completedAt: null
          }
        ],
        nextCursor: null
      }
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  const input = page.getByRole('textbox', { name: '输入消息' });
  await input.fill('触发待输入');
  await input.press('Control+Enter');
  await messageStarted;
  await page.evaluate(() =>
    (
      window as unknown as { __inputRaceWebSockets: { emitUserInput(): void } }
    ).__inputRaceWebSockets.emitUserInput()
  );
  await expect(page.getByText('无需下一条消息即可显示的问题', { exact: true })).toHaveCount(0);
  releaseMessage?.();
  await expect(page.getByText('无需下一条消息即可显示的问题', { exact: true })).toBeVisible();
  await expect(page.locator('.user-input-card')).toHaveCount(1);
});

test('Older session snapshots cannot overwrite newly pushed messages', async ({ page }) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route('**/api/agent-sessions/session-1/messages', (route) =>
    write(route, writes, {
      session: {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'vscode-thread-1',
        activity: 'MANAGED_ACTIVE',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
      },
      run: {
        id: 'run-late-turns',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        status: 'STARTING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'late-1'
      },
      turn: {
        id: 'turn-late',
        sessionId: 'session-1',
        runId: 'run-late-turns',
        status: 'PREPARING',
        items: [
          {
            id: 'user-late',
            kind: 'user_message',
            status: 'COMPLETED',
            payload: {
              clientMessageId: 'late-1',
              text: '初读不覆盖',
              contexts: [],
              delivery: 'ACCEPTED'
            }
          }
        ]
      },
      delivery: 'STARTED'
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list button').first().click();

  const input = page.getByRole('textbox', { name: '输入消息' });
  await input.fill('初读不覆盖');
  const response = page.waitForResponse((candidate) => candidate.url().includes('/messages'));
  await input.press('Enter');
  await response;
  const turn = {
    id: 'turn-late',
    sessionId: 'session-1',
    runId: 'run-late-turns',
    status: 'PREPARING',
    items: [
      {
        id: 'user-late',
        kind: 'user_message',
        status: 'COMPLETED',
        payload: {
          clientMessageId: 'late-1',
          text: '初读不覆盖',
          contexts: [],
          delivery: 'ACCEPTED'
        }
      }
    ]
  };
  await emitMockSessionEvent(page, 'conversation', {
    sessionId: 'session-1',
    turn,
    segments: [{ ...turn, id: 'turn-late:segment:0', turnId: turn.id, index: 0 }]
  });
  await expect(
    page.locator('.conversation-message').filter({ hasText: '初读不覆盖' })
  ).toBeVisible();
  await page.evaluate(() => {
    const socket = (
      window as unknown as {
        __consoleMockWorkbenchWebSocket: {
          activeWatch: Record<string, unknown>;
          acceptSessionWatch(watch: Record<string, unknown>, payload: unknown): void;
        };
      }
    ).__consoleMockWorkbenchWebSocket;
    socket.acceptSessionWatch(socket.activeWatch, {
      kind: 'session-watch-snapshot',
      sequence: 1,
      session: {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'vscode-thread-1',
        activity: 'IDLE',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
      },
      runs: [],
      queue: { version: 0, paused: false, items: [] },
      context: null,
      conversation: {
        unit: 'SEGMENT',
        source: 'official',
        readAt: 1,
        latestVisibleAt: 1,
        snapshotSequence: 1,
        segments: [],
        nextCursor: null
      }
    });
  });
  await expect(
    page.locator('.conversation-message').filter({ hasText: '初读不覆盖' })
  ).toBeVisible();
});

test('Realtime reconnection backfills the final result of the active session', async ({ page }) => {
  await page.addInitScript(() => {
    class MockWorkbenchWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: MockWorkbenchWebSocket[] = [];
      static watchId = '';
      static emitWatchEvent(category: string, sequence: number, payload: unknown): boolean {
        const socket = MockWorkbenchWebSocket.instances
          .filter((item) => item.url.includes('/api/workbench/live'))
          .at(-1);
        if (socket === undefined || MockWorkbenchWebSocket.watchId === '') return false;
        socket.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'watch.event',
              event: {
                type: 'watch.session.event',
                workbenchConnectionId: 'mock-workbench-connection',
                nodeGeneration: 'mock-node-generation',
                nodeId: 'node-1',
                workspaceId: 'workspace-1',
                sessionId: 'session-1',
                watchId: MockWorkbenchWebSocket.watchId,
                event: { sequence, category, payload }
              }
            })
          })
        );
        return true;
      }
      static disconnect() {
        const socket = MockWorkbenchWebSocket.instances
          .filter((item) => item.url.includes('/api/workbench/live'))
          .at(-1);
        if (socket === undefined) return;
        socket.readyState = MockWorkbenchWebSocket.CLOSED;
        socket.dispatchEvent(new CloseEvent('close', { code: 1006, reason: 'NETWORK_LOST' }));
      }
      static emitRun(status: 'RUNNING' | 'SUCCEEDED', sequence: number) {
        return MockWorkbenchWebSocket.emitWatchEvent('run', sequence, {
          run: {
            id: 'run-1',
            sessionId: 'session-1',
            workspaceId: 'workspace-1',
            status,
            recoveryState: 'ACTIVE',
            version: sequence + 1
          }
        });
      }
      static emitTextDelta(sequence: number, text: string) {
        return MockWorkbenchWebSocket.emitWatchEvent('conversation', sequence, {
          sessionId: 'session-1',
          delta: {
            runId: 'run-1',
            itemId: 'run-1:assistant-live',
            text,
            createdAt: sequence
          }
        });
      }
      static emitSessionIdle(sequence: number) {
        return MockWorkbenchWebSocket.emitWatchEvent('session', sequence, {
          session: {
            id: 'session-1',
            workspaceId: 'workspace-1',
            runner: 'codex',
            externalSessionId: 'vscode-thread-1',
            activity: 'IDLE',
            control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
          }
        });
      }
      static emitFinalTurn(sequence: number, text: string) {
        return MockWorkbenchWebSocket.emitWatchEvent('conversation', sequence, {
          sessionId: 'session-1',
          runId: 'run-1',
          item: {
            itemId: 'run-1:assistant-live',
            turnId: 'turn-1',
            segmentId: 'turn-1:segment:0',
            segmentIndex: 0,
            kind: 'assistant_message',
            status: 'COMPLETED',
            payload: { text }
          }
        });
      }
      static emitSessionSnapshot(input: {
        watchId: string;
        session: unknown;
        runs: unknown[];
        conversation: unknown;
        sequence: number;
      }) {
        const socket = MockWorkbenchWebSocket.instances
          .filter((item) => item.url.includes('/api/workbench/live'))
          .at(-1);
        if (socket === undefined) return false;
        socket.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'watch.event',
              event: {
                type: 'watch.session.snapshot',
                workbenchConnectionId: 'mock-workbench-connection',
                watchId: input.watchId,
                nodeGeneration: 'mock-node-generation',
                nodeId: 'node-1',
                workspaceId: 'workspace-1',
                sessionId: 'session-1',
                revision: 1,
                snapshotSequence: input.sequence,
                expiresAt: Date.now() + 30_000,
                payload: {
                  kind: 'session-watch-snapshot',
                  sequence: input.sequence,
                  session: input.session,
                  runs: input.runs,
                  queue: { version: 0, paused: false, items: [] },
                  context: null,
                  conversation: input.conversation
                }
              }
            })
          })
        );
        return true;
      }
      readonly url: string;
      readyState = MockWorkbenchWebSocket.OPEN;
      constructor(url: string) {
        super();
        this.url = url;
        MockWorkbenchWebSocket.instances.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
      }
      send(data: string) {
        let message: { readonly type?: unknown };
        try {
          message = JSON.parse(data) as { readonly type?: unknown };
        } catch {
          return;
        }
        if (message.type !== 'resume') return;
        const resumed =
          MockWorkbenchWebSocket.instances.filter((item) =>
            item.url.includes('/api/workbench/live')
          ).length > 1;
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
    Object.defineProperty(window, '__reconnectWorkbenchSocket', {
      configurable: true,
      value: MockWorkbenchWebSocket
    });
  });
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'events.live', 'turn.start', 'turn.steer', 'turn.interrupt'],
    writes
  );
  let snapshotReads = 0;
  let finalReply = '尚未完成';
  let snapshotSequence = 0;
  await page.route(/\/api\/agent-sessions\/[^/?]+\/runs\?nodeId=node-1$/, (route) => {
    return json(route, {
      runs: [
        {
          id: 'run-1',
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          status: snapshotReads <= 1 ? 'RUNNING' : 'SUCCEEDED',
          recoveryState: 'ACTIVE',
          version: snapshotReads
        }
      ]
    });
  });
  await page.route(/\/api\/agent-sessions\/[^/?]+\?nodeId=node-1$/, (route) =>
    json(route, {
      session: {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'vscode-thread-1',
        activity: snapshotReads <= 1 ? 'MANAGED_ACTIVE' : 'IDLE',
        control:
          snapshotReads <= 1
            ? {
                level: 'MANAGED',
                capabilities: ['history.read', 'events.live', 'turn.start']
              }
            : { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
      }
    })
  );
  await page.route(/\/api\/agent-sessions\/[^/?]+\/watch$/, async (route) => {
    const body = route.request().postDataJSON() as { watchId?: unknown };
    const watchId = typeof body.watchId === 'string' ? body.watchId : '';
    snapshotReads += 1;
    const active = snapshotReads === 1;
    const session = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex',
      externalSessionId: 'vscode-thread-1',
      activity: active ? 'MANAGED_ACTIVE' : 'IDLE',
      control: active
        ? { level: 'MANAGED', capabilities: ['history.read', 'events.live', 'turn.start'] }
        : { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
    };
    const conversation = {
      unit: 'SEGMENT',
      segments: [
        {
          id: 'turn-1:segment:0',
          turnId: 'turn-1',
          sessionId: 'session-1',
          runId: 'run-1',
          index: 0,
          status: active ? 'RUNNING' : 'SUCCEEDED',
          items: [
            {
              id: 'reply-1',
              kind: 'assistant_message',
              status: 'COMPLETED',
              payload: { text: finalReply }
            }
          ]
        }
      ],
      nextCursor: null,
      snapshotSequence
    };
    await json(route, { nodeGeneration: 'mock-node-generation' });
    await page.evaluate((currentWatchId) => {
      (
        window as unknown as {
          __reconnectWorkbenchSocket: { watchId: string };
        }
      ).__reconnectWorkbenchSocket.watchId = currentWatchId;
    }, watchId);
    await page.evaluate(
      ({
        watchId: currentWatchId,
        session: currentSession,
        conversation: currentConversation,
        active: currentActive,
        sequence
      }) =>
        window.setTimeout(() => {
          (
            window as unknown as {
              __reconnectWorkbenchSocket: {
                emitSessionSnapshot(input: Record<string, unknown>): boolean;
              };
            }
          ).__reconnectWorkbenchSocket.emitSessionSnapshot({
            watchId: currentWatchId,
            session: currentSession,
            runs: [
              {
                id: 'run-1',
                sessionId: 'session-1',
                workspaceId: 'workspace-1',
                status: currentActive ? 'RUNNING' : 'SUCCEEDED',
                recoveryState: 'ACTIVE',
                version: sequence
              }
            ],
            conversation: currentConversation,
            sequence
          });
        }, 100),
      {
        watchId,
        session,
        conversation,
        active,
        sequence: Math.max(snapshotReads, snapshotSequence, 1)
      }
    );
  });
  await page.route(/\/api\/agent-sessions\/[^/?]+\/turns\?.*nodeId=node-1.*$/, (route) => {
    return json(route, {
      turns: [
        {
          id: 'turn-1',
          sessionId: 'session-1',
          runId: 'run-1',
          status: snapshotReads === 1 ? 'RUNNING' : 'SUCCEEDED',
          items: [
            {
              id: 'reply-1',
              kind: 'assistant_message',
              status: 'COMPLETED',
              payload: { text: finalReply }
            }
          ]
        }
      ],
      nextCursor: null,
      snapshotSequence
    });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list button').first().click();
  await expect(page.locator('.composer-working')).toBeVisible();
  await expect(page.getByText('尚未完成', { exact: true })).toBeVisible();

  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            __reconnectWorkbenchSocket: {
              emitRun(status: 'RUNNING' | 'SUCCEEDED', sequence: number): boolean;
            };
          }
        ).__reconnectWorkbenchSocket.emitRun('RUNNING', 1)
      )
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            __reconnectWorkbenchSocket: {
              emitTextDelta(sequence: number, text: string): boolean;
            };
          }
        ).__reconnectWorkbenchSocket.emitTextDelta(2, '流式末尾无需等待快照')
      )
    )
    .toBe(true);
  await expect(page.getByText('流式末尾无需等待快照', { exact: true })).toBeVisible();
  await page.waitForTimeout(100);
  expect(snapshotReads).toBe(1);

  finalReply = '正常结束后的最终回复';
  snapshotSequence = 3;
  await page.evaluate(() =>
    (
      window as unknown as {
        __reconnectWorkbenchSocket: {
          emitRun(status: 'RUNNING' | 'SUCCEEDED', sequence: number): void;
        };
      }
    ).__reconnectWorkbenchSocket.emitRun('SUCCEEDED', 3)
  );
  await page.evaluate(() =>
    (
      window as unknown as {
        __reconnectWorkbenchSocket: { emitSessionIdle(sequence: number): void };
      }
    ).__reconnectWorkbenchSocket.emitSessionIdle(4)
  );
  await expect(page.locator('.composer-working')).toHaveCount(0);
  expect(snapshotReads).toBe(1);

  await page.evaluate(() =>
    (
      window as unknown as {
        __reconnectWorkbenchSocket: { emitFinalTurn(sequence: number, text: string): void };
      }
    ).__reconnectWorkbenchSocket.emitFinalTurn(5, '正常结束后的最终回复')
  );
  await expect(page.getByText('正常结束后的最终回复', { exact: true })).toBeVisible();

  finalReply = '断线期间完成的最终回复';
  snapshotSequence = 10;
  await page.evaluate(() =>
    (
      window as unknown as { __reconnectWorkbenchSocket: { disconnect(): void } }
    ).__reconnectWorkbenchSocket.disconnect()
  );

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __reconnectWorkbenchSocket: { instances: readonly unknown[] } }
          ).__reconnectWorkbenchSocket.instances.filter(
            (socket) =>
              typeof socket === 'object' &&
              socket !== null &&
              'url' in socket &&
              typeof (socket as { url?: unknown }).url === 'string' &&
              (socket as { url: string }).url.includes('/api/workbench/live')
          ).length
      )
    )
    .toBeGreaterThanOrEqual(2);
  await expect.poll(() => snapshotReads).toBeGreaterThanOrEqual(2);
  await expect(page.getByText('断线期间完成的最终回复', { exact: true })).toBeVisible();
  await expect(page.locator('.composer-working')).toHaveCount(0);
});
