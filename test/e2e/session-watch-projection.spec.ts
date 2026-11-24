import { expect, test } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';
import type { ConversationSegmentPage } from '../../packages/web-core/src/model/workbench.js';

test('Session projection stays Watch-only across target switches, Node restart and page reconnects', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'turn.start'],
    [],
    'DIRECTORY',
    true,
    'IDLE',
    [],
    '0.11.69'
  );
  await page.route('**/api/nodes/node-1/workbench-capabilities', (route) =>
    json(route, {
      manifest: {
        manifestVersion: 1,
        observedAt: 1,
        conversation: { available: true, reasonCode: null },
        sessionAside: { apiVersion: 1 }
      }
    })
  );
  const sessions = ['session-1', 'session-2'].map((id) => ({
    id,
    workspaceId: 'workspace-1',
    runner: 'codex',
    externalSessionId: `native-${id}`,
    runnerTitle: `Title ${id}`,
    nativeControl: 'EXTERNAL',
    activity: 'IDLE',
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
  }));
  await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, (route) =>
    json(route, { sessions, nextCursor: null })
  );
  await page.route(/\/api\/agent-sessions\/session-[12]\?nodeId=node-1$/, (route) =>
    json(route, {
      session: sessions.find((session) => route.request().url().includes(`/${session.id}?`))
    })
  );
  const watches: Record<string, unknown>[] = [];
  const asideWatches: Record<string, unknown>[] = [];
  let nodeGeneration = 'mock-node-generation';
  let rejectNextMainInitial = false;
  await page.route(/\/api\/agent-sessions\/session-[12]\/watch(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'DELETE') return json(route, { released: true });
    const request = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    if (request.mode === 'initial') {
      if (request.position !== 'secondary' && rejectNextMainInitial) {
        rejectNextMainInitial = false;
        return json(route, { error: 'NODE_OFFLINE' }, 503);
      }
      const targetWatches = request.position === 'secondary' ? asideWatches : watches;
      targetWatches.push({
        ...request,
        sessionId: new URL(route.request().url()).pathname.split('/').at(-2),
        nodeGeneration
      });
    }
    await json(route, {
      accepted: true,
      watchId: request.watchId,
      nodeGeneration,
      expiresAt: Date.now() + 30_000
    });
  });
  const emit = async (message: unknown) => {
    await page.evaluate((frame) => {
      const sockets = (
        window as unknown as {
          __consoleMockWorkbenchWebSocket: {
            instances: (WebSocket & { url: string })[];
          };
        }
      ).__consoleMockWorkbenchWebSocket.instances;
      sockets
        .find((socket) => socket.url.includes('/api/workbench/live') && socket.readyState === 1)
        ?.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
    }, message);
  };
  const snapshot = async (
    identity: Record<string, unknown>,
    text: string,
    { sequence = 10, running = false } = {}
  ) => {
    const id = String(identity.sessionId);
    const run = {
      id: `run-${id}`,
      sessionId: id,
      workspaceId: 'workspace-1',
      status: 'RUNNING',
      recoveryState: 'ACTIVE',
      startedAt: 2,
      createdAt: 2
    };
    await emit({
      type: 'watch.event',
      event: {
        ...identity,
        type: 'watch.session.snapshot',
        payload: {
          kind: 'session-watch-snapshot',
          sequence,
          session: {
            ...sessions.find((session) => session.id === id),
            activity: running ? 'RUNNING' : 'IDLE'
          },
          runs: running ? [run] : [],
          context: null,
          queue: { version: 1, items: [], paused: false },
          conversation: {
            unit: 'SEGMENT',
            snapshotSequence: sequence,
            nextCursor: null,
            segments: [
              {
                id: `segment-${id}`,
                sessionId: id,
                turnId: `turn-${id}`,
                runId: null,
                index: 0,
                status: 'SUCCEEDED',
                startedAt: 1,
                completedAt: 2,
                items: [
                  {
                    id: `item-${id}`,
                    parentItemId: null,
                    kind: 'assistant_message',
                    status: 'COMPLETED',
                    startedAt: 1,
                    completedAt: 2,
                    payload: { text, format: 'markdown', model: null }
                  }
                ]
              }
            ]
          } satisfies ConversationSegmentPage
        }
      }
    });
  };
  let sequence = 0;
  const poison = async (id: string) => {
    for (const [category, payload] of [
      [
        'session',
        {
          session: {
            ...sessions.find((session) => session.id === id),
            runnerTitle: 'BROADCAST_POISON',
            activity: 'RUNNING'
          }
        }
      ],
      ['session', { sessionId: id, context: { used: 999999 } }],
      ['run', { run: { id: 'broadcast-run', sessionId: id, status: 'RUNNING' } }],
      ['queue', { sessionId: id, queue: { version: 999, items: [], paused: true } }],
      [
        'conversation',
        {
          sessionId: id,
          delta: {
            runId: 'broadcast-run',
            itemId: `item-${id}`,
            text: 'BROADCAST_POISON',
            createdAt: 3
          }
        }
      ]
    ])
      await emit({
        type: 'event',
        event: { nodeId: 'node-1', sequence: ++sequence, category, payload }
      });
  };
  const settle = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: 'project', exact: true })
    .click();
  await page.getByText('Title session-1', { exact: true }).first().click();
  await expect.poll(() => watches.length).toBe(1);
  await poison('session-1');
  await settle();
  await expect(page.getByText('BROADCAST_POISON', { exact: false })).toHaveCount(0);
  await snapshot(watches[0]!, 'FIRST_WATCH_INITIAL');
  await expect(page.getByText('FIRST_WATCH_INITIAL', { exact: true })).toBeVisible();
  await poison('session-1');
  await settle();
  await expect(page.getByText('FIRST_WATCH_INITIAL', { exact: true })).toBeVisible();
  await expect(page.getByText('BROADCAST_POISON', { exact: false })).toHaveCount(0);

  await page.getByText('Title session-2', { exact: true }).first().click();
  await expect.poll(() => watches.length).toBe(2);
  await snapshot(watches[0]!, 'OLD_TARGET_POISON');
  await poison('session-2');
  await snapshot(watches[1]!, 'SECOND_WATCH_INITIAL', { running: true });
  await expect(page.getByText('SECOND_WATCH_INITIAL', { exact: true })).toBeVisible();
  await expect(page.locator('.composer-working')).toBeVisible();
  await expect(page.getByText('OLD_TARGET_POISON', { exact: false })).toHaveCount(0);
  await expect(page.getByText('BROADCAST_POISON', { exact: false })).toHaveCount(0);

  const firstRow = page.locator('.session-row').filter({ hasText: 'Title session-1' }).first();
  await firstRow.hover();
  await firstRow.locator('.session-more-button').click();
  await page.getByRole('menuitem', { name: '在侧栏打开', exact: true }).click();
  await expect.poll(() => asideWatches.length).toBe(1);
  await snapshot(asideWatches[0]!, 'ASIDE_WATCH_INITIAL');
  const aside = page.locator('.workbench-aside');
  await expect(aside.getByText('ASIDE_WATCH_INITIAL', { exact: true })).toBeVisible();

  // The Node restarts independently of the page's WebSocket to the Server.
  await emit({ type: 'node', nodeId: 'node-1', connected: false });
  nodeGeneration = 'restarted-node-generation';
  rejectNextMainInitial = true;
  await emit({ type: 'node', nodeId: 'node-1', connected: true });
  await expect.poll(() => watches.length).toBe(3);
  await expect.poll(() => asideWatches.length).toBe(2);
  expect(watches[2]!.workbenchConnectionId).toBe(watches[1]!.workbenchConnectionId);
  expect(watches[2]!.watchId).not.toBe(watches[1]!.watchId);
  expect(asideWatches[1]!.workbenchConnectionId).toBe(asideWatches[0]!.workbenchConnectionId);
  expect(asideWatches[1]!.watchId).not.toBe(asideWatches[0]!.watchId);
  await expect(page.getByText('SECOND_WATCH_INITIAL', { exact: true })).toBeVisible();
  await snapshot(watches[1]!, 'OLD_NODE_POISON', { sequence: 100, running: true });
  await snapshot(asideWatches[0]!, 'OLD_ASIDE_POISON', { sequence: 100 });
  await snapshot(watches[2]!, 'RESTARTED_NODE_INITIAL', { sequence: 1 });
  await snapshot(asideWatches[1]!, 'RESTARTED_ASIDE_INITIAL', { sequence: 1 });
  await expect(page.getByText('RESTARTED_NODE_INITIAL', { exact: true })).toBeVisible();
  await expect(aside.getByText('RESTARTED_ASIDE_INITIAL', { exact: true })).toBeVisible();
  await expect(page.locator('.composer-working')).toHaveCount(0);
  await expect(page.getByText('OLD_NODE_POISON', { exact: false })).toHaveCount(0);
  await expect(aside.getByText('OLD_ASIDE_POISON', { exact: false })).toHaveCount(0);
  await aside.getByRole('button', { name: '关闭 session-1', exact: true }).click();

  await page.evaluate(() => {
    const mock = (
      window as unknown as {
        __consoleMockWorkbenchWebSocket: {
          closeActive: () => void;
          prototype: WebSocket;
        };
      }
    ).__consoleMockWorkbenchWebSocket;
    const originalSend = mock.prototype.send;
    mock.prototype.send = function (data) {
      if (typeof data === 'string' && (JSON.parse(data) as { type?: string }).type === 'resume') {
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'workbench.ready',
                workbenchConnectionId: 'replacement-connection',
                workbenchResumeToken: 'replacement-test-token',
                resumed: false
              })
            })
          )
        );
      } else originalSend.call(this, data);
    };
    mock.closeActive();
  });
  await expect.poll(() => watches.length).toBe(4);
  expect(watches[3]!.workbenchConnectionId).toBe('replacement-connection');
  await snapshot(watches[2]!, 'OLD_RECONNECT_POISON');
  await poison('session-2');
  await snapshot(watches[3]!, 'RECONNECTED_WATCH_INITIAL');
  await expect(page.getByText('RECONNECTED_WATCH_INITIAL', { exact: true })).toBeVisible();
  await expect(page.getByText('OLD_RECONNECT_POISON', { exact: false })).toHaveCount(0);
  await expect(page.getByText('BROADCAST_POISON', { exact: false })).toHaveCount(0);

  // Hold the page-level handshake across a real reload, without delaying HTTP reads.
  await page.addInitScript(() => {
    const dispatch = EventTarget.prototype.dispatchEvent;
    let holding = true;
    EventTarget.prototype.dispatchEvent = function (event) {
      if (
        holding &&
        event instanceof MessageEvent &&
        typeof event.data === 'string' &&
        event.data.includes('"type":"workbench.ready"')
      ) {
        Object.assign(window, {
          releaseWorkbenchReady: () => {
            holding = false;
            dispatch.call(this, event);
          }
        });
        return true;
      }
      return dispatch.call(this, event);
    };
  });
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          typeof (window as unknown as { releaseWorkbenchReady?: () => void }).releaseWorkbenchReady
      )
    )
    .toBe('function');
  await settle();
  expect(watches).toHaveLength(4);
  await expect(page.locator('.conversation-reload')).toHaveCount(0);
  await expect(page.locator('.mar-message--error')).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { releaseWorkbenchReady: () => void }).releaseWorkbenchReady()
  );
  await expect.poll(() => watches.length).toBe(5);
  expect(watches[4]!.sessionId).toBe('session-2');
  await snapshot(watches[4]!, 'REFRESHED_WATCH_INITIAL');
  await expect(page.getByText('REFRESHED_WATCH_INITIAL', { exact: true })).toBeVisible();
  await expect(page.locator('.conversation-reload')).toHaveCount(0);
  await expect(page.locator('.mar-message--error')).toHaveCount(0);
});
