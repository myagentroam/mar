import { expect, test } from '@playwright/test';
import { fulfillMockSessionWatch, json, mockConsoleApi } from './support/web-console-api.js';

test('subagent controls group by identity and phase with expandable results and no running badges', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  const control = (
    id: string,
    agentId: string | null,
    operation: string,
    status = 'COMPLETED'
  ) => ({
    id,
    sessionId: 'session-1',
    turnId: 'turn',
    runId: null,
    parentItemId: null,
    sourceSequence: null,
    revision: 1,
    startedAt: null,
    completedAt: null,
    processGroup: {
      id: ['later', 'unknown-1', 'unknown-2'].includes(id) ? 'process-2' : 'process-1'
    },
    kind: 'tool_call',
    status,
    payload: {
      namespace: 'mar-agent',
      toolName: `control-${id}`,
      title: 'Review integration',
      inputSummary: `Input ${id}`,
      outputSummary: `Result ${id}`,
      progressLabel: null,
      errorCode: status === 'FAILED' ? 'CONTROL_FAILED' : null,
      truncated: false,
      subagentOperation: operation,
      subagentId: agentId,
      subagentWait: operation === 'STATUS'
    }
  });
  const items = [
    control('start', 'child', 'START', 'IN_PROGRESS'),
    control('other', 'other-child', 'START'),
    control('wait', 'child', 'STATUS', 'FAILED'),
    control('message', 'child', 'MESSAGE'),
    {
      ...control('reply', null, 'START'),
      kind: 'assistant_message',
      status: 'COMPLETED',
      payload: { text: 'Continue with another phase.', format: 'markdown', model: null }
    },
    control('later', 'child', 'STATUS'),
    control('unknown-1', null, 'STATUS'),
    control('unknown-2', null, 'STATUS')
  ];
  await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
    fulfillMockSessionWatch(
      page,
      route,
      { id: 'session-1', workspaceId: 'workspace-1' },
      {
        kind: 'session-watch-snapshot',
        sequence: 1,
        session: {
          id: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'mar-agent',
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
          nextCursor: null,
          segments: [
            {
              id: 'turn:segment:0',
              sessionId: 'session-1',
              turnId: 'turn',
              index: 0,
              runId: null,
              status: 'SUCCEEDED',
              startedAt: null,
              completedAt: null,
              items
            }
          ]
        }
      }
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
  await page.locator('.session-list .session-link').first().click();
  const openProcesses = async () => {
    const headings = page.locator('.conversation-process.is-group .process-heading');
    await expect(headings).toHaveCount(2);
    for (const heading of await headings.all()) {
      if ((await heading.getAttribute('aria-expanded')) === 'false') await heading.click();
    }
  };
  await openProcesses();
  const groups = page.locator('.subagent-group');
  await expect(groups).toHaveCount(5);
  const group = groups.nth(1);
  const heading = group.locator(':scope > details > summary');
  await expect(heading.locator('.conversation-record-preview')).toHaveText('Review integration');
  await expect(heading.locator('.conversation-group-meta')).toHaveText('3 次操作');
  await expect(heading).not.toContainText(/Running|运行中|Completed/);
  await expect(group.locator('.conversation-tool-detail')).toHaveCount(0);
  await heading.click();
  const operations = group.locator('.conversation-tool-detail');
  await expect(operations).toHaveCount(3);
  await expect(group.getByRole('button', { name: '打开会话' })).toHaveCount(0);
  await expect(operations.locator('summary')).toHaveText([
    '启动执行中',
    '等待失败',
    '发送消息已完成'
  ]);
  await operations.nth(1).locator('summary').click();
  await expect(operations.nth(1).getByText('Input wait', { exact: false })).toBeVisible();
  await expect(operations.nth(1).getByText('Result wait', { exact: false })).toBeVisible();
  await heading.click();
  await expect(group.locator('.conversation-tool-detail')).toHaveCount(0);
  await page.reload();
  await openProcesses();
  await expect(groups).toHaveCount(5);
  await expect(groups.nth(1).locator('.conversation-record-preview')).toHaveText(
    'Review integration'
  );
  await expect(groups.nth(1).locator('.conversation-group-meta')).toHaveText('3 次操作');
  await page.evaluate(() => localStorage.setItem('mar.locale.v2', 'en-US'));
  await page.reload();
  await openProcesses();
  await expect(groups.nth(1).locator('.conversation-record-preview')).toHaveText(
    'Review integration'
  );
  await expect(groups.nth(1).locator('.conversation-group-meta')).toHaveText('3 operations');
  await expect(groups.first().locator('.conversation-group-meta')).toHaveText('1 operation');
});

test('shows Agent records without shortcuts and opens the child through the session list', async ({
  page
}) => {
  const capabilities = [
    'history.read',
    'events.live',
    'turn.start',
    'turn.steer',
    'turn.interrupt'
  ];
  await mockConsoleApi(page, 'MANAGED', capabilities, []);
  const child = {
    id: 'session-2',
    customTitle: 'Child session',
    workspaceId: 'workspace-1',
    runner: 'mar-agent',
    externalSessionId: 'native-child',
    activity: 'MANAGED_ACTIVE',
    sessionGroup: 'CHILD',
    control: { level: 'MANAGED', capabilities }
  };
  const childRun = {
    id: 'child-run',
    sessionId: 'session-2',
    workspaceId: 'workspace-1',
    status: 'RUNNING',
    recoveryState: 'ACTIVE'
  };
  const writes: { path: string; body: string }[] = [];
  const item = (id: string, agentId: string, subagentSessionId?: string) => ({
    id,
    sessionId: 'session-1',
    turnId: 'turn',
    runId: null,
    parentItemId: null,
    sourceSequence: null,
    revision: 1,
    startedAt: null,
    completedAt: null,
    processGroup: { id: 'process-1', ...(id === 'mapped' ? { isStart: true } : {}) },
    kind: 'tool_call',
    status: 'COMPLETED',
    payload: {
      namespace: 'mar-agent',
      toolName: 'agent_start',
      title: 'Review',
      inputSummary: null,
      outputSummary: null,
      progressLabel: null,
      errorCode: null,
      truncated: false,
      subagentOperation: 'START',
      subagentId: agentId,
      ...(subagentSessionId ? { subagentSessionId } : {})
    }
  });
  const snapshot = (session: Record<string, unknown>, items: unknown[]) => ({
    kind: 'session-watch-snapshot',
    sequence: 1,
    session,
    runs: [],
    queue: { version: 0, paused: false, items: [] },
    context: null,
    conversation: {
      unit: 'SEGMENT',
      source: 'official',
      readAt: 1,
      latestVisibleAt: 1,
      snapshotSequence: 1,
      nextCursor: null,
      segments: [
        {
          id: 'turn:segment:0',
          sessionId: session.id,
          turnId: 'turn',
          index: 0,
          runId: null,
          status: 'SUCCEEDED',
          startedAt: null,
          completedAt: null,
          items
        }
      ]
    }
  });
  const parent = {
    id: 'session-1',
    customTitle: 'Parent session',
    workspaceId: 'workspace-1',
    runner: 'mar-agent',
    activity: 'IDLE',
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
  };
  await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, (route) =>
    json(route, { sessions: [parent, child], nextCursor: null })
  );
  await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
    fulfillMockSessionWatch(
      page,
      route,
      parent,
      snapshot(parent, [
        item('mapped', 'opaque-agent-id', 'session-2'),
        {
          ...item('unmapped', 'session-2'),
          payload: {
            ...item('unmapped', 'session-2').payload,
            toolName: 'session-2',
            outputSummary: 'session-2'
          }
        },
        item('conflict-1', 'conflicting-agent', 'session-2'),
        item('conflict-2', 'conflicting-agent', 'session-3')
      ])
    )
  );
  await page.route('**/api/agent-sessions/session-2?*', (route) => json(route, { session: child }));
  await page.route('**/api/agent-sessions/session-2/messages', (route) => {
    writes.push({ path: '/messages', body: route.request().postData() ?? '' });
    return json(route, { session: child, run: childRun, delivery: 'STEERED' });
  });
  await page.route('**/api/agent-runs/child-run/interrupt', (route) => {
    writes.push({ path: '/interrupt', body: route.request().postData() ?? '' });
    return json(route, { run: { ...childRun, status: 'CANCELLING' } });
  });
  await page.route('**/api/agent-sessions/session-2/watch*', (route) =>
    fulfillMockSessionWatch(page, route, child, {
      ...snapshot(child, [
        {
          id: 'child-text',
          sessionId: 'session-2',
          turnId: 'turn',
          runId: null,
          parentItemId: null,
          sourceSequence: null,
          revision: 1,
          startedAt: null,
          completedAt: null,
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: { text: 'Mapped child conversation', format: 'markdown', model: null }
        }
      ]),
      runs: [childRun]
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
  await page.locator('.session-list .session-link').filter({ hasText: 'Parent session' }).click();
  const process = page.locator('.conversation-process.is-group .process-heading');
  await expect(process).toHaveCount(1);
  if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
  const groups = page.locator('.subagent-group');
  await expect(groups).toHaveCount(3);
  await groups.nth(1).locator(':scope > details > summary').click();
  await expect(groups.nth(1).getByRole('button', { name: '打开会话' })).toHaveCount(0);
  await groups.nth(2).locator(':scope > details > summary').click();
  await expect(groups.nth(2).getByRole('button', { name: '打开会话' })).toHaveCount(0);
  await groups.nth(0).locator(':scope > details > summary').click();
  await expect(groups.nth(0).getByRole('button', { name: '打开会话' })).toHaveCount(0);
  const connection = (connected: boolean) =>
    page.evaluate((value) => {
      (
        window as unknown as {
          __consoleMockWorkbenchWebSocket: {
            emitNodeConnection(nodeId: string, connected: boolean): void;
          };
        }
      ).__consoleMockWorkbenchWebSocket.emitNodeConnection('node-1', value);
    }, connected);
  await connection(false);
  await expect(page.locator('.workspace-offline-placeholder')).toBeVisible();
  await expect(page.getByRole('button', { name: '打开会话' })).toHaveCount(0);
  await connection(true);
  await expect(page.locator('.workspace-offline-placeholder')).toHaveCount(0);
  await expect(process).toHaveCount(1);
  if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
  const mapped = groups.nth(0);
  const mappedDetails = mapped.locator(':scope > details');
  if ((await mappedDetails.getAttribute('open')) === null)
    await mappedDetails.locator('summary').click();
  await expect(mapped.getByRole('button', { name: '打开会话' })).toHaveCount(0);
  await expect(page.getByText('Mapped child conversation')).toHaveCount(0);
  await page.locator('.session-list .session-link').filter({ hasText: 'Child session' }).click();
  await expect(page.getByText('Mapped child conversation')).toBeVisible();
  const input = page.getByRole('textbox', { name: '输入消息' });
  await input.fill('User intervention in child');
  await input.press('Enter');
  await expect.poll(() => writes.some((write) => write.path === '/messages')).toBe(true);
  expect(writes.find((write) => write.path === '/messages')?.body).toContain(
    'User intervention in child'
  );
  await page.getByRole('button', { name: '停止运行' }).click();
  await expect.poll(() => writes.some((write) => write.path === '/interrupt')).toBe(true);
});
