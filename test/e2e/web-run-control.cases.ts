import { expect, test, type Route } from '@playwright/test';
import {
  emitMockSessionEvent,
  fulfillMockSessionWatch,
  mockConsoleApi,
  json,
  write
} from './support/web-console-api.js';

// Queue, stop, Plan, and question controls

test('Queued messages remain only in the queue until an authoritative Turn is projected', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  let releaseMessageRequest: (() => void) | undefined;
  const messageRequest = new Promise<void>((resolve) => {
    releaseMessageRequest = resolve;
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
    await messageRequest;
    await write(route, writes, {
      session: {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'vscode-thread-1',
        activity: 'MANAGED_ACTIVE',
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
      },
      run: {
        id: 'run-1',
        status: 'RUNNING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'working-message'
      },
      queueItemId: 'queue-item-2',
      delivery: 'QUEUED'
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

  const queuedMessage = '排队不闪退'.repeat(80);
  const input = page.getByRole('textbox', { name: '输入消息' });
  await input.fill(queuedMessage);
  const response = page.waitForResponse((candidate) => candidate.url().includes('/messages'));
  await input.press('Enter');
  await expect(page.getByLabel('待执行工作')).toHaveCount(0);
  releaseMessageRequest?.();
  await response;
  await emitMockSessionEvent(page, 'queue', {
    sessionId: 'session-1',
    queue: {
      version: 1,
      paused: false,
      items: [
        {
          queueItemId: 'queue-item-2',
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'codex',
          clientMessageId: 'queue-message-2',
          sessionTitle: '现有会话',
          content: queuedMessage,
          createdAt: 2
        }
      ]
    }
  });
  await expect(page.getByLabel('待执行工作')).toContainText(queuedMessage);
  await expect(page.getByRole('button', { name: '发送队列' })).toHaveCount(0);
  const queue = page.getByLabel('待执行工作');
  await expect(queue.locator('p')).toHaveAttribute('title', queuedMessage);
  await expect(queue.locator('p')).toHaveCSS('text-overflow', 'ellipsis');
  await expect(queue.locator('li')).toHaveCSS('min-height', '32px');
  expect(
    await queue.locator('p').evaluate((element) => element.scrollWidth > element.clientWidth)
  ).toBe(true);
  expect(
    await queue.locator('ol').evaluate((element) => element.scrollWidth === element.clientWidth)
  ).toBe(true);
  await queue.getByRole('button', { name: '编辑' }).click();
  const actionPosition = await queue.locator('li').evaluate((item) => {
    const button = (name: string) =>
      Array.from(item.querySelectorAll('button')).find(
        (element) => element.textContent?.trim() === name
      );
    const save = button('保存')?.getBoundingClientRect();
    const execute = button('执行')?.getBoundingClientRect();
    return { saveTop: save?.top, executeTop: execute?.top };
  });
  expect(actionPosition.saveTop).toBe(actionPosition.executeTop);
  await expect(
    page.locator('.conversation-message').filter({ hasText: queuedMessage })
  ).toHaveCount(0);
  await expect(
    page.locator('.conversation-message').filter({ hasText: queuedMessage })
  ).toHaveCount(0);
  await page.waitForTimeout(100);
  await expect(
    page.locator('.conversation-message').filter({ hasText: queuedMessage })
  ).toHaveCount(0);
  expect(writes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining('/messages'),
        body: expect.stringContaining('"deliveryIntent":"QUEUE"')
      })
    ])
  );
});

test('Late stop-and-send responses do not create ghost queues after a message is claimed', async ({
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
    ['history.read', 'events.live', 'turn.start', 'turn.queue', 'turn.interrupt'],
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
  await page.route(
    /\/api\/workspaces\/workspace-1\/queue\?nodeId=node-1&sessionId=session-1$/,
    (route) => json(route, { queue: { version: 2, paused: false, items: [] } })
  );
  let releaseReplacementRequest: (() => void) | undefined;
  const replacementRequest = new Promise<void>((resolve) => {
    releaseReplacementRequest = resolve;
  });
  await page.route('**/api/agent-sessions/session-1/messages', (route) =>
    replacementRequest.then(() =>
      write(route, writes, {
        session: {
          id: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'codex',
          activity: 'MANAGED_ACTIVE',
          control: {
            level: 'MANAGED',
            capabilities: [
              'history.read',
              'events.live',
              'turn.start',
              'turn.queue',
              'turn.interrupt'
            ]
          }
        },
        run: {
          id: 'run-1',
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          status: 'RUNNING',
          recoveryState: 'ACTIVE',
          clientMessageId: 'working-message'
        },
        queueItemId: 'replacement-queue-item',
        delivery: 'QUEUED'
      })
    )
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
  await input.fill('停止后立即发送');
  const response = page.waitForResponse((candidate) => candidate.url().endsWith('/messages'));
  await input.press('Control+Enter');
  await expect(
    page.locator('.conversation-message').filter({ hasText: '停止后立即发送' })
  ).toHaveCount(0);
  await expect(page.getByLabel('待执行工作')).toHaveCount(0);
  releaseReplacementRequest?.();
  await response;

  await expect(page.getByLabel('待执行工作')).toHaveCount(0);
  expect(writes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        body: expect.stringContaining('"deliveryIntent":"REPLACE_CURRENT"')
      })
    ])
  );
});

test('Queue edits save on Enter and automatically save before immediate execution', async ({
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
  await page.route('**/api/queue-items/queue-item-execute/execute', (route) =>
    write(route, writes, {
      run: {
        id: 'run-1',
        status: 'RUNNING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'working-message'
      },
      delivery: 'RESTARTING'
    })
  );
  await page.route('**/api/queue-items/queue-item-execute', (route) =>
    write(route, writes, {
      queueItem: {
        queueItemId: 'queue-item-execute',
        content: '已保存'
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

  await emitMockSessionEvent(page, 'queue', {
    sessionId: 'session-1',
    queue: {
      version: 1,
      paused: true,
      items: [
        {
          queueItemId: 'queue-item-execute',
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'codex',
          clientMessageId: 'queued-execute-message',
          sessionTitle: '不应显示',
          content: '立即处理这条消息',
          createdAt: 2
        }
      ]
    }
  });

  await expect(page.getByLabel('待执行工作')).toContainText('立即处理这条消息');
  await expect(page.getByText('已暂停', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送队列' })).toHaveCount(0);
  const queue = page.getByLabel('待执行工作');
  await queue.getByRole('button', { name: '编辑' }).click();
  await queue.locator('.composer-queue-input textarea').fill('回车保存后的内容');
  await queue.locator('.composer-queue-input textarea').press('Enter');
  await expect.poll(() => writes.length).toBe(1);
  await expect(queue.locator('.composer-queue-input textarea')).toHaveCount(0);

  await queue.getByRole('button', { name: '编辑' }).click();
  await queue.locator('.composer-queue-input textarea').fill('快捷键立即执行的内容');
  await queue.locator('.composer-queue-input textarea').press('Control+Enter');
  await expect.poll(() => writes.length).toBe(3);
  await expect(queue.locator('.composer-queue-input textarea')).toHaveCount(0);

  await queue.getByRole('button', { name: '编辑' }).click();
  await queue.locator('.composer-queue-input textarea').fill('按钮立即执行的内容');
  await queue.getByRole('button', { name: '执行', exact: true }).click();
  await expect.poll(() => writes.length).toBe(5);
  await expect(page.getByLabel('待执行工作')).toContainText('立即处理这条消息');
  await emitMockSessionEvent(page, 'queue', {
    sessionId: 'session-1',
    queue: { version: 2, paused: false, items: [] }
  });
  await expect(page.getByLabel('待执行工作')).toHaveCount(0);
  expect(
    writes.map(({ url, body }) => ({ url: new URL(url).pathname, body: JSON.parse(body) }))
  ).toEqual([
    {
      url: '/api/queue-items/queue-item-execute',
      body: {
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        content: '回车保存后的内容'
      }
    },
    {
      url: '/api/queue-items/queue-item-execute',
      body: {
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        content: '快捷键立即执行的内容'
      }
    },
    {
      url: '/api/queue-items/queue-item-execute/execute',
      body: { nodeId: 'node-1', workspaceId: 'workspace-1' }
    },
    {
      url: '/api/queue-items/queue-item-execute',
      body: {
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        content: '按钮立即执行的内容'
      }
    },
    {
      url: '/api/queue-items/queue-item-execute/execute',
      body: { nodeId: 'node-1', workspaceId: 'workspace-1' }
    }
  ]);
});

test('Immediate execution responses preserve the queue until the claimed event arrives', async ({
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
  await page.route('**/api/queue-items/queue-item-race/execute', (route) =>
    write(route, writes, {
      run: {
        id: 'run-1',
        status: 'RUNNING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'working-message'
      },
      delivery: 'RESTARTING'
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

  await emitMockSessionEvent(page, 'queue', {
    sessionId: 'session-1',
    queue: {
      version: 1,
      paused: false,
      items: [
        {
          queueItemId: 'queue-item-race',
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'codex',
          clientMessageId: 'queued-race-message',
          sessionTitle: '不应显示',
          content: '已领取的消息',
          createdAt: 2
        }
      ]
    }
  });

  await expect(page.getByLabel('待执行工作')).toContainText('已领取的消息');
  await page.getByRole('button', { name: '执行', exact: true }).click();
  await expect(page.getByLabel('待执行工作')).toContainText('已领取的消息');
  await emitMockSessionEvent(page, 'queue', {
    sessionId: 'session-1',
    queue: { version: 2, paused: false, items: [] }
  });
  await expect(page.getByLabel('待执行工作')).toHaveCount(0);
});

test('Managed sessions permit insertion before late Run snapshots and stop the current session Lease', async ({
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
    ['history.read', 'events.live', 'turn.steer', 'turn.interrupt'],
    writes,
    'GIT_WORKSPACE',
    true,
    'MANAGED_ACTIVE'
  );
  const session = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    runner: 'codex' as const,
    externalSessionId: 'vscode-thread-1',
    activity: 'MANAGED_ACTIVE' as const,
    control: {
      level: 'MANAGED',
      capabilities: ['history.read', 'events.live', 'turn.steer', 'turn.interrupt']
    },
    runtime: { capabilities: ['history.read', 'events.live', 'turn.queue', 'turn.interrupt'] }
  };
  await page.route('**/api/agent-sessions?nodeId=node-1*', (route) =>
    json(route, { sessions: [session] })
  );
  await page.route('**/api/agent-sessions/session-1?nodeId=node-1', (route) =>
    json(route, { session })
  );
  await page.route('**/api/agent-sessions/session-1/runs?nodeId=node-1', (route) =>
    json(route, { runs: [] })
  );
  await page.route('**/api/agent-sessions/session-1/messages', (route) =>
    write(route, writes, {
      session,
      run: {
        id: 'active-run-from-node',
        status: 'RUNNING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'active-client-message'
      },
      queueItemId: 'queued-after-missing-snapshot',
      delivery: 'QUEUED'
    })
  );
  let releaseInterruptRequest: (() => void) | undefined;
  let interruptRequested = false;
  const interruptRequest = new Promise<void>((resolve) => {
    releaseInterruptRequest = resolve;
  });
  const handleInterrupt = async (route: Route) => {
    interruptRequested = true;
    await interruptRequest;
    await write(route, writes, {
      run: {
        id: 'active-run-from-node',
        status: 'CANCELLING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'active-client-message'
      }
    });
  };
  await page.route(/\/api\/agent-(?:runs|sessions)\/[^/?]+\/interrupt(?:\?.*)?$/, handleInterrupt);

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();

  const composer = page.getByRole('textbox', { name: '输入消息' });
  await expect(composer).toBeEnabled();
  await expect(page.getByRole('button', { name: '停止运行' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送' })).toHaveCount(0);
  await composer.fill('补充约束');
  await expect(page.getByRole('button', { name: '停止运行' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送' })).toBeVisible();
  const messageResponse = page.waitForResponse((candidate) =>
    candidate.url().endsWith('/messages')
  );
  await page.getByRole('button', { name: '发送' }).click();
  await messageResponse;
  await emitMockSessionEvent(page, 'queue', {
    sessionId: 'session-1',
    queue: {
      version: 1,
      paused: false,
      items: [
        {
          queueItemId: 'queued-after-missing-snapshot',
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'codex',
          clientMessageId: 'queued-client-message',
          sessionTitle: '现有会话',
          content: '补充约束',
          createdAt: 2
        }
      ]
    }
  });
  await expect(page.getByLabel('待执行工作')).toContainText('补充约束');
  await expect(page.locator('.conversation-message').filter({ hasText: '补充约束' })).toHaveCount(
    0
  );
  await page.getByRole('button', { name: '停止运行' }).click();
  await expect(page.getByRole('button', { name: '停止运行' })).toBeDisabled();
  await expect.poll(() => interruptRequested).toBe(true);
  releaseInterruptRequest?.();
  await expect(page.getByRole('button', { name: '停止运行' })).toBeDisabled();
});

test('Full-width Plan continuation exits Plan Mode before submitting implementation without speculative projection', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route(/\/api\/runner-profiles\?.*\bnodeId=node-1(?:&|$)/, (route) =>
    json(route, {
      profiles: [
        {
          runner: 'opencode',
          models: [],
          accessOptions: [],
          commands: [],
          capabilities: ['history.read', 'turn.start']
        }
      ]
    })
  );
  const planState = {
    commandId: 'plan',
    active: true,
    label: 'Plan Mode',
    detail: '后续消息将以协作规划模式运行。',
    closable: true,
    closeInput: '/plan',
    continuation: { label: '执行', prompt: '请根据上述计划开始实施。' }
  };
  const session = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    runner: 'opencode' as const,
    externalSessionId: 'vscode-thread-1',
    activity: 'IDLE' as const,
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] },
    commandStates: [planState]
  };
  await page.route('**/api/agent-sessions?nodeId=node-1*', (route) =>
    json(route, { sessions: [session] })
  );
  await page.route('**/api/agent-sessions/session-1?nodeId=node-1', (route) =>
    json(route, { session })
  );
  await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
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
        segments: [
          {
            id: 'plan-turn:segment:0',
            turnId: 'plan-turn',
            sessionId: 'session-1',
            runId: null,
            index: 0,
            status: 'SUCCEEDED',
            items: [
              {
                id: 'plan-item',
                kind: 'plan',
                status: 'COMPLETED',
                payload: { explanation: '先检查，再修改。', steps: [] }
              }
            ]
          }
        ],
        nextCursor: null
      }
    })
  );
  await page.route('**/api/agent-sessions/session-1/runs?nodeId=node-1', (route) =>
    json(route, { runs: [] })
  );
  await page.route(/\/api\/agent-sessions\/session-1\/turns\?nodeId=node-1&limit=\d+$/, (route) =>
    json(route, {
      turns: [
        {
          id: 'plan-turn',
          status: 'SUCCEEDED',
          items: [
            {
              id: 'plan-item',
              kind: 'plan',
              status: 'COMPLETED',
              payload: { explanation: '先检查，再修改。', steps: [] }
            }
          ]
        }
      ],
      nextCursor: null
    })
  );
  await page.route('**/api/agent-sessions/session-1/commands', (route) =>
    write(route, writes, { session: { ...session, commandStates: [] } })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();

  const actions = page.locator('.conversation-card-actions');
  await expect(actions).toHaveCount(1);
  const implementButton = actions.getByRole('button', { name: '执行' });
  await expect(implementButton).toHaveJSProperty(
    'offsetWidth',
    await actions.evaluate((element) => element.clientWidth)
  );
  await expect(implementButton).toBeEnabled();
  const composer = page.getByRole('textbox', { name: '输入消息' });
  await expect(actions.getByRole('button', { name: '取消' })).toHaveCount(0);
  const closePlanRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      request.url().endsWith('/api/agent-sessions/session-1/commands')
  );
  const implementationRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      request.url().endsWith('/api/agent-sessions/session-1/messages')
  );
  await implementButton.evaluate((element) => (element as HTMLButtonElement).click());
  const [closePlan, implementation] = await Promise.all([closePlanRequest, implementationRequest]);
  await expect(composer).toHaveValue('');
  await expect(
    page.locator('.conversation-message').filter({ hasText: '请执行上述计划。' })
  ).toHaveCount(0);
  expect(closePlan.postDataJSON()).toMatchObject({ commandId: 'plan', input: '/plan' });
  expect(implementation.postDataJSON()).toMatchObject({ content: '请执行上述计划。' });
  expect(writes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining('/commands'),
        body: expect.stringMatching(/"commandId":"plan".*"input":"\/plan"/)
      }),
      expect.objectContaining({
        url: expect.stringContaining('/messages'),
        body: expect.stringMatching(/"content":"请执行上述计划。"/)
      })
    ])
  );
});

test('Official and realtime questions with the same requestId share one card and submission state', async ({
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
  const request = {
    kind: 'user_input_request',
    status: 'PENDING',
    payload: {
      requestId: 'same-request',
      questions: [
        {
          id: 'scope',
          prompt: '本次 DDNS 要优先怎么调整？',
          input: 'MULTI_SELECT',
          options: [
            { value: 'ipv6', label: '修复 IPv6（推荐）', description: null },
            { value: 'dns', label: '调整 DNS', description: null }
          ],
          allowOther: false
        }
      ]
    }
  };
  const session = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    runner: 'codex' as const,
    externalSessionId: 'vscode-thread-1',
    activity: 'MANAGED_ACTIVE' as const,
    control: {
      level: 'MANAGED',
      capabilities: ['history.read', 'events.live', 'turn.start', 'turn.steer', 'turn.interrupt']
    }
  };
  await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
    fulfillMockSessionWatch(page, route, session, {
      kind: 'session-watch-snapshot',
      sequence: 10,
      session,
      runs: [
        {
          id: 'run-1',
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          status: 'RUNNING',
          recoveryState: 'ACTIVE',
          clientMessageId: 'message-1'
        }
      ],
      queue: { version: 0, paused: false, items: [] },
      context: null,
      conversation: {
        unit: 'SEGMENT',
        source: 'official',
        segments: [
          {
            id: 'official-turn:segment:0',
            turnId: 'official-turn',
            sessionId: 'session-1',
            runId: 'run-1',
            index: 0,
            status: 'RUNNING',
            items: [{ id: 'official-input', ...request }]
          }
        ],
        nextCursor: null
      }
    })
  );
  await page.route(/\/api\/agent-sessions\/session-1\/turns\?nodeId=node-1&limit=\d+$/, (route) =>
    json(route, {
      turns: [
        {
          id: 'official-turn',
          runId: 'run-1',
          status: 'RUNNING',
          items: [{ id: 'official-input', ...request }]
        },
        {
          id: 'runtime-turn',
          status: 'RUNNING',
          items: [{ id: 'runtime-input', ...request }]
        }
      ],
      nextCursor: null
    })
  );
  let releaseAnswer: (() => void) | undefined;
  const answerPending = new Promise<void>((resolve) => (releaseAnswer = resolve));
  await page.route('**/api/agent-runs/run-1/user-input/same-request', async (route) => {
    await answerPending;
    await json(route, {});
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();

  await expect(page.locator('.user-input-card')).toHaveCount(1);
  await expect(page.getByText('本次 DDNS 要优先怎么调整？')).toHaveCount(1);
  const checkbox = page.getByRole('checkbox', { name: '修复 IPv6（推荐）' });
  await page.getByText('修复 IPv6（推荐）', { exact: true }).click();
  await expect(checkbox).toBeChecked();
  const answerResponse = page.waitForResponse((response) =>
    response.url().includes('/user-input/same-request')
  );
  await page.getByRole('button', { name: '提交回答' }).click();
  await expect(page.locator('.composer-working')).toContainText('发送中...');
  await expect(page.getByRole('button', { name: '提交回答' })).toBeDisabled();
  releaseAnswer?.();
  await answerResponse;
});

for (const entry of ['message', 'command'] as const) {
  for (const order of ['watch-first', 'http-first'] as const) {
    test(`HTTP Turns are not projected twice ${entry} ${order}`, async ({ page }) => {
      const capabilities = [
        'history.read',
        'events.live',
        'turn.start',
        'turn.steer',
        'turn.interrupt'
      ];
      const writes: { url: string; csrf: string | undefined; body: string }[] = [];
      await mockConsoleApi(page, 'MANAGED', capabilities, writes);
      const session = {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'vscode-thread-1',
        activity: 'MANAGED_ACTIVE',
        control: { level: 'MANAGED', capabilities }
      };
      const run = {
        id: 'run-1',
        sessionId: session.id,
        workspaceId: session.workspaceId,
        status: 'RUNNING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'single-input'
      };
      const text = `Single authoritative input ${entry} ${order}`;
      const turn = {
        id: 'runtime-turn-single',
        sessionId: session.id,
        runId: run.id,
        status: 'RUNNING',
        startedAt: 1,
        completedAt: null,
        items: [
          {
            id: 'user-single',
            kind: 'user_message',
            status: 'COMPLETED',
            payload: { text, clientMessageId: 'single-input' }
          }
        ]
      };
      const segment = { ...turn, id: `${turn.id}:segment:0`, turnId: turn.id, index: 0 };
      let visible = false;
      let watches = 0;
      await page.route('**/api/agent-sessions/session-1/watch*', (route) => {
        watches++;
        return fulfillMockSessionWatch(page, route, session, {
          kind: 'session-watch-snapshot',
          sequence: 10,
          session,
          runs: [run],
          queue: { version: 0, paused: false, items: [] },
          context: null,
          conversation: {
            unit: 'SEGMENT',
            source: 'runtime',
            segments: visible ? [segment] : [],
            nextCursor: null
          }
        });
      });
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const endpoint = entry === 'message' ? '/messages' : '/commands';
      await page.route(`**/api/agent-sessions/session-1${endpoint}`, async (route) => {
        await pending;
        await json(route, { session, run, turn });
      });
      await page.goto('/console');
      await page.getByRole('button', { name: '进入控制台' }).click();
      await page.getByRole('button', { name: '工作', exact: true }).click();
      await page
        .locator('.workspace-tree')
        .getByRole('button', { name: /node-1/ })
        .click();
      await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
      await page.locator('.session-list .session-link').first().click();
      await expect.poll(() => watches).toBeGreaterThan(0);
      const input = page.getByRole('textbox', { name: '输入消息' });
      await input.fill(entry === 'message' ? text : '/compact');
      const requested = page.waitForRequest((request) => request.url().endsWith(endpoint));
      await input.press('Enter');
      await requested;
      const bubble = page.locator('.conversation-message').filter({ hasText: text });
      const publish = async () => {
        visible = true;
        await emitMockSessionEvent(page, 'conversation', {
          sessionId: session.id,
          turn,
          segments: [segment]
        });
        await expect(bubble).toHaveCount(1);
      };
      if (order === 'watch-first') await publish();
      const responded = page.waitForResponse((response) => response.url().endsWith(endpoint));
      const previousWatches = watches;
      release();
      await responded;
      if (entry === 'message') expect(watches).toBe(previousWatches);
      await expect(input).toHaveValue('');
      if (order === 'http-first') {
        await expect(bubble).toHaveCount(0);
        await publish();
      }
      await expect(bubble).toHaveCount(1);
      const reply = {
        id: 'assistant-single',
        kind: 'assistant_message',
        status: 'RUNNING',
        payload: { text: 'Still streaming' }
      };
      await emitMockSessionEvent(page, 'conversation', {
        sessionId: session.id,
        turn: { ...turn, items: [...turn.items, reply] },
        segments: [{ ...segment, items: [...turn.items, reply] }]
      });
      await expect(page.locator('.conversation-item.assistant_message')).toContainText(
        'Still streaming'
      );
      await expect(bubble).toHaveCount(1);
    });
  }
}
