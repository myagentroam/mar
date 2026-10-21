import { expect, test } from '@playwright/test';
import { fulfillMockSessionWatch, mockConsoleApi } from './support/web-console-api.js';

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
  const groups = page.locator('.subagent-group');
  await expect(groups).toHaveCount(5);
  const group = groups.nth(1);
  const heading = group.locator(':scope > details > summary');
  await expect(heading.locator(':scope > span')).toHaveText(
    'Review integration · 发送消息 · 3 次操作'
  );
  await expect(heading).toContainText('调用失败');
  await expect(heading).not.toContainText(/Running|运行中|Completed/);
  await expect(group.locator('.conversation-tool-detail')).toHaveCount(0);
  await heading.click();
  const operations = group.locator('.conversation-tool-detail');
  await expect(operations).toHaveCount(3);
  await expect(operations.locator('summary')).toHaveText(['启动', '等待调用失败', '发送消息']);
  await operations.nth(1).locator('summary').click();
  await expect(operations.nth(1).locator('p')).toBeVisible();
  await expect(operations.nth(1)).toContainText('Input wait');
  await expect(operations.nth(1)).toContainText('Result wait');
  await heading.click();
  await expect(group.locator('.conversation-tool-detail')).toHaveCount(0);
  await expect(heading).toContainText('调用失败');
  await page.reload();
  await expect(groups).toHaveCount(5);
  await expect(groups.nth(1).locator(':scope > details > summary > span')).toHaveText(
    'Review integration · 发送消息 · 3 次操作'
  );
  await page.evaluate(() => localStorage.setItem('mar.locale.v2', 'en-US'));
  await page.reload();
  await expect(groups.nth(1).locator(':scope > details > summary > span')).toHaveText(
    'Review integration · Send message · 3 operations'
  );
  await expect(groups.first().locator(':scope > details > summary > span')).toHaveText(
    'Review integration · Start · 1 operations'
  );
});
