import { expect, test } from '@playwright/test';
import {
  emitMockSessionEvent,
  fulfillMockSessionWatch,
  installSessionIdleSocket,
  mockConsoleApi,
  json,
  write
} from './support/web-console-api.js';
// Optimistic Run state and late responses
test('Idle transitions preserve input and late responses cannot switch back to the previous session', async ({
  page
}) => {
  await installSessionIdleSocket(page);
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  let releaseMessage: (() => void) | undefined;
  const messagePending = new Promise<void>((resolve) => {
    releaseMessage = resolve;
  });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'events.live', 'turn.start'], writes);
  const sessions = [
    {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex' as const,
      runnerTitle: '第一会话',
      activity: 'IDLE' as const,
      control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
    },
    {
      id: 'session-2',
      workspaceId: 'workspace-1',
      runner: 'codex' as const,
      runnerTitle: '第二会话',
      activity: 'MANAGED_ACTIVE' as const,
      control: {
        level: 'MANAGED',
        capabilities: ['history.read', 'events.live', 'turn.start']
      }
    }
  ];
  const finalTurn = {
    id: 'turn-session-2',
    sessionId: 'session-2',
    runId: 'run-session-2',
    status: 'SUCCEEDED',
    completedAt: 20,
    items: [
      {
        id: 'assistant-session-2',
        kind: 'assistant_message',
        status: 'COMPLETED',
        payload: { text: '第二会话最终回答' }
      }
    ]
  };
  await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, (route) =>
    json(route, { sessions, nextCursor: null })
  );
  for (const session of sessions) {
    await page.route(`**/api/agent-sessions/${session.id}?nodeId=node-1`, (route) =>
      json(route, { session })
    );
    await page.route(`**/api/agent-sessions/${session.id}/runs?nodeId=node-1`, (route) =>
      json(route, { runs: [] })
    );
    await page.route(
      new RegExp(`/api/agent-sessions/${session.id}/turns\\?nodeId=node-1&limit=\\d+$`),
      (route) =>
        json(route, { turns: session.id === 'session-2' ? [finalTurn] : [], nextCursor: null })
    );
    await page.route(`**/api/agent-sessions/${session.id}/context?nodeId=node-1`, (route) =>
      json(route, { context: null })
    );
    await page.route(
      `**/api/workspaces/workspace-1/queue?nodeId=node-1&sessionId=${session.id}`,
      (route) => json(route, { queue: { version: 0, paused: false, items: [] } })
    );
  }
  await page.route('**/api/agent-sessions/session-2/watch', (route) =>
    fulfillMockSessionWatch(page, route, sessions[1]!, {
      kind: 'session-watch-snapshot',
      sequence: 1,
      session: { ...sessions[1], activity: 'IDLE' },
      runs: [],
      queue: { version: 0, paused: false, items: [] },
      context: null,
      conversation: {
        unit: 'SEGMENT',
        source: 'official',
        latestVisibleAt: 20,
        segments: [
          {
            ...structuredClone(finalTurn),
            id: `${finalTurn.id}:segment:0`,
            turnId: finalTurn.id,
            index: 0
          }
        ],
        nextCursor: null,
        snapshotSequence: 1
      }
    })
  );
  await page.route('**/api/agent-sessions/session-1/messages', async (route) => {
    await messagePending;
    return write(route, writes, {
      session: { ...sessions[0], activity: 'MANAGED_ACTIVE' },
      run: {
        id: 'run-session-1',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        status: 'STARTING',
        recoveryState: 'ACTIVE'
      },
      delivery: 'STARTED'
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
  await page.locator('.session-link').filter({ hasText: '第一会话' }).click();
  const input = page.getByRole('textbox', { name: '输入消息' });
  await input.fill('发往第一会话');
  await input.press('Enter');
  await page.locator('.session-link').filter({ hasText: '第二会话' }).click();
  await expect(page.getByText('第二会话最终回答', { exact: true })).toBeVisible();
  await input.fill('第二会话未发送草稿');
  await page.evaluate(() =>
    (
      window as unknown as { __runIdleSocket: { emitRunActive(): void } }
    ).__runIdleSocket.emitRunActive()
  );
  await expect(page.locator('.composer-working')).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as { __runIdleSocket: { emitSessionIdle(): void } }
    ).__runIdleSocket.emitSessionIdle()
  );
  await expect(input).toHaveValue('第二会话未发送草稿');
  await expect(page.locator('.composer-working')).toHaveCount(0);
  releaseMessage?.();
  await expect(page.getByRole('heading', { name: '第二会话', exact: true })).toBeVisible();
  await expect(input).toHaveValue('第二会话未发送草稿');
  await expect(page.getByText('第二会话最终回答', { exact: true })).toHaveCount(1);
});

test('Composer send and stop share submission state without speculative business-state projection', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  let releaseMessageRequest: (() => void) | undefined;
  let releaseStopRequest: (() => void) | undefined;
  const messageRequest = new Promise<void>((resolve) => {
    releaseMessageRequest = resolve;
  });
  const stopRequest = new Promise<void>((resolve) => {
    releaseStopRequest = resolve;
  });
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'events.live', 'turn.start', 'turn.steer', 'turn.interrupt'],
    writes
  );
  await page.route('**/api/agent-sessions/session-1/runs?nodeId=node-1', (route) =>
    json(route, {
      runs: [
        {
          id: 'run-1',
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          status: 'RUNNING',
          recoveryState: 'ACTIVE',
          clientMessageId: 'working-message'
        }
      ]
    })
  );
  await page.route('**/api/agent-sessions/session-1/messages', async (route) => {
    writes.push({
      url: route.request().url(),
      csrf: route.request().headers()['x-csrf-token'],
      body: route.request().postData() ?? ''
    });
    await messageRequest;
    await json(route, { error: { code: 'NODE_REJECTED' } }, 409);
  });
  await page.route('**/api/agent-runs/run-1/interrupt', async (route) => {
    writes.push({
      url: route.request().url(),
      csrf: route.request().headers()['x-csrf-token'],
      body: route.request().postData() ?? ''
    });
    await stopRequest;
    await json(route, { error: { code: 'NODE_REJECTED' } }, 409);
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: 'project', exact: true })
    .click();
  await page.locator('.session-list button').first().click();

  const input = page.getByRole('textbox', { name: '输入消息' });
  await input.fill('无需等待回显');
  await input.press('Enter');
  await expect(input).toHaveValue('无需等待回显');
  await expect(page.getByLabel('待执行工作').getByText('无需等待回显')).toHaveCount(0);
  await expect(page.locator('.composer-working')).toContainText('发送中...');
  releaseMessageRequest?.();
  await expect(input).toHaveValue('无需等待回显');
  await expect(page.getByLabel('待执行工作').getByText('无需等待回显')).toHaveCount(0);

  await expect(page.locator('.composer-working')).toBeVisible();
  await page.getByRole('button', { name: '停止运行' }).click();
  await expect(page.locator('.composer-working')).toContainText('发送中...');
  await expect(page.getByRole('button', { name: '停止运行' })).toBeDisabled();
  releaseStopRequest?.();
  await expect(page.locator('.composer-working')).toBeVisible();
  await expect(page.getByRole('button', { name: '停止运行' })).toBeEnabled();
  expect(writes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ url: expect.stringContaining('/messages') }),
      expect.objectContaining({ url: expect.stringContaining('/interrupt') })
    ])
  );
});

test('Stopping an ended Run waits for Watch convergence instead of inferring final state from errors', async ({
  page
}) => {
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
  await page.route('**/api/agent-runs/run-1/interrupt', (route) =>
    json(route, { error: { code: 'RUN_NOT_FOUND' } }, 404)
  );
  await page.route('**/api/agent-sessions/session-1?nodeId=node-1', (route) =>
    json(route, {
      session: {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'vscode-thread-1',
        activity: 'IDLE',
        control: {
          level: 'MANAGED',
          capabilities: [
            'history.read',
            'events.live',
            'turn.start',
            'turn.steer',
            'turn.interrupt'
          ]
        }
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
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: 'project', exact: true })
    .click();
  await page.locator('.session-list button').first().click();

  await expect(page.locator('.composer-working')).toBeVisible();
  await page.getByRole('button', { name: '停止运行' }).click();
  await expect(page.locator('.composer-working')).toBeVisible();
  await emitMockSessionEvent(page, 'run', {
    run: {
      id: 'run-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      status: 'SUCCEEDED',
      recoveryState: 'ACTIVE',
      version: 2,
      clientMessageId: 'working-message',
      createdAt: 1,
      startedAt: 1,
      completedAt: 2,
      updatedAt: 2
    }
  });
  await emitMockSessionEvent(page, 'session', {
    session: {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex',
      activity: 'IDLE',
      control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
    }
  });
  await expect(page.locator('.composer-working')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '停止运行' })).toHaveCount(0);
  await expect(page.getByText(/运行操作被拒绝：RUN_NOT_FOUND/)).toHaveCount(0);
});

test('An initial terminal Watch snapshot does not restore a completed Run', async ({ page }) => {
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
  const idleSession = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    runner: 'codex',
    externalSessionId: 'vscode-thread-1',
    activity: 'IDLE',
    control: {
      level: 'MANAGED',
      capabilities: ['history.read', 'turn.start']
    }
  };
  await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
    fulfillMockSessionWatch(page, route, idleSession, {
      kind: 'session-watch-snapshot',
      sequence: 10,
      session: idleSession,
      runs: [],
      queue: { version: 0, paused: false, items: [] },
      context: null,
      conversation: { unit: 'SEGMENT', segments: [], nextCursor: null, source: 'runtime' }
    })
  );
  await page.route('**/api/agent-sessions/session-1?nodeId=node-1', (route) =>
    json(route, {
      session: idleSession
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: 'project', exact: true })
    .click();
  await page.locator('.session-list button').first().click();

  await expect(page.locator('.composer-working')).toHaveCount(0);
});

test('Earlier first-message responses cannot overwrite pushed running state', async ({ page }) => {
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
  let releaseMessageResponse: (() => void) | undefined;
  const messageResponsePending = new Promise<void>((resolve) => {
    releaseMessageResponse = resolve;
  });
  await page.route('**/api/agent-sessions/session-1/messages', async (route) => {
    await messageResponsePending;
    await write(route, writes, {
      session: {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'vscode-thread-1',
        activity: 'IDLE',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
      },
      run: {
        id: 'run-response-race',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        status: 'STARTING',
        recoveryState: 'ACTIVE',
        version: 0,
        clientMessageId: 'response-race'
      },
      delivery: 'STARTED'
    });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: 'project', exact: true })
    .click();
  await page.locator('.session-list button').first().click();
  const input = page.getByRole('textbox', { name: '输入消息' });
  await input.fill('首条消息不能丢失 Working');
  await input.press('Enter');

  const liveTurn = {
    id: 'turn-response-race',
    sessionId: 'session-1',
    runId: 'run-response-race',
    status: 'RUNNING',
    items: [
      {
        id: 'user-response-race',
        kind: 'user_message',
        status: 'COMPLETED',
        payload: {
          clientMessageId: null,
          text: '首条消息不能丢失 Working',
          contexts: [],
          delivery: 'ACCEPTED'
        }
      }
    ]
  };
  await emitMockSessionEvent(page, 'conversation', {
    sessionId: 'session-1',
    turn: liveTurn,
    segments: [
      {
        ...liveTurn,
        id: 'turn-response-race:segment:0',
        turnId: liveTurn.id,
        index: 0
      }
    ]
  });
  await emitMockSessionEvent(page, 'run', {
    run: {
      id: 'run-response-race',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      status: 'RUNNING',
      recoveryState: 'ACTIVE',
      version: 2,
      clientMessageId: 'response-race'
    }
  });
  releaseMessageResponse?.();

  await expect(page.locator('.composer-working')).toBeVisible();
  await expect(page.getByText('首条消息不能丢失 Working', { exact: true })).toHaveCount(1);
});

test('Reselecting the active session neither recreates Watch nor overwrites running state', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  let watchInitialCount = 0;
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'turn.start'],
    writes,
    'GIT_WORKSPACE',
    true,
    'IDLE'
  );
  const activeSession = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    runner: 'codex',
    externalSessionId: 'vscode-thread-1',
    activity: 'MANAGED_ACTIVE',
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start', 'turn.steer'] }
  };
  await page.route('**/api/agent-sessions/session-1/watch*', (route) => {
    watchInitialCount += 1;
    return fulfillMockSessionWatch(page, route, activeSession, {
      kind: 'session-watch-snapshot',
      sequence: 10,
      session: activeSession,
      runs: [
        {
          id: 'run-initial-read-race',
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          status: 'RUNNING',
          recoveryState: 'ACTIVE',
          version: 2,
          clientMessageId: 'initial-read-race'
        }
      ],
      queue: { version: 0, paused: false, items: [] },
      context: null,
      conversation: { unit: 'SEGMENT', segments: [], nextCursor: null, source: 'runtime' }
    });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: 'project', exact: true })
    .click();
  await page.locator('.session-list button').first().click();
  await expect(page.locator('.composer-working')).toBeVisible();
  await page.locator('.session-list button').first().click();
  await expect.poll(() => watchInitialCount).toBe(1);
  await expect(page.locator('.composer-working')).toBeVisible();
});

test('Returning to a cached session restores and refreshes its message queue', async ({ page }) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  const sessions = [
    {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex',
      runnerTitle: '队列会话',
      externalSessionId: 'thread-queue-1',
      activity: 'IDLE',
      control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
    },
    {
      id: 'session-2',
      workspaceId: 'workspace-1',
      runner: 'codex',
      runnerTitle: '空会话',
      externalSessionId: 'thread-queue-2',
      activity: 'IDLE',
      control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
    }
  ];
  const queued = {
    version: 1,
    paused: true,
    items: [
      {
        queueItemId: 'queue-item-1',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        clientMessageId: 'queued-message-1',
        sessionTitle: '队列会话',
        content: '切换后仍应可见的队列消息',
        createdAt: 2
      }
    ]
  };
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, (route) =>
    json(route, { sessions, nextCursor: null })
  );
  for (const session of sessions) {
    await page.route(`**/api/agent-sessions/${session.id}?nodeId=node-1`, (route) =>
      json(route, { session })
    );
    await page.route(`**/api/agent-sessions/${session.id}/watch*`, (route) =>
      fulfillMockSessionWatch(page, route, session, {
        kind: 'session-watch-snapshot',
        sequence: 10,
        session,
        runs: [],
        queue: session.id === 'session-1' ? queued : { version: 0, paused: false, items: [] },
        context: null,
        conversation: { unit: 'SEGMENT', segments: [], nextCursor: null, source: 'runtime' }
      })
    );
    await page.route(`**/api/agent-sessions/${session.id}/runs?nodeId=node-1`, (route) =>
      json(route, { runs: [] })
    );
    await page.route(`**/api/agent-sessions/${session.id}/turns?nodeId=node-1&limit=10`, (route) =>
      json(route, { turns: [], nextCursor: null })
    );
    await page.route(`**/api/agent-sessions/${session.id}/context?nodeId=node-1`, (route) =>
      json(route, { context: null })
    );
  }
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: 'project', exact: true })
    .click();
  await page.locator('.session-link').filter({ hasText: '队列会话' }).click();
  await expect(page.getByLabel('待执行工作').getByText('切换后仍应可见的队列消息')).toBeVisible();

  await page.locator('.session-link').filter({ hasText: '空会话' }).click();
  await expect(page.getByRole('heading', { name: '空会话', exact: true })).toBeVisible();
  await page.locator('.session-link').filter({ hasText: '队列会话' }).click();
  await expect(page.getByLabel('待执行工作').getByText('切换后仍应可见的队列消息')).toBeVisible();
});

test('Successful queue pause waits for queue events without recreating Session Watch', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  const session = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    runner: 'codex' as const,
    externalSessionId: 'vscode-thread-1',
    activity: 'MANAGED_ACTIVE' as const,
    control: {
      level: 'MANAGED',
      capabilities: ['history.read', 'events.live', 'turn.start', 'turn.queue']
    }
  };
  let initialWatchRequests = 0;
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'events.live', 'turn.start', 'turn.queue'],
    writes
  );
  await page.route('**/api/agent-sessions/session-1/watch*', async (route) => {
    if (route.request().method() !== 'POST') return json(route, { stopped: true });
    const request = JSON.parse(route.request().postData() ?? '{}') as { mode?: string };
    if (request.mode === 'initial') initialWatchRequests += 1;
    return fulfillMockSessionWatch(page, route, session, {
      kind: 'session-watch-snapshot',
      sequence: 1,
      session,
      runs: [
        {
          id: 'run-1',
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          status: 'RUNNING',
          recoveryState: 'ACTIVE',
          clientMessageId: 'working-message'
        }
      ],
      queue: {
        version: 1,
        paused: true,
        items: [
          {
            queueItemId: 'queue-item-1',
            sessionId: 'session-1',
            workspaceId: 'workspace-1',
            runner: 'codex',
            clientMessageId: 'queued-message-1',
            content: '暂停前已有消息',
            createdAt: 1
          }
        ]
      },
      context: null,
      conversation: { unit: 'SEGMENT', segments: [], nextCursor: null, source: 'runtime' }
    });
  });
  await page.route('**/api/agent-sessions/session-1/messages', (route) =>
    write(route, writes, {
      session,
      run: {
        id: 'run-1',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        status: 'RUNNING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'working-message'
      },
      queueItemId: 'queue-item-2',
      delivery: 'QUEUED'
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: 'project', exact: true })
    .click();
  await page.locator('.session-list button').first().click();
  const queue = page.getByLabel('待执行工作');
  await expect(queue).toContainText('暂停前已有消息');
  await expect(page.getByText('已暂停', { exact: true })).toBeVisible();

  const input = page.getByRole('textbox', { name: '输入消息' });
  await input.fill('暂停后新增消息');
  await input.press('Enter');

  await expect.poll(() => writes.some((entry) => entry.url.endsWith('/messages'))).toBe(true);
  expect(initialWatchRequests).toBe(1);
  await emitMockSessionEvent(page, 'queue', {
    sessionId: 'session-1',
    queue: {
      version: 2,
      paused: true,
      items: [
        {
          queueItemId: 'queue-item-1',
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'codex',
          clientMessageId: 'queued-message-1',
          content: '暂停前已有消息',
          createdAt: 1
        },
        {
          queueItemId: 'queue-item-2',
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'codex',
          clientMessageId: 'queued-message-2',
          content: '暂停后新增消息',
          createdAt: 2
        }
      ]
    }
  });
  await expect(queue).toContainText('暂停后新增消息');
  expect(writes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining('/messages'),
        body: expect.stringContaining('"deliveryIntent":"QUEUE"')
      })
    ])
  );
});

test('Ordinary sends show only submission state until Node returns STARTED', async ({ page }) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'turn.start'],
    writes,
    'GIT_WORKSPACE',
    true,
    'IDLE'
  );
  await page.route('**/api/agent-sessions/session-1/messages', async (route) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    return write(route, writes, {
      session: {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'vscode-thread-1',
        activity: 'IDLE',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
      },
      run: {
        id: 'run-delayed-start',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        status: 'STARTING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'delayed-start'
      },
      delivery: 'STARTED'
    });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: 'project', exact: true })
    .click();
  await page.locator('.session-list button').first().click();
  const input = page.getByRole('textbox', { name: '输入消息' });
  await input.fill('立即进入 Working');
  await input.press('Enter');

  await expect(page.getByText('立即进入 Working', { exact: true })).toHaveCount(0);
  await expect(input).toHaveValue('立即进入 Working');
  await expect(page.locator('.composer-working')).toContainText('发送中...');
  await expect(input).toHaveValue('');
  await expect(page.getByRole('button', { name: '停止运行' })).toBeVisible();
  await expect.poll(() => writes.some((entry) => entry.url.endsWith('/messages'))).toBe(true);
  await expect(page.locator('.composer-working')).toBeVisible();
  await expect(page.getByRole('button', { name: '停止运行' })).toBeVisible();
});
