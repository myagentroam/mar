import { expect, test } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';
import type { ConversationSegmentPage } from '../../packages/web-core/src/model/workbench.js';

test('Session projection stays Watch-only across target switches, refreshes and fresh reconnects', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
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
  await page.route(/\/api\/agent-sessions\/session-[12]\/watch(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'DELETE') return json(route, { released: true });
    const request = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    if (request.mode === 'initial')
      watches.push({
        ...request,
        sessionId: new URL(route.request().url()).pathname.split('/').at(-2),
        nodeGeneration: 'mock-node-generation'
      });
    await json(route, {
      accepted: true,
      watchId: request.watchId,
      nodeGeneration: 'mock-node-generation',
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
  const snapshot = async (identity: Record<string, unknown>, text: string) => {
    const id = String(identity.sessionId);
    await emit({
      type: 'watch.event',
      event: {
        ...identity,
        type: 'watch.session.snapshot',
        payload: {
          kind: 'session-watch-snapshot',
          sequence: 10,
          session: sessions.find((session) => session.id === id),
          runs: [],
          context: null,
          queue: { version: 1, items: [], paused: false },
          conversation: {
            unit: 'SEGMENT',
            snapshotSequence: 10,
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
            activity: 'MANAGED_ACTIVE'
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
  await snapshot(watches[1]!, 'SECOND_WATCH_INITIAL');
  await expect(page.getByText('SECOND_WATCH_INITIAL', { exact: true })).toBeVisible();
  await expect(page.getByText('OLD_TARGET_POISON', { exact: false })).toHaveCount(0);
  await expect(page.getByText('BROADCAST_POISON', { exact: false })).toHaveCount(0);

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
  await expect.poll(() => watches.length).toBe(3);
  expect(watches[2]!.workbenchConnectionId).toBe('replacement-connection');
  await snapshot(watches[1]!, 'OLD_RECONNECT_POISON');
  await poison('session-2');
  await snapshot(watches[2]!, 'RECONNECTED_WATCH_INITIAL');
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
  expect(watches).toHaveLength(3);
  await expect(page.locator('.conversation-reload')).toHaveCount(0);
  await expect(page.locator('.el-message--error')).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { releaseWorkbenchReady: () => void }).releaseWorkbenchReady()
  );
  await expect.poll(() => watches.length).toBe(4);
  expect(watches[3]!.sessionId).toBe('session-2');
  await snapshot(watches[3]!, 'REFRESHED_WATCH_INITIAL');
  await expect(page.getByText('REFRESHED_WATCH_INITIAL', { exact: true })).toBeVisible();
  await expect(page.locator('.conversation-reload')).toHaveCount(0);
  await expect(page.locator('.el-message--error')).toHaveCount(0);
});
